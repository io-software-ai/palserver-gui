import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import type { InstallError, InstanceStats, InstanceStatus } from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni } from "./settings-ini.js";
import { rest } from "./restapi.js";
import { DATA_DIR } from "./env.js";

const execFileP = promisify(execFile);

const PALWORLD_APP_ID = "2394010";
const DEPOTDOWNLOADER_VERSION = "3.4.0";

const IS_WIN = process.platform === "win32";
export const SERVER_LAUNCHER = IS_WIN ? "PalServer.exe" : "PalServer.sh";
const CONFIG_PLATFORM_DIR = IS_WIN ? "WindowsServer" : "LinuxServer";

/** The dedicated-server root for an instance: an adopted install if
 * configured, otherwise the agent-managed install under instanceDir. */
export function serverRoot(rec: InstanceRecord, ctx: DriverContext): string {
  return rec.serverDir ?? path.join(ctx.instanceDir, "server");
}

/** Classify a user-supplied server dir at creation time: an existing install
 * is adopted as-is, an empty or not-yet-existing directory becomes the
 * install target, anything else is rejected (likely a typo — installing
 * would dump 20GB into the wrong place). */
export function classifyServerDir(dir: string): "adopt" | "install" | "not-a-server" {
  if (fs.existsSync(path.join(dir, SERVER_LAUNCHER))) return "adopt";
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) return "install";
  return "not-a-server";
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
    await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
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
        await execFileP(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          // windowsHide:否則效能分頁每隔幾秒抓一次行程樹,就會閃一個 PowerShell 視窗。
          { windowsHide: true },
        )
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
  // Plain `tar` can't extract zip on most Linux distros (GNU tar has no zip
  // support; only bsdtar on Windows 10+/macOS does), so use a JS zip reader.
  await extractZip(zipPath, { dir: toolsDir });
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
  if (rec.serverDir && !rec.serverDirManaged) {
    // Adopted install: never download into it — a missing launcher means the
    // configured dir is wrong (or the drive is gone), not "please install".
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
  await runDepotDownloader(dd, root, onLine);
}

/** DepotDownloader / OS 在磁碟寫滿時吐的字樣(跨平台、含 .NET IOException)。 */
const DISK_FULL_RE =
  /no space left on device|not enough space|disk( is)? full|enospc|there is not enough space on the disk|0x70|System\.IO\.IOException.*space/i;

/** 標成磁碟不足的錯誤;前端據 code 顯示友善提示。 */
function diskFullError(): Error & { code: "disk-full" } {
  return Object.assign(new Error("磁碟空間不足"), { code: "disk-full" as const });
}

/** Download/update the dedicated server into `root`. Also used by updateServer. */
function runDepotDownloader(
  dd: string,
  root: string,
  onLine: (line: string) => void,
): Promise<void> {
  const osFlag = IS_WIN ? "windows" : "linux";
  return new Promise<void>((resolve, reject) => {
    let sawDiskFull = false;
    const handle = (b: Buffer) =>
      b
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => {
          if (DISK_FULL_RE.test(line)) sawDiskFull = true;
          onLine(line);
        });
    const child = spawn(
      dd,
      ["-app", PALWORLD_APP_ID, "-dir", root, "-os", osFlag, "-osarch", "64", "-validate"],
      { windowsHide: true },
    );
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      // 非零離開 + 看到磁碟不足字樣 = 幾乎確定是空間問題,給前端可翻譯的 code。
      reject(sawDiskFull ? diskFullError() : new Error(`DepotDownloader exited with code ${code}`));
    });
  });
}

function writeIni(rec: InstanceRecord, ctx: DriverContext): void {
  const configDir = path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", CONFIG_PLATFORM_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "PalWorldSettings.ini"), renderPalWorldSettingsIni(rec.settings));
}

/** Instances with a server download in flight (install/update runs in the
 * background so the request returns immediately). */
const installing = new Set<string>();

export const isInstalling = (id: string) => installing.has(id);

/** 每個實例最後一次安裝/更新失敗的原因,讓 UI 不用翻日誌就看得到。開始新的
 * 安裝或成功時清掉。 */
const installErrors = new Map<string, InstallError>();

export const lastInstallError = (id: string): InstallError | null => installErrors.get(id) ?? null;

/** 把丟出來的錯誤歸類成給前端的 InstallError(磁碟不足會標成可翻譯的 code)。 */
function classifyInstallError(err: unknown): InstallError {
  const code = (err as { code?: string })?.code;
  if (code === "disk-full" || code === "ENOSPC") {
    return { code: "disk-full", message: "磁碟空間不足" };
  }
  return { code: "error", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Re-run DepotDownloader over an existing install to pull the latest content.
 * Runs in the background: the instance reports "installing" and the agent log
 * stream carries the progress. The caller must ensure the server is stopped.
 */
export function updateServer(rec: InstanceRecord, ctx: DriverContext): void {
  if (installing.has(rec.id)) return;
  installing.add(rec.id);
  installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
  const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");
  void (async () => {
    try {
      fs.mkdirSync(ctx.instanceDir, { recursive: true });
      appendLog("[palserver] 開始更新伺服器…");
      const dd = await ensureDepotDownloader();
      await runDepotDownloader(dd, serverRoot(rec, ctx), appendLog);
      appendLog("[palserver] 更新完成");
    } catch (err) {
      const info = classifyInstallError(err);
      installErrors.set(rec.id, info);
      appendLog(
        info.code === "disk-full"
          ? "[palserver] 更新失敗:磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。"
          : `[palserver] 更新失敗:${info.message}`,
      );
    } finally {
      installing.delete(rec.id);
    }
  })();
}

/**
 * 把伺服器檔案從目前的 serverRoot 實際搬到 newServerDir(改路徑時用)。
 * 同磁碟用 rename 瞬間完成;跨磁碟(常見:C槽搬到D槽)改用非同步複製再刪除,
 * 不阻塞事件迴圈。搬移期間沿用「安裝中」狀態擋住啟動/重複操作;搬完才呼叫
 * onMoved 更新記錄(把 serverDir 指到新位置)。失敗則記到 installErrors、
 * 不更新記錄 —— 舊檔案原封不動,半成品會清掉。newServerDir 傳 undefined = 搬回
 * agent 管理的資料夾。呼叫端須先確認伺服器已停止、且目標為空/不存在。
 */
export function moveServerFiles(
  rec: InstanceRecord,
  ctx: DriverContext,
  newServerDir: string | undefined,
  onMoved: () => void,
): void {
  if (installing.has(rec.id)) return;
  const fromRoot = serverRoot(rec, ctx);
  const toRoot = newServerDir ?? path.join(ctx.instanceDir, "server");
  installing.add(rec.id);
  installErrors.delete(rec.id);
  const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");
  void (async () => {
    try {
      appendLog(`[palserver] 搬移伺服器檔案:${fromRoot} → ${toRoot}`);
      fs.mkdirSync(path.dirname(toRoot), { recursive: true });
      try {
        fs.renameSync(fromRoot, toRoot); // 同磁碟:瞬間完成
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // 跨磁碟:複製到新位置再刪掉舊的(非同步,不卡住 agent)。
        appendLog("[palserver] 跨磁碟搬移,改用複製 —— 檔案多時需要一些時間,請耐心等候…");
        try {
          await fs.promises.cp(fromRoot, toRoot, { recursive: true });
        } catch (copyErr) {
          // 複製失敗:清掉半成品,舊檔案仍在原位,記錄不變。
          await fs.promises.rm(toRoot, { recursive: true, force: true }).catch(() => {});
          throw copyErr;
        }
        await fs.promises.rm(fromRoot, { recursive: true, force: true });
      }
      onMoved();
      appendLog("[palserver] 搬移完成");
    } catch (err) {
      installErrors.set(rec.id, classifyInstallError(err));
      appendLog(`[palserver] 搬移失敗:${err instanceof Error ? err.message : err}`);
    } finally {
      installing.delete(rec.id);
    }
  })();
}

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
  const launcher = path.join(serverRoot(rec, ctx), SERVER_LAUNCHER);
  // DepotDownloader (and adopted installs copied from elsewhere) don't
  // preserve/set the executable bit on Linux.
  if (!IS_WIN) fs.chmodSync(launcher, 0o755);
  fs.appendFileSync(logFile(ctx), "[palserver] starting PalServer...\n");
  const out = fs.openSync(logFile(ctx), "a");
  const child = spawn(
    launcher,
    [`-port=${rec.gamePort}`, "-publiclobby"],
    {
      cwd: serverRoot(rec, ctx),
      detached: true, // survives agent restarts; we track it via the pid file
      stdio: ["ignore", out, out],
      windowsHide: true, // 別讓伺服器行程在 Windows 彈出主控台視窗(日誌已導到檔案)。
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
      installErrors.delete(rec.id); // 成功啟動,清掉上次的安裝失敗
      return;
    }

    // Slow path: multi-GB download. Run in the background — the instance
    // reports "installing" and the log stream carries the progress.
    installing.add(rec.id);
    installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
    void (async () => {
      try {
        await ensureInstalled(rec, ctx, appendLog);
        spawnServer(rec, ctx);
      } catch (err) {
        const info = classifyInstallError(err);
        installErrors.set(rec.id, info);
        appendLog(
          info.code === "disk-full"
            ? "[palserver] 安裝失敗:磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。"
            : `[palserver] install/start failed: ${info.message}`,
        );
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
    // 主行程(pids[0])的 elapsed 就是伺服器運行時間;pidusage 以毫秒回報。
    const mainElapsed = usages[0]?.elapsed;
    return {
      cpuPercent: alive.reduce((sum, u) => sum + u.cpu, 0),
      cpuCores: os.cpus().length,
      memoryBytes: alive.reduce((sum, u) => sum + u.memory, 0),
      memoryLimitBytes: os.totalmem(),
      processCount: alive.length,
      uptimeSeconds: mainElapsed ? Math.round(mainElapsed / 1000) : undefined,
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
