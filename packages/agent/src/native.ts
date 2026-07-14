import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import { buildLaunchArgs, type InstallError, type InstanceStats, type InstanceStatus, type WorldSettings } from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { renderPalWorldSettingsIni, parsePalWorldSettingsIni } from "./settings-ini.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";
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
  onProgress?: (percent: number) => void,
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
  await runDepotDownloader(dd, root, onLine, onProgress);
}

/** DepotDownloader / OS 在磁碟寫滿時吐的字樣(跨平台、含 .NET IOException)。 */
const DISK_FULL_RE =
  /no space left on device|not enough space|disk( is)? full|enospc|there is not enough space on the disk|0x70|System\.IO\.IOException.*space/i;

/** 標成磁碟不足的錯誤;前端據 code 顯示友善提示。 */
function diskFullError(): Error & { code: "disk-full" } {
  return Object.assign(new Error("磁碟空間不足"), { code: "disk-full" as const });
}

/** DepotDownloader 每完成一個檔案吐一行「 12.34% 檔案路徑」(累計進度)。
 *  抓行首百分比;某些 locale 小數點是逗號,一併接受。 */
const DD_PROGRESS_RE = /^\s*(\d{1,3}(?:[.,]\d+)?)%\s/;

/** Download/update the dedicated server into `root`. Also used by updateServer. */
function runDepotDownloader(
  dd: string,
  root: string,
  onLine: (line: string) => void,
  onProgress?: (percent: number) => void,
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
      // 非零離開 + 看到磁碟不足字樣 = 幾乎確定是空間問題,給前端可翻譯的 code。
      reject(sawDiskFull ? diskFullError() : new Error(`DepotDownloader exited with code ${code}`));
    });
  });
}

const worldIniPath = (rec: InstanceRecord, ctx: DriverContext) =>
  path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", CONFIG_PLATFORM_DIR, "PalWorldSettings.ini");
/** 「agent 上次寫進 PalWorldSettings.ini 的內容」快照,用來偵測使用者的手動編輯。 */
const worldAppliedPath = (ctx: DriverContext) => path.join(ctx.instanceDir, "world-applied.json");

function writeIni(rec: InstanceRecord, ctx: DriverContext): void {
  const configDir = path.join(serverRoot(rec, ctx), "Pal", "Saved", "Config", CONFIG_PLATFORM_DIR);
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
  let iniRaw: string;
  try {
    iniRaw = fs.readFileSync(worldIniPath(rec, ctx), "utf8");
  } catch {
    return {};
  }
  const fileSettings = parsePalWorldSettingsIni(iniRaw);
  let last: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(worldAppliedPath(ctx), "utf8")) as unknown;
    if (j && typeof j === "object") last = j as Record<string, unknown>;
  } catch {
    /* 沒有快照 */
  }
  if (!last) return fileSettings; // 首次 / 採用既有安裝:整份尊重現有檔案
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fileSettings)) {
    if (last[k] !== v) patch[k] = v; // 檔案與上次寫入不同 → 使用者手動改的
  }
  return patch as Partial<WorldSettings>;
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
 * Re-run DepotDownloader over an existing install to pull the latest content.
 * Runs in the background: the instance reports "installing" and the agent log
 * stream carries the progress. The caller must ensure the server is stopped.
 */
export function updateServer(rec: InstanceRecord, ctx: DriverContext): void {
  if (installing.has(rec.id)) return;
  installing.add(rec.id);
  installProgress.set(rec.id, 0);
  installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
  const appendLog = (line: string) => fs.appendFileSync(logFile(ctx), line + "\n");
  void (async () => {
    try {
      fs.mkdirSync(ctx.instanceDir, { recursive: true });
      appendLog("[palserver] 開始更新伺服器…");
      const dd = await ensureDepotDownloader();
      await runDepotDownloader(dd, serverRoot(rec, ctx), appendLog, (pct) =>
        installProgress.set(rec.id, pct),
      );
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
  const shipping = shippingExe(root);
  const useShipping = fs.existsSync(shipping);
  const exe = useShipping ? shipping : path.join(root, SERVER_LAUNCHER);
  // shipping 需要第一個參數是 UE 專案名(launcher 平常會幫你帶上)。
  const args = useShipping ? ["Pal", ...serverArgs] : serverArgs;

  // DepotDownloader(與從別處複製來的 adopt 安裝)在 Linux 不會保留可執行位元。
  if (!IS_WIN) fs.chmodSync(exe, 0o755);

  fs.appendFileSync(
    logFile(ctx),
    `[palserver] starting ${useShipping ? "PalServer (shipping, 日誌已擷取)" : "PalServer launcher(找不到 shipping,遊戲日誌將為空)"}...\n`,
  );
  // 遊戲 console 輸出 → game.log(每次開機重來一份,UE 本來也是一次一份)。
  const gameOut = fs.openSync(gameLogFile(ctx), "w");
  const child = spawn(exe, args, {
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
      await spawnServer(rec, ctx);
      installErrors.delete(rec.id); // 成功啟動,清掉上次的安裝失敗
      return;
    }

    // Slow path: multi-GB download. Run in the background — the instance
    // reports "installing" and the log stream carries the progress.
    installing.add(rec.id);
    installProgress.set(rec.id, 0);
    installErrors.delete(rec.id); // 新的一次嘗試,清掉上次的失敗
    void (async () => {
      try {
        await ensureInstalled(rec, ctx, appendLog, (pct) => installProgress.set(rec.id, pct));
        await spawnServer(rec, ctx);
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
        installProgress.delete(rec.id);
      }
    })();
  },

  async stop(rec, ctx) {
    const { alive, pid } = await checkAlive(ctx);
    // 沒在跑(或 pid 檔的號碼已被別的行程重用)→ 只清掉 pid 檔,絕不 taskkill。
    // 這正是「動一台卻關掉另一台」的根因:陳舊 pid 檔 + Windows PID 重用。
    if (!alive || pid === null) {
      fs.rmSync(pidFile(ctx), { force: true });
      return;
    }

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
      if (stillOurs && isPalServer) await killTree(pid);
    }
    fs.rmSync(pidFile(ctx), { force: true });
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
    if (!live.alive || live.pid === null) return null;
    const pid = live.pid;
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
    // 裝了 PalDefender 就只給它的日誌(有玩家加入/離開/聊天/死亡等事件,最有料);
    // 沒裝才退回原生遊戲 console 日誌。agent 自己的 server.log 不再對外當日誌來源。
    if (palDefenderLogDir(rec, ctx) !== null) {
      return [{ id: "paldefender" as const, label: "PalDefender", available: true }];
    }
    return [{ id: "game" as const, label: "遊戲(原生)", available: fs.existsSync(gameLogFile(ctx)) }];
  },

  async streamLogs(rec, ctx, onLine, _onEnd, source = "agent") {
    // Files may not exist yet (first boot) — the followers attach when they
    // appear, so the socket stays open instead of closing early.
    if (source === "game") return followFile(gameLogFile(ctx), onLine, 200);
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

/**
 * 遊戲日誌 = 我們親自擷取的伺服器 console 輸出(見 spawnServer)。
 * 注意:Palworld 專用伺服器預設「不寫任何日誌檔」(連 -log 都沒用),所有輸出只進 stdout;
 * 所以不能讀 Pal/Saved/Logs/Pal.log(永遠不存在),而是由 agent 把 stdout 導進這個檔。
 */
const gameLogFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "game.log");

/** 真正的遊戲執行檔(不是 launcher)。它的 stdout 才是遊戲日誌;PalServer.exe 只是
 *  轉手再開一個帶自己 console 的子行程,那個 console 的輸出我們接不到。 */
const shippingExe = (root: string): string =>
  IS_WIN
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
 * there's no log dir/file. */
export function newestPalDefenderLogLines(rec: InstanceRecord, ctx: DriverContext, n = 3): string[] {
  const dir = palDefenderLogDir(rec, ctx);
  if (!dir) return [];
  const file = newestFile(dir);
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
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
