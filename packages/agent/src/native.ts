import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import { buildLaunchArgs, type InstallError, type InstanceStats, type InstanceStatus, type WorldSettings } from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni, diffIniAgainstSnapshot } from "./settings-ini.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";
import { rest } from "./restapi.js";
import { emitAgentEvent } from "./events.js";
import { DATA_DIR } from "./env.js";
import { serverPlatform, configPlatformDir } from "./platform.js";

const execFileP = promisify(execFile);

const PALWORLD_APP_ID = "2394010";
const DEPOTDOWNLOADER_VERSION = "3.4.0";

const IS_WIN = process.platform === "win32";

/** 伺服器啟動器檔名:Wine(Windows binary)用 PalServer.exe,Linux 原生用 PalServer.sh。 */
export function serverLauncher(rec: InstanceRecord): string {
  return serverPlatform(rec) === "windows" ? "PalServer.exe" : "PalServer.sh";
}

/** Linux ARM64(樹莓派/NanoPi/Ampere…):官方只出 x86-64 伺服器執行檔,
 * 直接 exec 會被核心拒絕(shell 誤當腳本解析、噴 Syntax error),
 * 必須經 x86-64→ARM64 動態轉譯器啟動。 */
const IS_LINUX_ARM64 = process.platform === "linux" && process.arch === "arm64";

/** 找 x86-64 轉譯器。首選 FEX(實測 Palworld 可跑滿速;box64 缺 x86-64
 * libgcc_s 會啟動失敗,留作已自備函式庫者的後備)。每種都先看 agent tools
 * 目錄(免 root 手動安裝可放這),其次 PATH(發行版套件)。
 * FEX 另需 x86-64 rootfs:跑一次 `FEXRootFSFetcher -y -x` 抓好即可。 */
function findX64Emulator(): string | null {
  const candidates = [
    path.join(DATA_DIR, "tools", "fex", "FEXInterpreter"),
    path.join(DATA_DIR, "tools", "box64", "box64"),
  ];
  for (const name of ["FEXInterpreter", "box64"]) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, name));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The dedicated-server root for an instance: an adopted install if
 * configured, otherwise the agent-managed install under instanceDir. */
export function serverRoot(rec: InstanceRecord, ctx: DriverContext): string {
  return rec.serverDir ?? path.join(ctx.instanceDir, "server");
}

/** Classify a user-supplied server dir at creation time: an existing install
 * is adopted as-is, an empty or not-yet-existing directory becomes the
 * install target, anything else is rejected (likely a typo — installing
 * would dump 20GB into the wrong place). */
export function classifyServerDir(
  dir: string,
  launcherName: string = IS_WIN ? "PalServer.exe" : "PalServer.sh",
): "adopt" | "install" | "not-a-server" {
  if (fs.existsSync(path.join(dir, launcherName))) return "adopt";
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) return "install";
  return "not-a-server";
}

const pidFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "server.pid");
const logFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "server.log");

/**
 * pid 檔內容:PID + 行程「建立時間」當身分指紋。只存數字不夠 —— Windows 很快
 * 就回收 PID,一台崩潰後留下的陳舊 pid 檔,號碼可能已被別台的 PalServer 重用,
 * 誤把鄰居當成自己(狀態張冠李戴、甚至 stop 時 taskkill 砍到別台)。所以用前必須
 * 比對建立時間確認「這個 PID 真的是這台實例當初開的那個行程」。 */
interface PidRecord {
  pid: number;
  /** OS 回報的行程建立時間;舊格式(純數字)沒有,為 null 時退回舊行為。 */
  startedAt: string | null;
}

function readPidRecord(ctx: DriverContext): PidRecord | null {
  try {
    const raw = fs.readFileSync(pidFile(ctx), "utf8").trim();
    if (raw.startsWith("{")) {
      const o = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
      const pid = Number(o.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, startedAt: typeof o.startedAt === "string" ? o.startedAt : null };
    }
    // 舊格式:pid 檔只有一個數字。
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: null } : null;
  } catch {
    return null;
  }
}

function writePidRecord(ctx: DriverContext, record: PidRecord): void {
  fs.writeFileSync(pidFile(ctx), JSON.stringify(record));
}

/** 這個 PID 號碼目前存不存在(便宜的快速檢查,不驗身分)。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** OS 回報某 PID 的身分(建立時間 + 映像名);行程不存在時回 null。 */
async function processIdentity(pid: number): Promise<{ startedAt: string; image: string } | null> {
  try {
    if (IS_WIN) {
      const { stdout } = await execFileP(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.CreationDate.ToString('o'))|$($p.Name)" }`,
        ],
        { windowsHide: true },
      );
      const line = stdout.trim();
      if (!line) return null;
      const [startedAt, image] = line.split("|");
      return { startedAt: startedAt ?? "", image: image ?? "" };
    }
    const { stdout } = await execFileP("ps", ["-p", String(pid), "-o", "lstart="]);
    const startedAt = stdout.trim();
    if (!startedAt) return null;
    let image = "";
    try {
      image = (await execFileP("ps", ["-p", String(pid), "-o", "comm="])).stdout.trim();
    } catch {
      /* image 只在 Windows 拿來多擋一層,拿不到不影響 */
    }
    return { startedAt, image };
  } catch {
    return null;
  }
}

/**
 * 這台實例的伺服器是否真的在跑。先用便宜的 isAlive 篩掉「PID 根本不存在」,
 * 存在時再比對建立時間確認不是別台重用同一個 PID 號碼的行程。 */
async function checkAlive(ctx: DriverContext): Promise<{ alive: boolean; pid: number | null }> {
  const record = readPidRecord(ctx);
  if (!record) return { alive: false, pid: null };
  if (!isAlive(record.pid)) return { alive: false, pid: record.pid }; // 號碼不在 → 已結束
  if (record.startedAt === null) return { alive: true, pid: record.pid }; // 舊 pid 檔,無從驗證
  const id = await processIdentity(record.pid);
  if (!id) return { alive: false, pid: record.pid };
  // 建立時間對不上 = 這個 PID 已被別的行程重用,不是我們的。
  if (id.startedAt !== record.startedAt) return { alive: false, pid: record.pid };
  return { alive: true, pid: record.pid };
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

/** DepotDownloader 工具快取目錄(重置損毀工具時也要用同一個路徑)。 */
const depotDownloaderDir = () => path.join(DATA_DIR, "tools", `depotdownloader-${DEPOTDOWNLOADER_VERSION}`);

/** Download DepotDownloader (64-bit, works everywhere SteamCMD's 32-bit
 * bootstrap doesn't) into the agent's tools dir once.
 * 先落到暫存目錄、驗證 exe 存在且大小合理,再整目錄換名上位 —— 半套下載/解壓
 * (斷線、磁碟滿、防毒攔截)不會留下「看似存在其實損毀」的快取,那會讓之後
 * 每一次安裝/更新都敗在同一顆壞 exe 上(症狀:exit 0xE0434352)。 */
/** Node 的 process.arch → DepotDownloader release asset 的 arch 後綴。
 * macOS/Windows 官方只出 x64/arm64;linux 另有 arm(32-bit,樹莓派舊機型)。 */
function depotDownloaderArchSuffix(platform: "windows" | "macos" | "linux"): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "arm" && platform === "linux") return "arm";
  return "x64";
}

async function ensureDepotDownloader(): Promise<string> {
  const platform = IS_WIN ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = depotDownloaderArchSuffix(platform);
  const toolsDir = depotDownloaderDir();
  const binName = IS_WIN ? "DepotDownloader.exe" : "DepotDownloader";
  const bin = path.join(toolsDir, binName);
  if (fs.existsSync(bin)) return bin;

  const tmpDir = `${toolsDir}.part`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const url =
    `https://github.com/SteamRE/DepotDownloader/releases/download/` +
    `DepotDownloader_${DEPOTDOWNLOADER_VERSION}/DepotDownloader-${platform}-${arch}.zip`;
  const zipPath = path.join(tmpDir, "dd.zip");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download DepotDownloader: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = Number(res.headers.get("content-length") ?? 0);
  if (expected > 0 && buf.byteLength !== expected) {
    throw new Error(`DepotDownloader 下載不完整(${buf.byteLength}/${expected} bytes),請再試一次`);
  }
  fs.writeFileSync(zipPath, buf);
  // Plain `tar` can't extract zip on most Linux distros (GNU tar has no zip
  // support; only bsdtar on Windows 10+/macOS does), so use a JS zip reader.
  await extractZip(zipPath, { dir: tmpDir });
  fs.rmSync(zipPath);
  const tmpBin = path.join(tmpDir, binName);
  const st = fs.statSync(tmpBin, { throwIfNoEntry: false });
  // self-contained .NET 單檔至少數十 MB;過小代表解壓不完整
  if (!st || st.size < 5_000_000) {
    throw new Error("DepotDownloader 解壓後不完整,請再試一次");
  }
  if (!IS_WIN) fs.chmodSync(tmpBin, 0o755);
  fs.rmSync(toolsDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, toolsDir);
  return bin;
}

/** Install/update the dedicated server (skipped for adopted installs). */
async function ensureInstalled(
  rec: InstanceRecord,
  ctx: DriverContext,
  onLine: (line: string) => void,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const root = serverRoot(rec, ctx);
  const launcher = serverLauncher(rec);
  if (rec.serverDir && !rec.serverDirManaged) {
    // Adopted install: never download into it — a missing launcher means the
    // configured dir is wrong (or the drive is gone), not "please install".
    if (!fs.existsSync(path.join(root, launcher))) {
      throw Object.assign(
        new Error(`"${launcher}" not found in configured server dir: ${root}`),
        { statusCode: 409 },
      );
    }
    return;
  }
  if (fs.existsSync(path.join(root, launcher))) return;

  onLine(`[palserver] installing Palworld dedicated server into ${root} ...`);
  // Wine(modded)抓 Windows binary;否則抓對應平台的原生 binary。
  const osFlag = serverPlatform(rec) === "windows" ? "windows" : "linux";
  await runDepotDownloaderWithRecovery(root, osFlag, onLine, onProgress);
}

/** DepotDownloader / OS 在磁碟寫滿時吐的字樣(跨平台、含 .NET IOException)。 */
const DISK_FULL_RE =
  /no space left on device|not enough space|disk( is)? full|enospc|there is not enough space on the disk|0x70|System\.IO\.IOException.*space/i;

/** 標成磁碟不足的錯誤;前端據 code 顯示友善提示。 */
function diskFullError(): Error & { code: "disk-full" } {
  return Object.assign(new Error("磁碟空間不足"), { code: "disk-full" as const });
}

/** DepotDownloader 撞到「檔案被其他程序鎖住」的字樣(.NET IOException)。 */
const FILE_LOCKED_RE = /being used by another process/i;

/** Windows:找出「執行檔位於 root 底下」的殘留行程並強制結束。
 *  真實案例:伺服器崩潰循環後,UE 的 CrashReportClient.exe(或殭屍 PalServer)
 *  殘留在背景鎖住 dbghelp.dll / steam_api64.dll —— 它不是我們追蹤的行程,
 *  GUI 判定「已停止」,但 DepotDownloader 開檔會 IOException(exit 0xE0434352)、
 *  重灌刪檔會 EPERM。更新/重灌前先清場,清掉的行程記進日誌。 */
async function killLeftoverProcessesUnder(
  rec: InstanceRecord,
  root: string,
  appendLog: (line: string) => void,
): Promise<void> {
  if (!IS_WIN) return;
  // adopt(使用者自帶目錄)不清場:該目錄下的行程可能是使用者自己手動啟動的
  // 伺服器,誤殺代價太高;agent 自管目錄下的行程必然是我們(或遊戲)生的,才砍。
  if (rec.serverDir && !rec.serverDirManaged) return;
  try {
    const psRoot = root.replace(/'/g, "''");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          // 用 Win32_Process(CIM)讀 ExecutablePath,不要用 Get-Process 的 .Path:
          // .Path 需開啟目標行程控制代碼讀 MainModule,對某些行程(權限/位元差異)會拋錯而被
          // 靜默略過 → 殘留的 PalServer 漏抓、繼續鎖住 dwmapi.dll 擋住更新(長期的「沒真正關掉」bug)。
          // CIM 直接讀核心行程記錄,列舉更可靠、涵蓋到那些漏抓的殘留行程。
          `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${psRoot}\\*' } | ForEach-Object { [pscustomobject]@{ Id = $_.ProcessId; ProcessName = $_.Name } } | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 15000 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    const raw = stdout.trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as { Id: number; ProcessName: string } | { Id: number; ProcessName: string }[];
    const procs = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of procs) {
      appendLog(`[palserver] 結束殘留行程 ${p.ProcessName} (PID ${p.Id}) — 它鎖住了伺服器檔案,擋住更新`);
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/F", "/T", "/PID", String(p.Id)], { windowsHide: true }, () => resolve());
      });
    }
    if (procs.length > 0) await new Promise((r) => setTimeout(r, 1500)); // 等 OS 釋放檔案鎖
  } catch {
    /* 列舉失敗(權限/PowerShell 異常):不擋流程,真有鎖檔會由 FILE_LOCKED_RE 交代 */
  }
}

/** DepotDownloader 每完成一個檔案吐一行「 12.34% 檔案路徑」(累計進度)。
 *  抓行首百分比;某些 locale 小數點是逗號,一併接受。 */
const DD_PROGRESS_RE = /^\s*(\d{1,3}(?:[.,]\d+)?)%\s/;

/** Download/update the dedicated server into `root`. Also used by updateServer. */
function runDepotDownloader(
  dd: string,
  root: string,
  osFlag: string,
  onLine: (line: string) => void,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sawDiskFull = false;
    let sawLocked = false;
    let outputLines = 0;
    const handle = (b: Buffer) =>
      b
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => {
          outputLines += 1;
          if (DISK_FULL_RE.test(line)) sawDiskFull = true;
          if (FILE_LOCKED_RE.test(line)) sawLocked = true;
          const m = DD_PROGRESS_RE.exec(line);
          if (m && onProgress) {
            const pct = Number(m[1].replace(",", "."));
            if (Number.isFinite(pct) && pct >= 0 && pct <= 100) onProgress(pct);
          }
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
      if (sawDiskFull) return reject(diskFullError());
      if (sawLocked) {
        // 檔案被其他程序鎖住:通常是崩潰後殘留的 CrashReportClient / 殭屍 PalServer
        // (更新前已嘗試自動清場,仍撞到就明講怎麼辦)
        return reject(
          new Error(
            "伺服器檔案被其他程序鎖定 — 請開工作管理員結束 PalServer 與 CrashReportClient 程序(或重開機)後再試",
          ),
        );
      }
      // 幾乎沒有輸出就非零退場 = 下載器本身掛了(工具檔損毀/被防毒攔截/
      // .NET 例外如 0xE0434352),不是 Steam 下載問題 —— 標記給呼叫端重置工具重試。
      const hex = code !== null && code >= 0 ? ` (0x${code.toString(16).toUpperCase()})` : "";
      reject(
        Object.assign(new Error(`DepotDownloader exited with code ${code}${hex}`), {
          ddEarlyCrash: outputLines < 5,
        }),
      );
    });
  });
}

/** 跑 DepotDownloader,「啟動即崩潰」時自動重置工具快取、重新下載後再試一次。
 *  損毀的快取工具會讓每一次安裝/更新都敗在同一顆壞 exe(社群回報:
 *  exit 3762504530 = 0xE0434352 .NET 例外),自我修復比叫使用者刪資料夾實際。 */
async function runDepotDownloaderWithRecovery(
  root: string,
  osFlag: string,
  onLine: (line: string) => void,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const dd = await ensureDepotDownloader();
  try {
    await runDepotDownloader(dd, root, osFlag, onLine, onProgress);
  } catch (err) {
    if (!(err as { ddEarlyCrash?: boolean }).ddEarlyCrash) throw err;
    onLine("[palserver] 下載器啟動即異常(工具檔可能損毀),正在重新下載 DepotDownloader 後重試…");
    fs.rmSync(depotDownloaderDir(), { recursive: true, force: true });
    const freshDd = await ensureDepotDownloader();
    try {
      await runDepotDownloader(freshDd, root, osFlag, onLine, onProgress);
    } catch (err2) {
      if ((err2 as { ddEarlyCrash?: boolean }).ddEarlyCrash) {
        throw new Error(
          `${(err2 as Error).message} — 下載器重新下載後仍異常,可能被防毒軟體攔截:請把 agent 資料夾加入防毒白名單後再試`,
        );
      }
      throw err2;
    }
  }
}

const worldIniPath = (rec: InstanceRecord, ctx: DriverContext) =>
  path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", configPlatformDir(rec), "PalWorldSettings.ini");
/** 「agent 上次寫進 PalWorldSettings.ini 的內容」快照,用來偵測使用者的手動編輯。 */
const worldAppliedPath = (ctx: DriverContext) => path.join(ctx.instanceDir, "world-applied.json");

/** 也供 route 層在世界設定 PUT 時即時落檔(native),讓檔案跟 store 同步。 */
export function writeWorldIni(rec: InstanceRecord, ctx: DriverContext): void {
  writeIni(rec, ctx);
}

function writeIni(rec: InstanceRecord, ctx: DriverContext): void {
  const configDir = path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", configPlatformDir(rec));
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "PalWorldSettings.ini"), renderPalWorldSettingsIni(rec.settings));
  // 記下這次寫入的內容;下次開機用它比對出「哪些是使用者手動改的」(見 detectManualIniEdits)。
  try {
    fs.writeFileSync(worldAppliedPath(ctx), JSON.stringify(rec.settings));
  } catch {
    /* 存不進去頂多下次偵測不到手動編輯,不致命 */
  }
  applyEngineIni(configDir, rec);
}

/**
 * 開機前偵測使用者「手動改了 PalWorldSettings.ini」的部分,回傳要併回 store 的 patch。
 * 比對「現在的檔案」與「agent 上次寫入的快照」:有差 = 使用者手動改的,尊重它(併回 store,
 * 這樣不會被開機時的重寫蓋掉,GUI 也會同步顯示)。若沒有上次快照(採用既有安裝 / 首次啟動),
 * 就整份匯入現有檔案,避免用預設值蓋掉伺服器本來的設定。檔案不存在則回空(交給 writeIni 建立)。
 * store 更新在 route 層做(driver 不碰 store),所以這裡只負責算出 patch。
 */
export function detectManualIniEdits(rec: InstanceRecord, ctx: DriverContext): Partial<WorldSettings> {
  return diffIniAgainstSnapshot(
    (p) => fs.readFileSync(p, "utf8"),
    worldIniPath(rec, ctx),
    worldAppliedPath(ctx),
  );
}

/**
 * 每次啟動前重寫 Engine.ini:把 store 裡的受管理微調 + 唯一的 Steam 查詢埠合併回檔案。
 * 為什麼要每次重套:伺服器關機時 UE 會把 Engine.ini 重寫回它自己的預設,所以使用者
 * 存的微調在一輪 start→stop 後就沒了。這裡在開機前一刻把它們補回去,保證這一輪生效;
 * store 才是權威來源,檔案只是拋棄式的套用結果。合併皆就地進行,不覆蓋未受管理的區塊。
 */
function applyEngineIni(configDir: string, rec: InstanceRecord): void {
  if (!rec.engineSettings && !rec.queryPort) return;
  const file = path.join(configDir, "Engine.ini");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Engine.ini 尚未存在,從空白建立。
  }
  if (rec.engineSettings && Object.keys(rec.engineSettings).length) {
    raw = mergeEnginePatch(raw, rec.engineSettings);
  }
  // 查詢埠不是受管理的 Engine 微調 key,用通用 ini setter 單獨寫入 [OnlineSubsystemSteam]。
  if (rec.queryPort) {
    raw = setIniKey(raw, "OnlineSubsystemSteam", "GameServerQueryPort", String(rec.queryPort));
  }
  fs.writeFileSync(file, raw);
}

/** 在指定 [section] 底下設定 key=value:key 已存在就替換該行,section 存在就插入其下,
 * 都沒有就把整個區塊補到檔尾。刻意不解析成物件,以免破壞其他區塊的排版與註解。 */
function setIniKey(raw: string, section: string, key: string, value: string): string {
  const lines = raw.split(/\r?\n/);
  const header = `[${section}]`;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`, "i");
  let sectionAt = -1;
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\[.+\]$/.test(trimmed)) {
      inSection = trimmed === header;
      if (inSection) sectionAt = i;
      continue;
    }
    if (inSection && keyRe.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      return lines.join("\n");
    }
  }
  if (sectionAt >= 0) {
    lines.splice(sectionAt + 1, 0, `${key}=${value}`);
    return lines.join("\n");
  }
  const prefix = raw.trim() ? `${raw.replace(/\s*$/, "")}\n\n` : "";
  return `${prefix}[${section}]\n${key}=${value}\n`;
}

/** Instances with a server download in flight (install/update runs in the
 * background so the request returns immediately). */
const installing = new Set<string>();

export const isInstalling = (id: string) => installing.has(id);

/** 安裝/更新進度(0–100,DepotDownloader 輸出解析)。不在安裝中則無條目。 */
const installProgress = new Map<string, number>();

export const installProgressOf = (id: string): number | null => installProgress.get(id) ?? null;

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
 * 重灌用:清掉遊戲本體檔案,但完整保留 Pal/Saved 子樹 —— 世界存檔(SaveGames/)
 * 與設定檔(Config/<平台>/ 的 PalWorldSettings.ini、Engine.ini、GameUserSettings.ini)
 * 全部原地不動、不搬移(沒有搬移失敗的風險窗口)。
 * 其餘一律刪除:Pal/Binaries、Pal/Content、Engine/、steamapps、.DepotDownloader
 * (manifest 也清,確保全新下載)——注意這包含使用者裝的模組(UE4SS/PalDefender/pak),
 * 重灌後需要重新安裝,UI 文案要明講。
 */
/** Windows 上遞迴清掉唯讀屬性(chmod 在 Windows 只影響 read-only bit)。
 *  遊戲檔案偶有唯讀檔(如 dbghelp.dll),unlink 會 EPERM。 */
function clearReadonly(target: string): void {
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) return;
  try {
    fs.chmodSync(target, st.isDirectory() ? 0o777 : 0o666);
  } catch {
    /* 清不掉就交給重試 */
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) clearReadonly(path.join(target, e));
  }
}

/** rm -rf,對 Windows 防呆:防毒短暫鎖檔用 maxRetries 撐過;唯讀檔(EPERM)
 *  先清 read-only 屬性再重試一次(實例:dbghelp.dll 唯讀導致 unlink EPERM)。 */
function rmrfRobust(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    clearReadonly(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

function wipeGameFiles(root: string, appendLog: (line: string) => void): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "Pal") {
      const palDir = path.join(root, "Pal");
      for (const sub of fs.readdirSync(palDir, { withFileTypes: true })) {
        if (sub.name === "Saved") continue; // 存檔與設定檔的家,絕不碰
        rmrfRobust(path.join(palDir, sub.name));
      }
    } else {
      rmrfRobust(path.join(root, entry.name));
    }
  }
  appendLog("[palserver] 已刪除遊戲本體檔案(Pal/Saved 存檔與設定檔完整保留)");
}

/**
 * Re-run DepotDownloader over an existing install to pull the latest content.
 * Runs in the background: the instance reports "installing" and the agent log
 * stream carries the progress. The caller must ensure the server is stopped.
 * @param fresh 重灌模式:先刪除遊戲本體(保留 Pal/Saved)再全新下載 —— 給
 *              「更新一直失敗」的使用者;呼叫端負責先備份世界存檔。
 */
export function updateServer(rec: InstanceRecord, ctx: DriverContext, fresh = false): void {
  if (installing.has(rec.id)) return;
  installing.add(rec.id);
  installProgress.set(rec.id, 0);
  installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
  // 保留最近的非進度輸出:失敗時直接附進錯誤訊息(agent 日誌已不在 UI 提供,
  // 使用者看不到 server.log;死因要當場交代,不能叫人翻檔案)
  const recent: string[] = [];
  const appendLog = (line: string) => {
    fs.appendFileSync(logFile(ctx), line + "\n");
    if (!DD_PROGRESS_RE.test(line)) {
      recent.push(line);
      if (recent.length > 15) recent.shift();
    }
  };
  void (async () => {
    try {
      fs.mkdirSync(ctx.instanceDir, { recursive: true });
      appendLog(fresh ? "[palserver] 開始重灌伺服器(刪除本體後重新下載)…" : "[palserver] 開始更新伺服器…");
      // 先清掉鎖住伺服器檔案的殘留行程(崩潰後的 CrashReportClient / 殭屍 PalServer),
      // 否則 DepotDownloader 開檔 IOException、重灌刪檔 EPERM
      await killLeftoverProcessesUnder(rec, serverRoot(rec, ctx), appendLog);
      if (fresh) wipeGameFiles(serverRoot(rec, ctx), appendLog);
      await runDepotDownloaderWithRecovery(serverRoot(rec, ctx), serverPlatform(rec) === "windows" ? "windows" : "linux", appendLog, (pct) =>
        installProgress.set(rec.id, pct),
      );
      appendLog("[palserver] 更新完成");
    } catch (err) {
      const info = classifyInstallError(err);
      const tail = recent.slice(-10).join("\n").trim();
      installErrors.set(
        rec.id,
        info.code === "disk-full" || !tail
          ? info
          : { ...info, message: `${info.message}\n─ 下載器輸出(尾段)─\n${tail}` },
      );
      appendLog(
        info.code === "disk-full"
          ? "[palserver] 更新失敗:磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。"
          : `[palserver] 更新失敗:${info.message}`,
      );
    } finally {
      installing.delete(rec.id);
      installProgress.delete(rec.id);
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
  const { alive, pid } = await checkAlive(ctx);
  if (alive && pid !== null) return { status: "running", runtimeId: String(pid) };
  if (pid !== null) return { status: "exited", runtimeId: null };
  return { status: "created", runtimeId: null };
}

// ── 精準的伺服器生命週期 webhook 事件(取代 supervisor 30s 輪詢的粗略判斷)──
// starting:spawn 當下發。running:啟動後探測遊戲 REST /info,第一次通=真的可連才發。
// exited/crash:child exit 事件即時發,靠 expectedStops 分辨「我們要求的停止」vs 崩潰。
// agent 重啟後 detached 存活的行程沒有 child handle → 由 supervisor 輪詢兜底(見 supervisor.ts)。
type ServerChild = ReturnType<typeof spawn>;
const serverChildren = new Map<string, ServerChild>();
const expectedStops = new Set<string>();
const readyProbes = new Map<string, NodeJS.Timeout>();
const READY_PROBE_MS = 3_000;
const READY_PROBE_MAX = 40; // 逾此(~2 分鐘)即使 REST 未通也兜底發一次 running

/** child 結束時判定「正常停止」vs「崩潰」:被我們要求停 或 exit code 0 = 正常;被 signal 砍
 *  或 exit code 非 0 = 崩潰。純函式,方便測試。 */
export function classifyServerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  expected: boolean,
): "exited" | "crash" {
  if (expected) return "exited";
  if (signal) return "crash";
  return code === 0 ? "exited" : "crash";
}

/** 啟動後每 3s 探測遊戲 REST /info;第一次成功 = 遊戲真的可連 → 發 server.running。
 *  逾時(REST/RCON 未開)兜底發一次。行程中途結束由 exit handler 取消本探測。 */
function startReadyProbe(rec: InstanceRecord): void {
  const existing = readyProbes.get(rec.id);
  if (existing) clearInterval(existing);
  let attempts = 0;
  const timer = setInterval(() => {
    void (async () => {
      attempts += 1;
      let version: string | undefined;
      let reachable = false;
      try {
        const info = await rest.info(rec);
        reachable = !!info;
        version = info?.version;
      } catch {
        reachable = false;
      }
      if (!readyProbes.has(rec.id)) return; // 已被 exit handler 取消
      if (reachable || attempts >= READY_PROBE_MAX) {
        clearInterval(timer);
        readyProbes.delete(rec.id);
        if (serverChildren.has(rec.id)) {
          emitAgentEvent("server.running", rec.id, version ? { version } : {});
        }
      }
    })();
  }, READY_PROBE_MS);
  timer.unref();
  readyProbes.set(rec.id, timer);
}

async function spawnServer(rec: InstanceRecord, ctx: DriverContext): Promise<void> {
  writeIni(rec, ctx);
  const root = serverRoot(rec, ctx);

  const serverArgs = [
    `-port=${rec.gamePort}`,
    // 每台唯一的 Steam 查詢埠;不帶的話全部搶 27015,第二台就死在 ::bind。
    ...(rec.queryPort ? [`-queryport=${rec.queryPort}`] : []),
    // 其餘啟動參數(publiclobby / 效能旗標 / logformat…)由使用者在面板設定;
    // publiclobby 預設開啟(維持舊行為),見 LAUNCH_OPTIONS。
    ...buildLaunchArgs(rec.launchOptions),
  ];

  // 直接啟動「真正的」伺服器執行檔(shipping),而非 PalServer.exe launcher —— launcher
  // 會另開一個帶自己 console 的子行程,那個 console 才是遊戲日誌、我們接不到。直接啟動
  // shipping 才能把它的 stdout/stderr 導進 game.log(唯一拿得到原生日誌的方式)。找不到
  // shipping(佈局不同/未來改版)就退回 launcher —— 伺服器照常啟動,只是遊戲日誌會是空的。
  const isWine = serverPlatform(rec) === "windows" && !IS_WIN;
  const shipping = shippingExe(root, rec);
  const useShipping = fs.existsSync(shipping);
  const launcher = serverLauncher(rec);
  const exe = useShipping ? shipping : path.join(root, launcher);
  // shipping 需要第一個參數是 UE 專案名(launcher 平常會幫你帶上)。
  const args = useShipping ? ["Pal", ...serverArgs] : serverArgs;

  // DepotDownloader(與從別處複製來的 adopt 安裝)在 Linux 不會保留可執行位元。
  // Wine 跑的是 Windows .exe,不需要 chmod。
  if (!IS_WIN && !isWine) fs.chmodSync(exe, 0o755);

  // 繞過 PalServer.sh 直接啟動 shipping 時,要補做該腳本的開場工作:把 Steam 的
  // linux64/steamclient.so 放到執行檔旁,否則伺服器載入不到 steamclient。
  // (Wine 跑 Windows binary,不需要 steamclient.so。)
  if (useShipping && !IS_WIN && !isWine) {
    const scSrc = path.join(root, "linux64", "steamclient.so");
    const scDst = path.join(root, "Pal", "Binaries", "Linux", "steamclient.so");
    if (fs.existsSync(scSrc) && !fs.existsSync(scDst)) fs.copyFileSync(scSrc, scDst);
  }

  // 決定 spawn 方式:Wine → wine exe;ARM64 → 轉譯器;否則直接 exe。
  let spawnExe = exe;
  let spawnArgs = args;
  if (isWine) {
    spawnArgs = [exe, ...args];
    spawnExe = "wine";
  } else if (IS_LINUX_ARM64) {
    const emulator = findX64Emulator();
    if (!emulator) {
      throw new Error(
        "這台是 ARM64 主機,而 Palworld 官方伺服器只有 x86-64 版,需要 FEX 轉譯器才能啟動 — " +
          `請安裝 FEX(ppa:fex-emu/fex)並跑一次 FEXRootFSFetcher -y -x 後重試;` +
          `免 root 安裝可把 FEXInterpreter 等執行檔放到 ${path.join(DATA_DIR, "tools", "fex")}/`,
      );
    }
    spawnArgs = [exe, ...args];
    spawnExe = emulator;
  }

  const viaHint = isWine ? "(via Wine)" : IS_LINUX_ARM64 ? "(經 x86-64 轉譯器)" : "";
  fs.appendFileSync(
    logFile(ctx),
    `[palserver] starting ${useShipping ? "PalServer (shipping, 日誌已擷取)" : "PalServer launcher(找不到 shipping,遊戲日誌將為空)"}${viaHint}...\n`,
  );
  // 遊戲 console 輸出 → game.log(每次開機重來一份,UE 本來也是一次一份)。
  const gameOut = fs.openSync(gameLogFile(ctx), "w");
  const child = spawn(spawnExe, spawnArgs, {
    cwd: root,
    detached: true, // survives agent restarts; we track it via the pid file
    stdio: ["ignore", gameOut, gameOut],
    windowsHide: true, // 別讓伺服器行程在 Windows 彈出主控台視窗(日誌已導到 game.log)。
  });
  fs.closeSync(gameOut);
  if (!child.pid) throw new Error("failed to spawn PalServer");
  child.unref();
  // 記下 PID + 建立時間當身分指紋,之後 isAlive/停止前都靠它辨認,避免 PID 重用誤殺。
  const id = await processIdentity(child.pid).catch(() => null);
  writePidRecord(ctx, { pid: child.pid, startedAt: id?.startedAt ?? null });

  // 精準生命週期:spawn = starting;掛 exit 事件;啟動 REST readiness 探測。
  emitAgentEvent("server.starting", rec.id, {});
  serverChildren.set(rec.id, child);
  child.on("exit", (code, signal) => {
    if (serverChildren.get(rec.id) === child) serverChildren.delete(rec.id);
    const probe = readyProbes.get(rec.id);
    if (probe) {
      clearInterval(probe);
      readyProbes.delete(rec.id);
    }
    if (expectedStops.delete(rec.id)) {
      // 我們主動要求的停止(且已 sweep 殘留行程)→ 直接發 exited。
      emitAgentEvent("server.exited", rec.id, { code: code ?? undefined });
    } else {
      // 非預期退出:child exit 未必代表伺服器真的掛了(Windows 上 shipping 可能 spawn 真正的
      // 伺服器子行程後自己退出、或啟動途中 re-exec 換 PID)。先確認再發,避免誤報「已停止」。
      void verifyThenEmitExit(rec, ctx, code, signal);
    }
  });
  startReadyProbe(rec);
}

/** child exit 後,以 getNativeStatus(GUI 也用它,是可靠來源)確認伺服器是否真的掛了才發 exited/crash;
 *  仍在跑(re-exec/子行程接手)就當誤報、不發。等幾秒讓過渡狀態落定。 */
async function verifyThenEmitExit(
  rec: InstanceRecord,
  ctx: DriverContext,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let status: InstanceStatus;
    try {
      status = (await getNativeStatus(rec, ctx)).status;
    } catch {
      continue;
    }
    if (status === "running") return; // 其實還活著 → 誤報,不發
    // 非 running 且非過渡態(starting/restarting/installing)→ 確定掛了,跳出去發。
    if (status !== "starting" && status !== "restarting" && status !== "installing") break;
  }
  const kind = classifyServerExit(code, signal, false);
  emitAgentEvent(kind === "crash" ? "server.crash" : "server.exited", rec.id, {
    code: code ?? undefined,
    ...(kind === "crash" && signal ? { detail: `signal ${signal}` } : {}),
  });
}

/** 每實例的 CPU 取樣歷史(instanceDir → 上一筆);行程結束就清掉。 */
interface CpuSample {
  /** 全行程樹的累計 CPU 時間(毫秒;pidusage 的 ctime 加總) */
  ctimeMs: number;
  /** 取樣時刻(Date.now() 毫秒) */
  at: number;
  stats: InstanceStats;
}
const cpuSamples = new Map<string, CpuSample>();

/** CPU%(單核基準,行程樹加總可破百;export 供單元測試):
 *  有上一筆且 ctime 沒回退(行程沒換)→ Δctime/Δt 毫秒精度差分;
 *  首次取樣或行程重啟(ctime 回退)/歷史過舊 → 退回「自開機以來平均」。 */
export function computeCpuPercent(
  prev: { ctimeMs: number; at: number } | null,
  ctimeMs: number,
  at: number,
  mainElapsedMs: number | null,
): number {
  const usable =
    prev !== null && ctimeMs >= prev.ctimeMs && at > prev.at && at - prev.at < 10 * 60_000;
  const ratio = usable
    ? (ctimeMs - prev.ctimeMs) / (at - prev.at)
    : mainElapsedMs && mainElapsedMs > 0
      ? ctimeMs / mainElapsedMs
      : 0;
  return Math.round(ratio * 1000) / 10; // 百分比,一位小數
}

/** 建立時選了「強化」(flavor=modded)的實例:伺服器檔案就緒後、啟動前,
 *  自動安裝 UE4SS + PalDefender(等同模組分頁的一鍵安裝)。已裝過就跳過;
 *  失敗不擋啟動(伺服器照樣以原生開起來),原因寫進日誌讓使用者到模組分頁重試。
 *  動態 import 避免 native ↔ mods 循環相依。 */
async function autoEnhance(
  rec: InstanceRecord,
  ctx: DriverContext,
  log: (line: string) => void,
): Promise<void> {
  if (rec.flavor !== "modded" || serverPlatform(rec) !== "windows") return;
  const mods = await import("./mods.js");
  for (const component of ["ue4ss", "paldefender"] as const) {
    try {
      const status = await mods.getModsStatus(rec, ctx);
      if (!status.supported) {
        log(`[palserver] 強化模組跳過:${status.reason}`);
        return;
      }
      if (status[component].installed) continue;
      log(`[palserver] 強化模式:安裝 ${component}…`);
      const { version } = await mods.installComponent(rec, ctx, component);
      log(`[palserver] ${component} ${version} 安裝完成`);
      if (component === "paldefender") {
        // 強化版預設開啟 PalDefender REST API 並先鋪好 GUI 權杖,首次開機即生效
        try {
          const pdRest = await import("./paldefender-rest.js");
          pdRest.preprovisionPdRest(rec, ctx);
          log("[palserver] PalDefender REST API 已預設啟用(埠 17993),GUI 權杖已就緒");
        } catch (err) {
          log(`[palserver] PalDefender REST 預設定失敗(可到 PalDefender 分頁手動開啟):${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log(
        `[palserver] ${component} 自動安裝失敗(伺服器仍以原生模式啟動,可到「模組」分頁重試):${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export const nativeDriver: ServerDriver = {
  status: getNativeStatus,

  async start(rec, ctx) {
    const current = await getNativeStatus(rec, ctx);
    // No-op guard: the caller may believe the old process is gone while it is
    // still exiting. Return false so restarts don't get reported as done.
    if (current.status === "running" || current.status === "installing") return false;

    fs.mkdirSync(ctx.instanceDir, { recursive: true });
    const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");

    const alreadyInstalled = fs.existsSync(path.join(serverRoot(rec, ctx), serverLauncher(rec)));
    if (alreadyInstalled) {
      // Fast path: spawn synchronously so errors surface in the response.
      await ensureInstalled(rec, ctx, appendLog); // validates adopted dirs
      await autoEnhance(rec, ctx, appendLog);
      await spawnServer(rec, ctx);
      installErrors.delete(rec.id); // 成功啟動,清掉上次的安裝失敗
      return true;
    }

    // Slow path: multi-GB download. Run in the background — the instance
    // reports "installing" and the log stream carries the progress.
    installing.add(rec.id);
    installProgress.set(rec.id, 0);
    installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
    // 同 updateServer:留最近輸出,失敗時附進錯誤訊息(UI 已無 agent 日誌來源)
    const recent: string[] = [];
    const installLog = (line: string) => {
      appendLog(line);
      if (!DD_PROGRESS_RE.test(line)) {
        recent.push(line);
        if (recent.length > 15) recent.shift();
      }
    };
    void (async () => {
      try {
        await ensureInstalled(rec, ctx, installLog, (pct) => installProgress.set(rec.id, pct));
        await autoEnhance(rec, ctx, installLog);
        await spawnServer(rec, ctx);
      } catch (err) {
        const info = classifyInstallError(err);
        const tail = recent.slice(-10).join("\n").trim();
        installErrors.set(
          rec.id,
          info.code === "disk-full" || !tail
            ? info
            : { ...info, message: `${info.message}\n─ 下載器輸出(尾段)─\n${tail}` },
        );
        appendLog(
          info.code === "disk-full"
            ? "[palserver] 安裝失敗:磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。"
            : `[palserver] install/start failed: ${info.message}`,
        );
      } finally {
        installing.delete(rec.id);
        installProgress.delete(rec.id);
      }
    })();
    return true;
  },

  async stop(rec, ctx) {
    // 停止時一律順手清掉「執行檔在本實例伺服器目錄下」的殘留行程:
    // 崩潰後的 CrashReportClient / 殭屍 PalServer 不在 pid 檔追蹤範圍,
    // 卻會鎖住 dbghelp.dll 等檔案,擋住之後的更新/重灌。
    const sweepLeftovers = () =>
      killLeftoverProcessesUnder(rec, serverRoot(rec, ctx), (line) =>
        fs.appendFileSync(logFile(ctx), line + "\n"),
      );

    const { alive, pid } = await checkAlive(ctx);
    // 沒在跑(或 pid 檔的號碼已被別的行程重用)→ 只清掉 pid 檔,絕不 taskkill。
    // 這正是「動一台卻關掉另一台」的根因:陳舊 pid 檔 + Windows PID 重用。
    if (!alive || pid === null) {
      fs.rmSync(pidFile(ctx), { force: true });
      await sweepLeftovers();
      return;
    }

    // 這是我們主動要求的停止:標記一下,讓 child exit handler 把退出判為正常(exited)而非崩潰。
    expectedStops.add(rec.id);

    if (await requestGracefulShutdown(rec)) {
      // 等它自己收 —— 這期間用便宜的 isAlive 即可:行程還活著就不可能被重用。
      for (let i = 0; i < 20 && isAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // 真的要硬砍前,再驗一次身分 + 確認映像名是 PalServer,避免這半秒內 PID 剛好被重用。
    if (isAlive(pid)) {
      const id = await processIdentity(pid);
      const record = readPidRecord(ctx);
      const stillOurs = !!id && (record?.startedAt == null || id.startedAt === record.startedAt);
      const isPalServer = !IS_WIN || /palserver/i.test(id?.image ?? "");
      if (stillOurs && isPalServer) {
        await killTree(pid);
        // killTree 在 POSIX 只送 SIGTERM、不等退出 —— 必須等程序死透才能清
        // pid 檔,否則下一個 start() 的「還在跑就 no-op」防護會被繞過,
        // 疊出搶同一組埠的雙程序。逾時就升級 SIGKILL 再等一輪。
        for (let i = 0; i < 20 && isAlive(pid); i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!IS_WIN && isAlive(pid)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
          for (let i = 0; i < 10 && isAlive(pid); i++) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    }
    fs.rmSync(pidFile(ctx), { force: true });
    await sweepLeftovers();
    // agent 重啟後 detached 存活的行程沒有 child handle → exit event 不會發,這裡兜底補一次
    // server.exited;有 handle 的正常情況由 exit handler 發(此條件為 false,不會重複)。
    if (!serverChildren.has(rec.id) && expectedStops.delete(rec.id)) {
      emitAgentEvent("server.exited", rec.id, {});
    }
  },

  async remove(rec, ctx) {
    await this.stop(rec, ctx);
    // 真正刪除:agent 自管的安裝與存檔連同 instanceDir 一起刪(由 route 統一刪除
    // ctx.instanceDir)。若伺服器檔在 agent 自行安裝/搬移過去的外部目錄,那也是我們
    // 建立的、一併刪除;但「認領」的既有安裝(serverDirManaged=false)是使用者自己
    // 原本就有的目錄,絕不刪。
    if (rec.serverDir && rec.serverDirManaged) {
      fs.rmSync(rec.serverDir, { recursive: true, force: true });
    }
  },

  async stats(_rec, ctx) {
    // 用 checkAlive 而非裸 pid:PID 被別台重用時別回報鄰居的 CPU/記憶體。
    const live = await checkAlive(ctx);
    if (!live.alive || live.pid === null) {
      cpuSamples.delete(ctx.instanceDir);
      return null;
    }
    // 多個消費者(首頁進階顯示/效能分析頁/supervisor 記憶體檢查)各自輪詢:
    // 1.5 秒內重複查詢直接回上一筆,取樣間隔不會被並行輪詢切碎。
    const prev = cpuSamples.get(ctx.instanceDir);
    if (prev && Date.now() - prev.at < 1500) return prev.stats;

    const pid = live.pid;
    // PalServer.exe is a thin launcher; the actual server is a child process
    // (PalServer-Win64-Shipping-Cmd.exe), so aggregate the whole tree.
    const pids = [pid, ...(await listDescendants(pid))];
    const { default: pidusage } = await import("pidusage");
    const usages = await Promise.all(
      pids.map((p) => pidusage(p).catch(() => null)),
    );
    const alive = usages.filter((u) => u !== null);
    if (alive.length === 0) {
      cpuSamples.delete(ctx.instanceDir);
      return null;
    }
    // 主行程(pids[0])的 elapsed 就是伺服器運行時間;pidusage 以毫秒回報。
    const mainElapsed = usages[0]?.elapsed;
    // CPU% 不用 pidusage 的 cpu 欄位:它在 Windows 以 os.uptime()(整秒)算間隔,
    // 短輪詢誤差極大(實測 3 秒內 78%→36%→0%),且其 per-pid 歷史會被多個輪詢互踩。
    // 改用 ctime(累計 CPU 毫秒,與取樣間隔無關)配 Date.now() 毫秒精度自算差分。
    const ctimeMs = alive.reduce((sum, u) => sum + u.ctime, 0);
    const at = Date.now();
    const cpuPercent = computeCpuPercent(prev ?? null, ctimeMs, at, mainElapsed ?? null);
    const stats = {
      cpuPercent,
      cpuCores: os.cpus().length,
      memoryBytes: alive.reduce((sum, u) => sum + u.memory, 0),
      memoryLimitBytes: os.totalmem(),
      processCount: alive.length,
      uptimeSeconds: mainElapsed ? Math.round(mainElapsed / 1000) : undefined,
    } satisfies InstanceStats;
    cpuSamples.set(ctx.instanceDir, { ctimeMs, at, stats });
    return stats;
  },

  logSources(rec, ctx) {
    // 裝了 PalDefender 就只給它的日誌(有玩家加入/離開/聊天/死亡等事件,最有料);
    // 沒裝才退回原生遊戲 console 日誌。agent 自己的 server.log 不再對外當日誌來源。
    if (palDefenderLogDir(rec, ctx) !== null) {
      return [{ id: "paldefender" as const, label: "PalDefender", available: true }];
    }
    return [{ id: "game" as const, label: "遊戲(原生)", available: fs.existsSync(gameLogFile(ctx)) }];
  },

  async streamLogs(rec, ctx, onLine, _onEnd, source = "agent", replay = 200) {
    // Files may not exist yet (first boot) — the followers attach when they
    // appear, so the socket stays open instead of closing early.
    if (source === "game") return followFile(gameLogFile(ctx), onLine, replay);
    if (source === "paldefender") {
      const dir = palDefenderLogDir(rec, ctx);
      if (!dir) {
        onLine("(找不到 PalDefender 日誌 — 安裝後啟動一次伺服器即會產生)");
        return () => {};
      }
      // PalDefender writes a new, timestamped file per run; follow the newest
      // and switch over when it rotates.
      return followNewestInDir(dir, onLine, replay);
    }
    // "agent": our own capture — install progress and server stdout.
    return followFile(logFile(ctx), onLine, replay);
  },
};

/**
 * 遊戲日誌 = 我們親自擷取的伺服器 console 輸出(見 spawnServer)。
 * 注意:Palworld 專用伺服器預設「不寫任何日誌檔」(連 -log 都沒用),所有輸出只進 stdout;
 * 所以不能讀 Pal/Saved/Logs/Pal.log(永遠不存在),而是由 agent 把 stdout 導進這個檔。
 */
const gameLogFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "game.log");

/** 真正的遊戲執行檔(不是 launcher)。它的 stdout 才是遊戲日誌;PalServer.exe 只是
 *  轉手再開一個帶自己 console 的子行程,那個 console 的輸出我們接不到。
 *  Wine(modded)時指 Win64 shipping exe(Windows binary),否則依平台。 */
const shippingExe = (root: string, rec: InstanceRecord): string =>
  serverPlatform(rec) === "windows"
    ? path.join(root, "Pal", "Binaries", "Win64", "PalServer-Win64-Shipping-Cmd.exe")
    : path.join(root, "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping");

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

/** Last few non-empty lines of PalDefender's newest log — a hint for why it
 * aborted startup, surfaced in the "startup failure" restart event. Empty when
 * there's no log dir/file. Pass `sinceMs` to only consider files written after
 * that time — PalDefender writes one file per run, so without the filter the
 * newest file may be the *previous* process's log and mislead diagnosis. */
export function newestPalDefenderLogLines(
  rec: InstanceRecord,
  ctx: DriverContext,
  n = 3,
  sinceMs?: number,
): string[] {
  const dir = palDefenderLogDir(rec, ctx);
  if (!dir) return [];
  const file = newestFile(dir, sinceMs);
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

function newestFile(dir: string, sinceMs?: number): string | null {
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .filter((e) => sinceMs === undefined || e.mtime >= sinceMs)
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.full ?? null;
  } catch {
    return null;
  }
}

/** Follow whichever file in `dir` is newest, re-attaching when it rotates. */
function followNewestInDir(dir: string, onLine: (line: string) => void, replay = 200): () => void {
  let current: string | null = null;
  let stopCurrent: (() => void) | null = null;
  const timer = setInterval(() => {
    const newest = newestFile(dir);
    if (newest && newest !== current) {
      stopCurrent?.();
      current = newest;
      // A rotation mid-run means a new server process — replay a little so the
      // consumer doesn't miss lines written between polls (UI wants context;
      // replay=0 consumers still get only genuinely new lines going forward).
      onLine(`— 跟隨日誌檔:${path.basename(newest)} —`);
      stopCurrent = followFile(newest, onLine, replay);
    }
  }, 1000);
  const initial = newestFile(dir);
  if (initial) {
    current = initial;
    stopCurrent = followFile(initial, onLine, replay);
  }
  return () => {
    clearInterval(timer);
    stopCurrent?.();
  };
}

/** Tail -f a file: replay the last `replay` lines once it exists, then
 * follow appended bytes. Handles truncation/rotation (position reset) and
 * files that appear later. Returns a cleanup fn. */
/** attach 時要補送哪些既有行:replay>0 給最後 replay 行(UI 補脈絡用),replay=0 完全不補。
 *  ⚠️ 陷阱:`arr.slice(-0)` === `arr.slice(0)` === 整個陣列(因 `-0 === 0`);replay=0 必須明確回 []。
 *  之前這裡直接 `slice(-replay)`,replay=0 的 log-event-tracker 一 attach 就把整個當下 log 全部
 *  當新事件重發(重啟時舊捕捉/死亡誤報的根因)。純函式,方便回歸測試。 */
export function linesToReplay(existing: string[], replay: number): string[] {
  return replay > 0 ? existing.slice(-replay) : [];
}

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
      // replay=0(如 log-event-tracker)只跟新行,連讀檔都跳過、直接位移到檔尾;
      // replay>0(如 UI log 視窗)才讀出既有行、補送最後 replay 行。
      const existing = replay > 0 ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      for (const line of linesToReplay(existing, replay)) onLine(line);
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
