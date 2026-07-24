import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { InstanceStatus, InstanceStats, InstallError, WorldSettings } from "@palserver/shared";
import { buildLaunchArgs } from "@palserver/shared";
import { CONTAINER_PREFIX, IMAGES, IMAGES_ARM64, IMAGES_WINE, INSTANCE_LABEL } from "./env.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";
import type { InstanceRecord } from "./store.js";
import { configPlatformDir } from "./platform.js";
import { diffIniAgainstSnapshot, renderPalWorldSettingsIni } from "./settings-ini.js";

export const docker = new Docker(); // default: /var/run/docker.sock

// ── image build/pull 狀態(仿 native.ts installing 模式)─────────────────
const building = new Set<string>();
export const isBuilding = (id: string): boolean => building.has(id);
const buildProgress = new Map<string, number>();
export const buildProgressOf = (id: string): number | null => buildProgress.get(id) ?? null;
const buildErrors = new Map<string, InstallError>();
export const lastBuildError = (id: string): InstallError | null =>
  buildErrors.get(id) ?? null;

/** ARM64 Linux 偵測(沿用 native.ts IS_LINUX_ARM64 模式;arm64 用 FEX 轉譯跑原生 server binary)。 */
const IS_LINUX_ARM64 = process.platform === "linux" && process.arch === "arm64";

/** 依 runtime / 平台 / flavor 解析容器 image 名稱(自訂 dockerImage 優先)。
 * 優先序:wine → IMAGES_WINE(arm64 不支援 wine,但若使用者硬設仍走此表,行為可預期);
 * arm64 linux → IMAGES_ARM64(FEX 轉譯);其他 → IMAGES(原生 x86-64)。 */
function resolveImage(rec: InstanceRecord): string {
  if (rec.dockerImage?.trim()) return rec.dockerImage.trim();
  if (rec.runtime === "wine") return IMAGES_WINE[rec.flavor];
  if (IS_LINUX_ARM64) return IMAGES_ARM64[rec.flavor];
  return IMAGES[rec.flavor];
}

/** 依 runtime / 平台 解析 build context 子目錄名。
 * modded 無獨立目錄(mod 是執行期注入),共用 vanilla/wine/vanilla-arm64 base。 */
function resolveBuildSubdir(rec: InstanceRecord): string {
  if (rec.runtime === "wine") return "images/wine";
  if (IS_LINUX_ARM64) return "images/vanilla-arm64";
  return "images/vanilla";
}

/** 解析 repo 根目錄(含 images/ 的位置)。三段式:env → 執行檔旁 → import.meta.url。
 *  找不到回 null(build context 不可用,退回 throw 409)。 */
function resolveRepoRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.PALSERVER_REPO_DIR) candidates.push(process.env.PALSERVER_REPO_DIR);
  candidates.push(path.dirname(process.execPath));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../"));
  } catch { /* CJS bundle:略過 */ }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "images"))) return c;
  }
  return null;
}

/** build context 的絕對路徑;找不到 repo root 回 null。 */
function resolveBuildDir(rec: InstanceRecord): string | null {
  const root = resolveRepoRoot();
  if (!root) return null;
  return path.join(root, resolveBuildSubdir(rec));
}

function containerName(rec: InstanceRecord): string {
  // 容器名只是給人看的 —— agent 一律靠 label(INSTANCE_LABEL=id)找容器,不靠名字。
  // 因此把顯示名稱正規化成 Docker 允許的字元(中文等非 ASCII 會被濾掉),再接上唯一的
  // id,確保容器名永遠合法(Docker 只收 [a-zA-Z0-9_.-])且不會撞名。
  const slug = rec.name
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .replace(/^[-_.]+/, "")
    .slice(0, 40);
  return `${CONTAINER_PREFIX}${slug ? `${slug}-` : ""}${rec.id}`;
}

async function findContainer(rec: InstanceRecord): Promise<Docker.Container | null> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${INSTANCE_LABEL}=${rec.id}`] },
  });
  return list.length > 0 ? docker.getContainer(list[0].Id) : null;
}

export async function getStatus(
  rec: InstanceRecord,
): Promise<{ status: InstanceStatus; runtimeId: string | null }> {
  // image 正在 build/pull 時回 installing,讓前端顯示進度條。
  if (building.has(rec.id)) return { status: "installing", runtimeId: null };
  const container = await findContainer(rec);
  // No container yet (never started, or removed): treated as "created" —
  // starting the instance will (re)materialize it from stored settings.
  if (!container) return { status: "created", runtimeId: null };
  const info = await container.inspect();
  const state = info.State.Status; // created|running|paused|restarting|exited|dead
  const status: InstanceStatus =
    state === "running" ? "running"
    : state === "restarting" ? "restarting"
    : state === "exited" || state === "dead" ? "exited"
    : "created";
  return { status, runtimeId: info.Id };
}

/** Write the ini into the bind-mounted config dir; picked up on next (re)start. */
export function writeConfig(instanceDir: string, settings: WorldSettings): void {
  const configDir = path.join(instanceDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(instanceDir, "saved"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "PalWorldSettings.ini"),
    renderPalWorldSettingsIni(settings),
  );
  // 快照「這次寫入的內容」:之後比對出使用者手動改 ini 的部分(與 native 同一套機制)
  try {
    fs.writeFileSync(path.join(instanceDir, "world-applied.json"), JSON.stringify(settings));
  } catch {
    /* 存不進去頂多偵測不到手動編輯,不致命 */
  }
}

/** 偵測使用者手動改了 bind-mount 裡的 PalWorldSettings.ini 的部分(docker 版)。 */
export function detectManualIniEdits(instanceDir: string): Partial<WorldSettings> {
  return diffIniAgainstSnapshot(
    (p) => fs.readFileSync(p, "utf8"),
    path.join(instanceDir, "config", "PalWorldSettings.ini"),
    path.join(instanceDir, "world-applied.json"),
  );
}

/** Re-apply managed Engine.ini tweaks into the bind-mounted saved dir before
 *  container start. The server resets Engine.ini on shutdown; like native's
 *  writeIni(), we re-apply from the store on every start. */
function applyEngineIniDocker(rec: InstanceRecord, instanceDir: string): void {
  if (!rec.engineSettings || Object.keys(rec.engineSettings).length === 0) return;
  const file = path.join(instanceDir, "saved", "Config", configPlatformDir(rec), "Engine.ini");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, mergeEnginePatch(existing, rec.engineSettings));
}

/** image 不存在時自動 build(內建鏡像)或 pull(自訂鏡像)。成功後 image 已就緒。 */
async function ensureImageExists(rec: InstanceRecord, image: string): Promise<void> {
  const imageExists = await docker.getImage(image).inspect().then(() => true).catch(() => false);
  if (imageExists) return;

  const isCustom = !!rec.dockerImage?.trim();
  building.add(rec.id);
  buildProgress.set(rec.id, 0);
  buildErrors.delete(rec.id);
  try {
    if (isCustom) {
      // 自訂鏡像:從 registry pull。
      const stream = await docker.pull(image);
      await trackProgress(stream, rec.id);
    } else {
      // 內建鏡像:從 repo images/ build。
      const ctx = resolveBuildDir(rec);
      if (!ctx || !fs.existsSync(ctx)) {
        throw Object.assign(
          new Error(`找不到 build context(${resolveBuildSubdir(rec)})— 請確認 repo 的 images/ 目錄存在`),
          { statusCode: 409 },
        );
      }
      const src = fs.readdirSync(ctx).filter((f) => !f.startsWith("."));
      const stream = await docker.buildImage({ context: ctx, src }, { t: image });
      await trackProgress(stream, rec.id);
    }
  } finally {
    building.delete(rec.id);
    buildProgress.delete(rec.id);
  }
}

/** 用 docker.followProgress 追蹤 build/pull 進度,寫入 buildProgress map。 */
function trackProgress(stream: NodeJS.ReadableStream, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (evt: { progressDetail?: { current?: number; total?: number }; status?: string }) => {
        const pd = evt.progressDetail;
        if (pd?.current != null && pd?.total != null && pd.total > 0) {
          buildProgress.set(id, Math.round((pd.current / pd.total) * 100));
        }
      },
    );
  });
}

export async function createContainer(
  rec: InstanceRecord,
  instanceDir: string,
): Promise<string> {
  writeConfig(instanceDir, rec.settings);

  const ports: Record<string, object> = { "8211/udp": {} };
  const bindings: Record<string, { HostPort: string }[]> = {
    "8211/udp": [{ HostPort: String(rec.gamePort) }],
  };
  if (rec.queryPort) {
    ports[`${rec.queryPort}/udp`] = {};
    bindings[`${rec.queryPort}/udp`] = [{ HostPort: String(rec.queryPort) }];
  }
  if (rec.settings.RESTAPIEnabled) {
    const restPort = rec.settings.RESTAPIPort;
    ports[`${restPort}/tcp`] = {};
    bindings[`${restPort}/tcp`] = [{ HostPort: String(restPort) }];
  }

  const launchArgs = [
    `-port=${rec.gamePort}`,
    ...(rec.queryPort ? [`-queryport=${rec.queryPort}`] : []),
    ...buildLaunchArgs(rec.launchOptions),
  ];

  const image = resolveImage(rec);
  // image 不存在時自動 build/pull(而非 throw 409 讓使用者手動處理)。
  await ensureImageExists(rec, image);

  const container = await docker.createContainer({
    name: containerName(rec),
    Image: image,
    Labels: { [INSTANCE_LABEL]: rec.id },
    ExposedPorts: ports,
    Cmd: launchArgs,
    HostConfig: {
      PortBindings: bindings,
      Binds: [
        `${path.join(instanceDir, "saved")}:/data/saved`,
        `${path.join(instanceDir, "config")}:/data/config:ro`,
      ],
      RestartPolicy: { Name: "unless-stopped" },
    },
  });
  return container.id;
}

export async function startInstance(rec: InstanceRecord, instanceDir: string): Promise<void> {
  writeConfig(instanceDir, rec.settings);
  applyEngineIniDocker(rec, instanceDir);

  // image 不存在時觸發背景 build/pull(IIFE),立刻回 installing 狀態;
  // build 完成後繼續 createContainer + start。仿 native.ts slow path 模式。
  const image = resolveImage(rec);
  const imageExists = await docker.getImage(image).inspect().then(() => true).catch(() => false);
  if (!imageExists) {
    if (building.has(rec.id)) return; // 已在 build 中,不重複觸發
    building.add(rec.id);
    buildProgress.set(rec.id, 0);
    buildErrors.delete(rec.id);
    void (async () => {
      try {
        await ensureImageExists(rec, image);
        let container = await findContainer(rec);
        if (!container) {
          await createContainer(rec, instanceDir);
          container = await findContainer(rec);
        }
        await container!.start().catch((err: { statusCode?: number }) => {
          if (err.statusCode !== 304) throw err;
        });
      } catch (err) {
        buildErrors.set(rec.id, {
          code: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        building.delete(rec.id);
        buildProgress.delete(rec.id);
      }
    })();
    return;
  }

  let container = await findContainer(rec);
  if (!container) {
    await createContainer(rec, instanceDir);
    container = await findContainer(rec);
  }
  await container!.start().catch((err: { statusCode?: number }) => {
    if (err.statusCode !== 304) throw err; // 304 = already running
  });
}

export async function stopInstance(rec: InstanceRecord): Promise<void> {
  const container = await findContainer(rec);
  if (!container) return;
  await container.stop({ t: 30 }).catch((err: { statusCode?: number }) => {
    if (err.statusCode !== 304) throw err; // 304 = already stopped
  });
}

export async function restartInstance(rec: InstanceRecord, instanceDir: string): Promise<void> {
  await stopInstance(rec);
  await startInstance(rec, instanceDir);
}

export async function removeInstanceContainer(rec: InstanceRecord): Promise<void> {
  const container = await findContainer(rec);
  if (!container) return;
  await container.remove({ force: true });
}

export async function getStats(rec: InstanceRecord): Promise<InstanceStats | null> {
  const container = await findContainer(rec);
  if (!container) return null;
  const stats = await container.stats({ stream: false });
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || 1;
  return {
    cpuPercent: sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0,
    cpuCores: cpuCount,
    memoryBytes: stats.memory_stats.usage ?? 0,
    memoryLimitBytes: stats.memory_stats.limit ?? 0,
  };
}

/**
 * Follow container logs as a line-oriented stream. Returns a cleanup fn.
 * Docker multiplexes stdout/stderr when TTY is off, so demux before emitting.
 */
export async function streamLogs(
  rec: InstanceRecord,
  onLine: (line: string) => void,
  onEnd: () => void,
  replay = 200,
): Promise<() => void> {
  const container = await findContainer(rec);
  if (!container) {
    onEnd();
    return () => {};
  }
  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: replay,
  });
  const out = new PassThrough();
  docker.modem.demuxStream(logStream, out, out);

  let buffer = "";
  out.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.length > 0) onLine(line);
  });
  logStream.on("end", onEnd);
  logStream.on("error", onEnd);

  return () => {
    (logStream as unknown as { destroy: () => void }).destroy();
  };
}

import type { ServerDriver } from "./driver.js";

/** Run a command inside the instance's Docker container and return stdout. */
export async function execInContainer(
  rec: InstanceRecord,
  command: string[],
): Promise<string> {
  const container = await findContainer(rec);
  if (!container) throw Object.assign(new Error("找不到容器"), { statusCode: 409 });
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (c) => chunks.push(Buffer.from(c)));
  await new Promise<void>((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err) return reject(err);
      if (stream) {
        container.modem.demuxStream(stream, stdout, stderr);
      }
      stream?.on("end", resolve);
      stream?.on("error", reject);
    });
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Run a command and preserve stderr/exit status for tool runners. */
export async function execInContainerChecked(
  rec: InstanceRecord,
  command: string[],
  user?: string,
): Promise<string> {
  const container = await findContainer(rec);
  if (!container) throw Object.assign(new Error("找不到容器"), { statusCode: 409 });
  const exec = await container.exec({
    Cmd: command,
    ...(user ? { User: user } : {}),
    AttachStdout: true,
    AttachStderr: true,
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on("data", (c) => outChunks.push(Buffer.from(c)));
  stderr.on("data", (c) => errChunks.push(Buffer.from(c)));
  await new Promise<void>((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err) return reject(err);
      if (stream) container.modem.demuxStream(stream, stdout, stderr);
      stream?.on("end", resolve);
      stream?.on("error", reject);
    });
  });
  const info = await exec.inspect();
  const stderrText = Buffer.concat(errChunks).toString("utf8").trim();
  if (info.ExitCode !== 0) {
    throw new Error(
      `容器內命令失敗(exit ${info.ExitCode}):${stderrText || command.join(" ")}`,
    );
  }
  return Buffer.concat(outChunks).toString("utf8");
}

/** Upload a tar archive into the container at the given path (like docker cp). */
export async function putArchiveToContainer(
  rec: InstanceRecord,
  tarStream: NodeJS.ReadableStream | Buffer,
  containerPath: string,
): Promise<void> {
  const container = await findContainer(rec);
  if (!container) throw Object.assign(new Error("找不到容器"), { statusCode: 409 });
  await container.putArchive(tarStream, { path: containerPath });
}

/** List files in a directory inside the container. */
export async function listInContainer(
  rec: InstanceRecord,
  dirPath: string,
): Promise<string> {
  return execInContainer(rec, ["ls", "-1", dirPath]).then((s) => s.trim());
}

/** Pull latest image and recreate container. */
export async function updateImage(rec: InstanceRecord, instanceDir: string): Promise<string> {
  const image = resolveImage(rec);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
  const container = await findContainer(rec);
  if (container) {
    await container.stop({ t: 30 }).catch(() => {});
    await container.remove({ force: true });
  }
  await startInstance(rec, instanceDir);
  return image;
}

export const dockerDriver: ServerDriver = {
  status: (rec) => getStatus(rec),
  start: async (rec, ctx) => {
    // Same no-op contract as the native driver: a container that is still
    // running must not be reported as freshly (re)started (driver.ts start()).
    if ((await getStatus(rec)).status === "running") return false;
    await startInstance(rec, ctx.instanceDir);
    return true;
  },
  stop: (rec) => stopInstance(rec),
  remove: (rec) => removeInstanceContainer(rec),
  stats: (rec) => getStats(rec),
  // Container stdout carries everything; there are no separate sources.
  logSources: () => [{ id: "agent", label: "容器輸出", available: true }],
  streamLogs: (rec, _ctx, onLine, onEnd, _source, replay) => streamLogs(rec, onLine, onEnd, replay),
};
