import * as k8s from "@kubernetes/client-node";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import type { InstanceRecord } from "./store.js";

/** The game-server image mounts its persistent data at this fixed directory. */
export const POD_ROOT = "/palworld";
const POD_TMP_ROOT = "/tmp/palserver-health";

function badPath(): Error & { statusCode: number } {
  return Object.assign(new Error("路徑不合法"), { statusCode: 400 });
}

/**
 * Resolve a client-supplied path below the Pod root.
 *
 * This is deliberately a pure lexical check. Pod paths are POSIX paths even
 * when the agent itself runs on Windows, and are always passed to exec as
 * argv values rather than interpolated into shell source.
 */
export function resolvePodPath(relPath: string): string {
  if (relPath.includes("\0") || relPath.includes("\\")) throw badPath();
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) throw badPath();

  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "..")) throw badPath();

  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return normalized ? `${POD_ROOT}/${normalized}` : POD_ROOT;
}

/** Return the normalized relative form used by callers that need it. */
export function normalizePodPath(relPath: string): string {
  const fullPath = resolvePodPath(relPath);
  return fullPath === POD_ROOT ? "" : fullPath.slice(POD_ROOT.length + 1);
}

/**
 * Load a kubeconfig with the same precedence as the k8s driver:
 * explicit file, in-cluster config, then the user's default config.
 */
export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const kubeconfigPath = process.env.PALSERVER_KUBECONFIG;
  if (kubeconfigPath) {
    if (!fs.existsSync(kubeconfigPath)) {
      throw Object.assign(new Error(`找不到指定 kubeconfig：${kubeconfigPath}`), { statusCode: 409 });
    }
    kc.loadFromFile(kubeconfigPath);
    return kc;
  }
  // loadFromCluster() can populate an invalid in-cluster context on a
  // desktop where the service variables are absent, so only try it when the
  // Kubernetes runtime explicitly provided its service endpoint.
  if (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) {
    kc.loadFromCluster();
    return kc;
  }
  kc.loadFromDefault();
  return kc;
}

/** Find the newest non-terminating Running Pod backing a StatefulSet. */
export async function findPodName(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  statefulSet: string,
): Promise<string | null> {
  const pods = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `app=${statefulSet}`,
  });
  const running = pods.items
    .filter((pod) => pod.status?.phase === "Running" && !pod.metadata?.deletionTimestamp)
    .sort((a, b) => {
      const timestamp = (value: Date | string | undefined): number =>
        value instanceof Date ? value.getTime() : Date.parse(value ?? "") || 0;
      const aTime = timestamp(a.metadata?.creationTimestamp);
      const bTime = timestamp(b.metadata?.creationTimestamp);
      return bTime - aTime;
    });
  return running[0]?.metadata?.name ?? null;
}

function safeTempName(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw badPath();
  return value;
}

function resolveHealthTempPath(dirName: string, fileName = ""): string {
  const dir = safeTempName(dirName);
  const file = fileName ? safeTempName(fileName) : "";
  return file ? `${POD_TMP_ROOT}/${dir}/${file}` : `${POD_TMP_ROOT}/${dir}`;
}

type PodTarget = {
  kc: k8s.KubeConfig;
  namespace: string;
  podName: string;
  containerName: string;
};

async function podOf(rec: InstanceRecord): Promise<PodTarget> {
  const kc = loadKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const namespace = rec.k8sNamespace!;
  const statefulSet = rec.k8sStatefulSet!;
  const podName = await findPodName(coreApi, namespace, statefulSet);
  if (!podName) throw new Error("找不到運行中的 game-server Pod");

  const statefulSetApi = kc.makeApiClient(k8s.AppsV1Api);
  const sts = await statefulSetApi.readNamespacedStatefulSet({
    name: statefulSet,
    namespace,
  });
  const containerName = sts.spec?.template?.spec?.containers?.[0]?.name ?? "";
  return { kc, namespace, podName, containerName };
}

/** Execute an argv command and collect raw stdout without text decoding. */
async function execBuffer(rec: InstanceRecord, command: string[], input?: Uint8Array): Promise<Buffer> {
  const { kc, namespace, podName, containerName } = await podOf(rec);
  const exec = new k8s.Exec(kc);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const stdin = input === undefined ? null : new PassThrough();
  const result = new Promise<void>((resolve, reject) => {
    try {
      const request = exec.exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        stderr,
        stdin,
        false,
        (status) => {
          const error = Buffer.concat(stderrChunks).toString("utf8");
          // TD-2(004 反方限縮版):只在 status 物件存在且明確 Failure 才以此為由 reject。
          // stderr 非空但 status=Success 時不再 reject(tar 等 warning 不該誤判失敗)。
          // 但 status 為 null/undefined(串流中斷、Pod 無工具等異常)時仍走原保守後備
          // (|| error),避免 silent return 空 buffer 的回歸風險。
          const statusFailure = status?.status === "Failure";
          const statusUnknown = !status || status.status === undefined;
          if (statusFailure || (statusUnknown && error)) {
            let statusText = "unknown";
            try {
              statusText = JSON.stringify(status);
            } catch {
              // Keep the original failure even if the Kubernetes status is unusual.
            }
            reject(new Error(
              error ||
                `exec failed: status=${statusText}; pod=${podName}; container=${containerName}; command=${command.join(" ")}`,
            ));
          } else {
            resolve();
          }
        },
      );
      request.catch(reject);
      if (stdin) stdin.end(Buffer.from(input ?? new Uint8Array()));
    } catch (error) {
      reject(error);
    }
  });

  await result;
  return Buffer.concat(stdoutChunks);
}

/** Run a command inside the game-server Pod and decode stdout as UTF-8. */
export async function execInPod(rec: InstanceRecord, command: string[]): Promise<string> {
  return (await execBuffer(rec, command)).toString("utf8");
}

/** Run a command inside the game-server Pod and preserve stdout bytes. */
export async function execInPodBuffer(rec: InstanceRecord, command: string[]): Promise<Buffer> {
  return execBuffer(rec, command);
}

/** Read a text file below /palworld. */
export async function readFileInPod(rec: InstanceRecord, relPath: string): Promise<string> {
  return execInPod(rec, ["cat", resolvePodPath(relPath)]);
}

/** Download a file below /palworld without corrupting binary bytes. */
export async function downloadFileInPod(rec: InstanceRecord, relPath: string): Promise<Buffer> {
  return execInPodBuffer(rec, ["cat", resolvePodPath(relPath)]);
}

/** Write text or bytes through stdin; the user path is only a positional argv. */
export async function writeFileBytesInPod(
  rec: InstanceRecord,
  relPath: string,
  content: Uint8Array,
): Promise<void> {
  const fullPath = resolvePodPath(relPath);
  await execBuffer(
    rec,
    ["sh", "-c", 'cat > "$1"', "palserver-write", fullPath],
    content,
  );
}

/** Write a UTF-8 text file below /palworld. */
export async function writeFileInPod(rec: InstanceRecord, relPath: string, content: string): Promise<void> {
  await writeFileBytesInPod(rec, relPath, Buffer.from(content, "utf8"));
}

/** List one entry per line below /palworld. */
export async function listDirInPod(rec: InstanceRecord, relPath: string): Promise<string> {
  return execInPod(rec, ["ls", "-1", resolvePodPath(relPath)]);
}

/** Create a directory below /palworld, including missing parents. */
export async function makeDirInPod(rec: InstanceRecord, relPath: string): Promise<void> {
  await execInPod(rec, ["mkdir", "-p", resolvePodPath(relPath)]);
}

/** Delete a file or directory below /palworld; the root itself is protected. */
export async function deletePathInPod(rec: InstanceRecord, relPath: string): Promise<void> {
  const fullPath = resolvePodPath(relPath);
  if (fullPath === POD_ROOT) throw badPath();
  await execInPod(rec, ["rm", "-rf", fullPath]);
}

/** Upload raw bytes to a file below /palworld through exec stdin. */
export async function uploadFileInPod(
  rec: InstanceRecord,
  relPath: string,
  content: Uint8Array,
): Promise<void> {
  await writeFileBytesInPod(rec, relPath, content);
}

/** Pack a directory below /palworld into a tar.gz byte stream. */
export async function tarDirInPod(rec: InstanceRecord, relPath: string, excludes: string[] = []): Promise<Buffer> {
  const fullPath = resolvePodPath(relPath);
  return execInPodBuffer(rec, [
    "tar",
    "czf",
    "-",
    "-C",
    fullPath,
    ...excludes.flatMap((entry) => ["--exclude", entry]),
    ".",
  ]);
}

/** Extract a tar.gz byte stream into a directory below /palworld. */
export async function untarIntoPod(rec: InstanceRecord, relPath: string, archive: Uint8Array): Promise<void> {
  const fullPath = resolvePodPath(relPath);
  await makeDirInPod(rec, relPath);
  await execBuffer(rec, ["tar", "xzf", "-", "-C", fullPath], archive);
}

/** Temporary workspace for tools that must execute inside the game Pod. */
export async function makeHealthTempDirInPod(rec: InstanceRecord, dirName: string): Promise<void> {
  await execInPod(rec, ["mkdir", "-p", resolveHealthTempPath(dirName)]);
}

/** Upload a file into the protected health-check temporary workspace. */
export async function writeHealthTempFileInPod(
  rec: InstanceRecord,
  dirName: string,
  fileName: string,
  content: Uint8Array,
): Promise<void> {
  const fullPath = resolveHealthTempPath(dirName, fileName);
  await execBuffer(rec, ["sh", "-c", 'cat > "$1"', "palserver-health-write", fullPath], content);
}

/** Read a file from the protected health-check temporary workspace. */
export async function readHealthTempFileInPod(
  rec: InstanceRecord,
  dirName: string,
  fileName: string,
): Promise<Buffer> {
  return execInPodBuffer(rec, ["cat", resolveHealthTempPath(dirName, fileName)]);
}

/** Remove a health-check temporary workspace. */
export async function deleteHealthTempDirInPod(rec: InstanceRecord, dirName: string): Promise<void> {
  await execInPod(rec, ["rm", "-rf", resolveHealthTempPath(dirName)]);
}
