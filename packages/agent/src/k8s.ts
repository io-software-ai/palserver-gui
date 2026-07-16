import * as k8s from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { InstanceStats, InstanceStatus, LogSource, LogSourceId } from "@palserver/shared";
import type { ServerDriver, DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { execInPod, findPodName, loadKubeConfig, readFileInPod, writeFileInPod } from "./k8s-files.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";

/**
 * k8s backend driver.
 *
 * Drives a PalServer running as a StatefulSet (e.g. the thijsvanloef/palworld-server image)
 * via @kubernetes/client-node. The agent may run either in-cluster (a Pod with a service
 * account) or out-of-cluster (~/.kube/config, or an explicit kubeconfig path for SSH-tunnel
 * scenarios). Lifecycle is expressed as StatefulSet replica scaling: start = scale to 1,
 * stop = scale to 0. We never delete the StatefulSet — that preserves the PVC (saves).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function strategicMergeMiddleware(): any {
  // Strategic-merge-patch content-type is required for scale subresource patches
  // so the API server merges `spec.replicas` instead of replacing the whole scale
  // object. Ported from PalworldManager k8s-controller.ts.
  //
  // @kubernetes/client-node 1.x 的 ObservableAPI pipe 鏈透過 rxjsStub.mergeMap
  // 呼叫 callback(value).toPromise()。httpApi.send() 回傳 Observable（有 toPromise），
  // 但 middleware 的 pre/post 如果回傳裸 Promise 就會 TypeError。用 of() 包一層
  // Observable-like（帶 toPromise 方法）即可相容。
  const of = (value: unknown) => ({ toPromise: () => Promise.resolve(value) });
  return {
    pre: (ctx: { setHeaderParam: (k: string, v: string) => void }) => {
      ctx.setHeaderParam("Content-Type", "application/strategic-merge-patch+json");
      return of(ctx);
    },
    post: (ctx: unknown) => of(ctx),
  };
}

export const k8sDriver: ServerDriver = {
  async status(rec, _ctx): Promise<{ status: InstanceStatus; runtimeId: string | null }> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    try {
      const sts = await appsApi.readNamespacedStatefulSet({
        name: statefulSet,
        namespace,
      });
      const replicas = sts.spec?.replicas ?? 0;
      const ready = sts.status?.readyReplicas ?? 0;
      const updated = sts.status?.updatedReplicas ?? 0;
      const generation = sts.metadata?.generation ?? 0;
      const observedGeneration = sts.status?.observedGeneration ?? 0;
      const revisionChanged = Boolean(
        sts.status?.currentRevision &&
          sts.status?.updateRevision &&
          sts.status.currentRevision !== sts.status.updateRevision,
      );

      if (replicas === 0) {
        return { status: "exited", runtimeId: null };
      }
      if (
        ready < replicas ||
        updated < replicas ||
        observedGeneration < generation ||
        revisionChanged
      ) {
        return { status: "starting", runtimeId: null };
      }
      // running — surface the backing Pod name as the runtime id
      const podName = await findPodName(coreApi, namespace, statefulSet);
      return { status: "running", runtimeId: podName };
    } catch {
      // StatefulSet missing / API unreachable — treat as not materialized.
      return { status: "missing", runtimeId: null };
    }
  },

  async start(rec, _ctx): Promise<boolean> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    // Sync store settings to STS env before scaling up — this is where
    // settings changes (PUT /settings) take effect, on manual restart.
    const { applyEnvPatchK8s } = await import("./k8s-env-patch.js");
    await applyEnvPatchK8s(rec, rec.settings).catch(() => {});

    const patch = { spec: { replicas: 1 } };
    await appsApi.patchNamespacedStatefulSetScale(
      { name: statefulSet, namespace, body: patch },
      { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
    );
    if (rec.engineSettings && Object.keys(rec.engineSettings).length > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      await applyEngineIniK8s(rec).catch(() => {});
    }
    // Scaling replicas to 1 is idempotent; treat it as an initiated start.
    return true;
  },

  async stop(rec, _ctx): Promise<void> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const patch = { spec: { replicas: 0 } };
    await appsApi.patchNamespacedStatefulSetScale(
      { name: statefulSet, namespace, body: patch },
      { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
    );
  },

  async remove(rec, ctx): Promise<void> {
    // Scale down only — never delete the StatefulSet, so the PVC (saves) survive.
    await this.stop(rec, ctx);
  },

  async stats(rec, _ctx): Promise<InstanceStats | null> {
    // k8s 下透過 exec 讀容器的 cgroup 與 /proc。CPU 必須以同一 Pod 的
    // 累積時間差取樣，第一筆只建立基線，避免把 0 誤當成真實使用率。
    const namespace = rec.k8sNamespace!;
    const stsName = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const podName = await findPodName(coreApi, namespace, stsName);
    if (!podName) return null;

    try {
      const now = Date.now();
      const cpuStatV2 = await readFirst(rec, ["/sys/fs/cgroup/cpu.stat"]);
      const usageMicros = cpuStatV2 !== null
        ? parseCpuStatUsageMicros(cpuStatV2)
        : parseCpuAcctUsageMicros(await readFirst(rec, ["/sys/fs/cgroup/cpuacct/cpuacct.usage"]));
      const cpuMaxV2 = await readFirst(rec, ["/sys/fs/cgroup/cpu.max"]);
      const cpuCores = cpuMaxV2 !== null
        ? parseCpuMaxCores(cpuMaxV2, await readFirst(rec, ["/proc/cpuinfo"]))
        : parseCpuQuotaCores(
          await readFirst(rec, ["/sys/fs/cgroup/cpu/cpu.cfs_quota_us"]),
          await readFirst(rec, ["/sys/fs/cgroup/cpu/cpu.cfs_period_us"]),
          await readFirst(rec, ["/proc/cpuinfo"]),
        );

      const memoryCurrent = await readFirst(rec, ["/sys/fs/cgroup/memory.current"]);
      const memoryV1 = await readFirst(rec, ["/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
      const memoryBytes = parseBytes(memoryCurrent ?? memoryV1);
      const memoryMax = await readFirst(rec, ["/sys/fs/cgroup/memory.max"]);
      const memoryLimitV1 = await readFirst(rec, ["/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
      const memoryLimitBytes = parseMemoryLimit(memoryMax ?? memoryLimitV1);

      const previous = usageMicros === null ? undefined : k8sStatsSamples.get(rec.id);
      const cpuPercent = usageMicros === null || previous?.podName !== podName
        ? null
        : computeCpuPercent(previous, usageMicros, now);
      if (usageMicros === null) k8sStatsSamples.delete(rec.id);
      else k8sStatsSamples.set(rec.id, { podName, usageMicros, atMs: now });

      // uptime：從 /proc/uptime 的第一欄（秒）
      let uptimeSeconds: number | undefined;
      try {
        const upOut = await execInPod(rec, ["cat", "/proc/uptime"]);
        const statOut = await execInPod(rec, ["cat", "/proc/1/stat"]);
        const hzOut = await execInPod(rec, ["getconf", "CLK_TCK"]).catch(() => "100");
        uptimeSeconds = computeContainerUptimeSeconds(
          Number(upOut.trim().split(/\s+/)[0]),
          parseProcStatStartTicks(statOut),
          Number(hzOut.trim()) || 100,
        );
      } catch { /* best-effort */ }

      return {
        cpuPercent,
        cpuCores,
        memoryBytes,
        memoryLimitBytes,
        uptimeSeconds,
      } satisfies InstanceStats;
    } catch {
      return null;
    }
  },

  async streamLogs(
    rec,
    _ctx,
    onLine: (line: string) => void,
    onEnd: () => void,
    _source?: LogSourceId,
  ): Promise<() => void> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const podName = await findPodName(coreApi, namespace, statefulSet);
    if (!podName) {
      onEnd();
      return () => {};
    }

    // k8s.Log writes the followed log stream into the supplied Writable and
    // resolves to an AbortController we use for cleanup on disconnect.
    const out = new PassThrough();
    let buffer = "";
    out.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) onLine(line);
    });
    out.on("end", onEnd);
    out.on("error", onEnd);

    const logger = new k8s.Log(kc);
    const abort = await logger.log(namespace, podName, "", out, {
      follow: true,
      tailLines: 200,
    });

    return () => {
      abort.abort();
      out.destroy();
    };
  },

  logSources(_rec, _ctx): LogSource[] {
    // Pod stdout carries everything (game + container); there are no separate files.
    return [{ id: "agent" as const, label: "Pod 日誌", available: true }];
  },
};

type K8sStatsSample = { podName: string; usageMicros: number; atMs: number };
const k8sStatsSamples = new Map<string, K8sStatsSample>();

async function readFirst(rec: InstanceRecord, paths: string[]): Promise<string | null> {
  for (const file of paths) {
    try {
      return await execInPod(rec, ["cat", file]);
    } catch {
      // Try the next cgroup layout.
    }
  }
  return null;
}

export function parseCpuStatUsageMicros(raw: string): number | null {
  const match = /(?:^|\n)usage_usec\s+(\d+)/.exec(raw);
  return match ? Number(match[1]) : null;
}

export function parseCpuAcctUsageMicros(raw: string | null): number | null {
  if (!raw) return null;
  const nanos = Number(raw.trim());
  return Number.isFinite(nanos) && nanos >= 0 ? nanos / 1000 : null;
}

function parseBytes(raw: string | null): number {
  if (!raw) return 0;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseMemoryLimit(raw: string | null): number {
  if (!raw || raw.trim() === "max") return 0;
  const value = Number(raw.trim());
  // cgroup v1 uses a very large sentinel for unlimited memory.
  return Number.isFinite(value) && value > 0 && value < 1e18 ? value : 0;
}

function cpuInfoCores(raw: string | null): number {
  if (!raw) return 1;
  const count = (raw.match(/^processor\s*:/gm) ?? []).length;
  return count > 0 ? count : 1;
}

export function parseCpuMaxCores(raw: string, cpuInfoRaw: string | null): number {
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === "max") return cpuInfoCores(cpuInfoRaw);
  const q = Number(quota);
  const p = Number(period);
  return Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0 ? Math.max(q / p, 0.01) : cpuInfoCores(cpuInfoRaw);
}

export function parseCpuQuotaCores(quotaRaw: string | null, periodRaw: string | null, cpuInfoRaw: string | null): number {
  const quota = Number(quotaRaw?.trim());
  const period = Number(periodRaw?.trim());
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) return cpuInfoCores(cpuInfoRaw);
  return Math.max(quota / period, 0.01);
}

export function parseProcStatStartTicks(raw: string): number | null {
  const commEnd = raw.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = raw.slice(commEnd + 2).trim().split(/\s+/);
  const startTicks = Number(fields[19]); // field 22; fields start at field 3
  return Number.isFinite(startTicks) && startTicks >= 0 ? startTicks : null;
}

export function computeContainerUptimeSeconds(
  hostUptimeSeconds: number,
  startTicks: number | null,
  ticksPerSecond: number,
): number {
  if (!Number.isFinite(hostUptimeSeconds) || hostUptimeSeconds < 0) return 0;
  if (startTicks === null || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    return Math.round(hostUptimeSeconds);
  }
  return Math.max(0, Math.round(hostUptimeSeconds - startTicks / ticksPerSecond));
}

export function computeCpuPercent(
  previous: K8sStatsSample | undefined,
  usageMicros: number,
  atMs: number,
): number | null {
  if (!previous || previous.atMs >= atMs || usageMicros < previous.usageMicros) return null;
  const wallMicros = (atMs - previous.atMs) * 1000;
  if (wallMicros <= 0) return null;
  return Math.max(0, (usageMicros - previous.usageMicros) / wallMicros * 100);
}

const K8S_ENGINE_INI = "Pal/Saved/Config/LinuxServer/Engine.ini";

/** Re-apply managed Engine.ini into the running Pod, then kill PID 1 to restart. */
export async function applyEngineIniK8s(rec: InstanceRecord): Promise<void> {
  if (!rec.engineSettings || Object.keys(rec.engineSettings).length === 0) return;
  const kc = loadKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const podName = await findPodName(coreApi, rec.k8sNamespace!, rec.k8sStatefulSet!).catch(() => null);
  if (!podName) return;
  const existing = await readFileInPod(rec, K8S_ENGINE_INI).catch(() => "");
  const merged = mergeEnginePatch(existing, rec.engineSettings!);
  await writeFileInPod(rec, K8S_ENGINE_INI, merged);
  await execInPod(rec, ["kill", "1"]).catch(() => {});
}

/** k8s rolling restart via annotation patch. */
export async function rolloutRestart(rec: InstanceRecord): Promise<void> {
  const kc = loadKubeConfig();
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const patch = {
    spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } },
  };
  await appsApi.patchNamespacedStatefulSet(
    { name: rec.k8sStatefulSet!, namespace: rec.k8sNamespace!, body: patch },
    { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
  );
}

// Keep the historical k8s.ts import surface for saves.ts and engine-ini.ts.
export {
  deletePathInPod,
  downloadFileInPod,
  execInPod,
  execInPodBuffer,
  listDirInPod,
  makeDirInPod,
  readFileInPod,
  resolvePodPath,
  tarDirInPod,
  untarIntoPod,
  uploadFileInPod,
  writeFileBytesInPod,
  writeFileInPod,
} from "./k8s-files.js";
export { findPodName, loadKubeConfig } from "./k8s-files.js";
