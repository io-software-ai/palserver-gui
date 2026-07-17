import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { InstanceStatus, InstanceStats, WorldSettings } from "@palserver/shared";
import { buildLaunchArgs } from "@palserver/shared";
import { CONTAINER_PREFIX, IMAGES, IMAGES_WINE, INSTANCE_LABEL } from "./env.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";
import type { InstanceRecord } from "./store.js";
import { configPlatformDir } from "./platform.js";
import { diffIniAgainstSnapshot, renderPalWorldSettingsIni } from "./settings-ini.js";

export const docker = new Docker(); // default: /var/run/docker.sock

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

  const image = rec.dockerImage?.trim()
    || (rec.runtime === "wine" ? IMAGES_WINE[rec.flavor] : IMAGES[rec.flavor]);
  const imageExists = await docker
    .getImage(image)
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (!imageExists) {
    const err = new Error(
      rec.dockerImage?.trim()
        ? `找不到自訂鏡像 "${image}" — 請先 docker pull 該鏡像,或確認名稱/標籤正確`
        : `server image "${image}" not found — build it first: ` +
            `docker build -t ${image} images/${rec.flavor}`,
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

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
    tail: 200,
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
  const image = rec.dockerImage?.trim()
    || (rec.runtime === "wine" ? IMAGES_WINE[rec.flavor] : IMAGES[rec.flavor]);
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
  streamLogs: (rec, _ctx, onLine, onEnd) => streamLogs(rec, onLine, onEnd),
};
