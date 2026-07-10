import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { InstanceStatus, InstanceStats, WorldSettings } from "@palserver/shared";
import { CONTAINER_PREFIX, IMAGES, INSTANCE_LABEL } from "./env.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni } from "./settings-ini.js";

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
  if (rec.settings.RESTAPIEnabled) {
    ports["8212/tcp"] = {};
    // REST API stays loopback-only: it is the agent's private control channel.
    bindings["8212/tcp"] = [{ HostPort: "0" }];
  }

  const imageExists = await docker
    .getImage(IMAGES[rec.flavor])
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (!imageExists) {
    const err = new Error(
      `server image "${IMAGES[rec.flavor]}" not found — build it first: ` +
        `docker build -t ${IMAGES[rec.flavor]} images/${rec.flavor}`,
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  const container = await docker.createContainer({
    name: containerName(rec),
    Image: IMAGES[rec.flavor],
    Labels: { [INSTANCE_LABEL]: rec.id },
    ExposedPorts: ports,
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

export const dockerDriver: ServerDriver = {
  status: (rec) => getStatus(rec),
  start: (rec, ctx) => startInstance(rec, ctx.instanceDir),
  stop: (rec) => stopInstance(rec),
  remove: (rec) => removeInstanceContainer(rec),
  stats: (rec) => getStats(rec),
  // Container stdout carries everything; there are no separate sources.
  logSources: () => [{ id: "agent", label: "容器輸出", available: true }],
  streamLogs: (rec, _ctx, onLine, onEnd) => streamLogs(rec, onLine, onEnd),
};
