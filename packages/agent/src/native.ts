import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InstanceStats, InstanceStatus } from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni } from "./settings-ini.js";
import { rest } from "./restapi.js";
import { DATA_DIR } from "./env.js";

const execFileP = promisify(execFile);

const PALWORLD_APP_ID = "2394010";
const DEPOTDOWNLOADER_VERSION = "3.4.0";

const IS_WIN = process.platform === "win32";
const SERVER_LAUNCHER = IS_WIN ? "PalServer.exe" : "PalServer.sh";
const CONFIG_PLATFORM_DIR = IS_WIN ? "WindowsServer" : "LinuxServer";

/** The dedicated-server root for an instance: an adopted install if
 * configured, otherwise the agent-managed install under instanceDir. */
export function serverRoot(rec: InstanceRecord, ctx: DriverContext): string {
  return rec.serverDir ?? path.join(ctx.instanceDir, "server");
}

const pidFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "server.pid");
const logFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "server.log");

function readPid(ctx: DriverContext): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile(ctx), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid: number): Promise<void> {
  if (IS_WIN) {
    // PalServer.exe is a launcher whose real work happens in a child process;
    // taskkill /T takes down the whole tree.
    await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {});
  } else {
    try {
      process.kill(-pid, "SIGTERM"); // negative pid = process group
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

/** All (pid, ppid) pairs on the system. */
async function listAllProcesses(): Promise<Array<{ pid: number; ppid: number }>> {
  const raw = IS_WIN
    ? (
        await execFileP("powershell", [
          "-NoProfile",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ])
      ).stdout
    : (await execFileP("ps", ["-A", "-o", "pid=,ppid="])).stdout;
  return raw
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

/** Transitive children of a process (empty on lookup failure). */
async function listDescendants(rootPid: number): Promise<number[]> {
  try {
    const all = await listAllProcesses();
    const byParent = new Map<number, number[]>();
    for (const { pid, ppid } of all) {
      (byParent.get(ppid) ?? byParent.set(ppid, []).get(ppid)!).push(pid);
    }
    const result: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      for (const child of byParent.get(queue.shift()!) ?? []) {
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** Best-effort graceful shutdown through the server's own REST API
 * (saves the world before exiting). Returns true if the request landed. */
async function requestGracefulShutdown(rec: InstanceRecord): Promise<boolean> {
  try {
    await rest.shutdown(rec, 1, "Server is shutting down.");
    return true;
  } catch {
    return false; // REST disabled, no admin password, or server not responding
  }
}

/** Download DepotDownloader (64-bit, works everywhere SteamCMD's 32-bit
 * bootstrap doesn't) into the agent's tools dir once. */
async function ensureDepotDownloader(): Promise<string> {
  const platform = IS_WIN ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const toolsDir = path.join(DATA_DIR, "tools", `depotdownloader-${DEPOTDOWNLOADER_VERSION}`);
  const bin = path.join(toolsDir, IS_WIN ? "DepotDownloader.exe" : "DepotDownloader");
  if (fs.existsSync(bin)) return bin;

  fs.mkdirSync(toolsDir, { recursive: true });
  const url =
    `https://github.com/SteamRE/DepotDownloader/releases/download/` +
    `DepotDownloader_${DEPOTDOWNLOADER_VERSION}/DepotDownloader-${platform}-x64.zip`;
  const zipPath = path.join(toolsDir, "dd.zip");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download DepotDownloader: HTTP ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  // tar on Windows 10+ and macOS is bsdtar, which extracts zip archives.
  await execFileP("tar", ["-xf", zipPath, "-C", toolsDir]);
  fs.rmSync(zipPath);
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  return bin;
}

/** Install/update the dedicated server (skipped for adopted installs). */
async function ensureInstalled(
  rec: InstanceRecord,
  ctx: DriverContext,
  onLine: (line: string) => void,
): Promise<void> {
  const root = serverRoot(rec, ctx);
  if (rec.serverDir) {
    if (!fs.existsSync(path.join(root, SERVER_LAUNCHER))) {
      throw Object.assign(
        new Error(`"${SERVER_LAUNCHER}" not found in configured server dir: ${root}`),
        { statusCode: 409 },
      );
    }
    return;
  }
  if (fs.existsSync(path.join(root, SERVER_LAUNCHER))) return;

  onLine(`[palserver] installing Palworld dedicated server into ${root} ...`);
  const dd = await ensureDepotDownloader();
  const osFlag = IS_WIN ? "windows" : "linux";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(dd, [
      "-app", PALWORLD_APP_ID,
      "-dir", root,
      "-os", osFlag,
      "-osarch", "64",
      "-validate",
    ]);
    child.stdout.on("data", (b: Buffer) =>
      b.toString().split("\n").filter(Boolean).forEach(onLine),
    );
    child.stderr.on("data", (b: Buffer) =>
      b.toString().split("\n").filter(Boolean).forEach(onLine),
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`DepotDownloader exited with code ${code}`)),
    );
  });
}

function writeIni(rec: InstanceRecord, ctx: DriverContext): void {
  const configDir = path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", CONFIG_PLATFORM_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "PalWorldSettings.ini"), renderPalWorldSettingsIni(rec.settings));
}

/** Instances with a server download in flight (install runs in the
 * background so POST /start returns immediately). */
const installing = new Set<string>();

async function getNativeStatus(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<{ status: InstanceStatus; runtimeId: string | null }> {
  if (installing.has(rec.id)) return { status: "installing", runtimeId: null };
  const pid = readPid(ctx);
  if (pid !== null && isAlive(pid)) return { status: "running", runtimeId: String(pid) };
  if (pid !== null) return { status: "exited", runtimeId: null };
  return { status: "created", runtimeId: null };
}

function spawnServer(rec: InstanceRecord, ctx: DriverContext): void {
  writeIni(rec, ctx);
  fs.appendFileSync(logFile(ctx), "[palserver] starting PalServer...\n");
  const out = fs.openSync(logFile(ctx), "a");
  const child = spawn(
    path.join(serverRoot(rec, ctx), SERVER_LAUNCHER),
    [`-port=${rec.gamePort}`, "-publiclobby"],
    {
      cwd: serverRoot(rec, ctx),
      detached: true, // survives agent restarts; we track it via the pid file
      stdio: ["ignore", out, out],
    },
  );
  fs.closeSync(out);
  if (!child.pid) throw new Error("failed to spawn PalServer");
  fs.writeFileSync(pidFile(ctx), String(child.pid));
  child.unref();
}

export const nativeDriver: ServerDriver = {
  status: getNativeStatus,

  async start(rec, ctx) {
    const current = await getNativeStatus(rec, ctx);
    if (current.status === "running" || current.status === "installing") return;

    fs.mkdirSync(ctx.instanceDir, { recursive: true });
    const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");

    const alreadyInstalled = fs.existsSync(path.join(serverRoot(rec, ctx), SERVER_LAUNCHER));
    if (alreadyInstalled) {
      // Fast path: spawn synchronously so errors surface in the response.
      await ensureInstalled(rec, ctx, appendLog); // validates adopted dirs
      spawnServer(rec, ctx);
      return;
    }

    // Slow path: multi-GB download. Run in the background — the instance
    // reports "installing" and the log stream carries the progress.
    installing.add(rec.id);
    void (async () => {
      try {
        await ensureInstalled(rec, ctx, appendLog);
        spawnServer(rec, ctx);
      } catch (err) {
        appendLog(`[palserver] install/start failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        installing.delete(rec.id);
      }
    })();
  },

  async stop(rec, ctx) {
    const pid = readPid(ctx);
    if (pid === null || !isAlive(pid)) return;

    if (await requestGracefulShutdown(rec)) {
      for (let i = 0; i < 20 && isAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (isAlive(pid)) await killTree(pid);
    fs.rmSync(pidFile(ctx), { force: true });
  },

  async remove(rec, ctx) {
    await this.stop(rec, ctx);
    // Agent-managed installs and saves stay on disk; deleting world data
    // must remain an explicit, separate action.
  },

  async stats(_rec, ctx) {
    const pid = readPid(ctx);
    if (pid === null || !isAlive(pid)) return null;
    // PalServer.exe is a thin launcher; the actual server is a child process
    // (PalServer-Win64-Shipping-Cmd.exe), so aggregate the whole tree.
    const pids = [pid, ...(await listDescendants(pid))];
    const { default: pidusage } = await import("pidusage");
    const usages = await Promise.all(
      pids.map((p) => pidusage(p).catch(() => null)),
    );
    const alive = usages.filter((u) => u !== null);
    if (alive.length === 0) return null;
    return {
      cpuPercent: alive.reduce((sum, u) => sum + u.cpu, 0),
      memoryBytes: alive.reduce((sum, u) => sum + u.memory, 0),
      memoryLimitBytes: os.totalmem(),
    } satisfies InstanceStats;
  },

  logSources(rec, ctx) {
    return [
      { id: "agent" as const, label: "agent", available: fs.existsSync(logFile(ctx)) },
      { id: "game" as const, label: "遊戲", available: fs.existsSync(gameLogFile(rec, ctx)) },
      {
        id: "paldefender" as const,
        label: "PalDefender",
        available: palDefenderLogDir(rec, ctx) !== null,
      },
    ];
  },

  async streamLogs(rec, ctx, onLine, _onEnd, source = "agent") {
    // Files may not exist yet (first boot) — the followers attach when they
    // appear, so the socket stays open instead of closing early.
    if (source === "game") return followFile(gameLogFile(rec, ctx), onLine, 200);
    if (source === "paldefender") {
      const dir = palDefenderLogDir(rec, ctx);
      if (!dir) {
        onLine("(找不到 PalDefender 日誌 — 安裝後啟動一次伺服器即會產生)");
        return () => {};
      }
      // PalDefender writes a new, timestamped file per run; follow the newest
      // and switch over when it rotates.
      return followNewestInDir(dir, onLine);
    }
    // "agent": our own capture — install progress and server stdout.
    return followFile(logFile(ctx), onLine);
  },
};

const gameLogFile = (rec: InstanceRecord, ctx: DriverContext) =>
  path.join(serverRoot(rec, ctx), "Pal", "Saved", "Logs", "Pal.log");

/** PalDefender's log dir; the plugin was formerly named Palguard and older
 * installs still write to palguard/logs. Returns null when neither exists. */
function palDefenderLogDir(rec: InstanceRecord, ctx: DriverContext): string | null {
  const win64 = path.join(serverRoot(rec, ctx), "Pal", "Binaries", "Win64");
  for (const name of ["PalDefender", "palguard"]) {
    const dir = path.join(win64, name, "logs");
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function newestFile(dir: string): string | null {
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.full ?? null;
  } catch {
    return null;
  }
}

/** Follow whichever file in `dir` is newest, re-attaching when it rotates. */
function followNewestInDir(dir: string, onLine: (line: string) => void): () => void {
  let current: string | null = null;
  let stopCurrent: (() => void) | null = null;
  const timer = setInterval(() => {
    const newest = newestFile(dir);
    if (newest && newest !== current) {
      stopCurrent?.();
      current = newest;
      onLine(`— 跟隨日誌檔:${path.basename(newest)} —`);
      stopCurrent = followFile(newest, onLine, 200);
    }
  }, 1000);
  const initial = newestFile(dir);
  if (initial) {
    current = initial;
    stopCurrent = followFile(initial, onLine, 200);
  }
  return () => {
    clearInterval(timer);
    stopCurrent?.();
  };
}

/** Tail -f a file: replay the last `replay` lines once it exists, then
 * follow appended bytes. Handles truncation/rotation (position reset) and
 * files that appear later. Returns a cleanup fn. */
function followFile(file: string, onLine: (line: string) => void, replay = 200): () => void {
  let attached = false;
  let position = 0;
  let buffer = "";
  const timer = setInterval(() => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      attached = false; // gone (or not yet created) — reattach when it appears
      return;
    }
    if (!attached) {
      const existing = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of existing.slice(-replay)) onLine(line);
      position = size;
      buffer = "";
      attached = true;
      return;
    }
    if (size < position) {
      // truncated or rotated in place (UE starts a fresh Pal.log per boot)
      position = 0;
      buffer = "";
    }
    if (size === position) return;
    const stream = fs.createReadStream(file, { start: position, end: size - 1 });
    position = size;
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) onLine(line);
    });
  }, 500);
  return () => clearInterval(timer);
}
