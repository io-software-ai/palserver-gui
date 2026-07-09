import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InstanceStats, InstanceStatus } from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni } from "./settings-ini.js";
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

/** Best-effort graceful shutdown through the server's own REST API
 * (saves the world before exiting). Returns true if the request landed. */
async function requestGracefulShutdown(rec: InstanceRecord): Promise<boolean> {
  if (!rec.settings.RESTAPIEnabled || !rec.settings.AdminPassword) return false;
  try {
    const res = await fetch(
      `http://127.0.0.1:${rec.settings.RESTAPIPort}/v1/api/shutdown`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`admin:${rec.settings.AdminPassword}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ waittime: 1, message: "Server is shutting down." }),
        signal: AbortSignal.timeout(4000),
      },
    );
    return res.ok;
  } catch {
    return false;
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

async function getNativeStatus(
  _rec: InstanceRecord,
  ctx: DriverContext,
): Promise<{ status: InstanceStatus; runtimeId: string | null }> {
  const pid = readPid(ctx);
  if (pid !== null && isAlive(pid)) return { status: "running", runtimeId: String(pid) };
  if (pid !== null) return { status: "exited", runtimeId: null };
  return { status: "created", runtimeId: null };
}

export const nativeDriver: ServerDriver = {
  status: getNativeStatus,

  async start(rec, ctx) {
    const current = await getNativeStatus(rec, ctx);
    if (current.status === "running") return;

    fs.mkdirSync(ctx.instanceDir, { recursive: true });
    const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");

    await ensureInstalled(rec, ctx, appendLog);
    writeIni(rec, ctx);

    appendLog("[palserver] starting PalServer...");
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
    const { default: pidusage } = await import("pidusage");
    try {
      const s = await pidusage(pid);
      return {
        cpuPercent: s.cpu,
        memoryBytes: s.memory,
        memoryLimitBytes: os.totalmem(),
      } satisfies InstanceStats;
    } catch {
      return null;
    }
  },

  async streamLogs(_rec, ctx, onLine, onEnd) {
    const file = logFile(ctx);
    if (!fs.existsSync(file)) {
      onEnd();
      return () => {};
    }
    // Send the tail of what exists, then follow appended bytes.
    const existing = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of existing.slice(-200)) onLine(line);

    let position = fs.statSync(file).size;
    let buffer = "";
    const timer = setInterval(() => {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        clearInterval(timer);
        onEnd();
        return;
      }
      if (size <= position) return;
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
  },
};
