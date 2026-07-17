import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentUpdatePrefs, AgentUpdateStatus, UpdatePhase } from "@palserver/shared";
import { AGENT_VERSION, AUTO_UPDATE_DISABLED_BY_ENV, DATA_DIR, GITHUB_REPO } from "./env.js";

/**
 * GUI 自我更新:對接 GitHub Releases。
 *
 * 只有「免安裝執行檔」(Node SEA,見 scripts/build-sea.mjs)能自我更新 —— 它是一顆
 * 執行檔加旁邊的 web/,整包換掉即可。開發模式(node dist/index.js)不支援。
 *
 * 更新流程:下載對應平台的 .tar.gz → 比對 SHA256SUMS.txt → 解壓到暫存 →
 * 換掉執行檔與 web/ → 重新啟動自己。舊執行檔留成 .old-*(Windows 不能刪除
 * 執行中的檔案),下次開機再清掉。
 *
 * 安全性:一律驗證 SHA256(release 沒附 checksum 就拒絕更新);遊戲伺服器是
 * detached 生成的,agent 重啟不會影響它們,但安裝中(DepotDownloader 是 agent
 * 的子行程)時拒絕更新,以免中斷下載。
 */

const execFileP = promisify(execFile);

const PREFS_FILE = path.join(DATA_DIR, "update.json");
const CACHE_FILE = path.join(DATA_DIR, "update-check.json");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECKSUMS_ASSET = "SHA256SUMS.txt";

/** process.platform → release 資產名稱裡的平台字樣(見 .github/workflows/release.yml)。 */
const ASSET_PLATFORM: Record<string, string> = {
  win32: "windows",
  linux: "linux",
  darwin: "macos",
};

interface CachedCheck {
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  assetUrl: string | null;
  assetName: string | null;
  checksumsUrl: string | null;
  downloadSizeBytes: number | null;
  checkedAt: string;
  channel: AgentUpdatePrefs["channel"];
}

let phase: UpdatePhase = "idle";
let progress: number | null = null;
let lastError: string | null = null;

// ─────────────────────────── 偏好設定 ───────────────────────────

const defaultPrefs = (): Omit<AgentUpdatePrefs, "envDisabled"> => ({
  autoCheck: true,
  autoApply: false,
  // alpha/beta 版的使用者顯然想繼續收到 prerelease;正式版預設只看正式版。
  channel: /-(alpha|beta|rc)/.test(AGENT_VERSION) ? "prerelease" : "stable",
});

export function updatePrefs(): AgentUpdatePrefs {
  let saved: Partial<AgentUpdatePrefs> = {};
  try {
    saved = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
  } catch {
    /* 沒有檔案 = 用預設值 */
  }
  const base = defaultPrefs();
  return {
    autoCheck: saved.autoCheck ?? base.autoCheck,
    autoApply: saved.autoApply ?? base.autoApply,
    channel: saved.channel === "stable" || saved.channel === "prerelease" ? saved.channel : base.channel,
    envDisabled: AUTO_UPDATE_DISABLED_BY_ENV,
  };
}

export function setUpdatePrefs(patch: Partial<Omit<AgentUpdatePrefs, "envDisabled">>): AgentUpdatePrefs {
  const next = { ...updatePrefs(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    PREFS_FILE,
    JSON.stringify({ autoCheck: next.autoCheck, autoApply: next.autoApply, channel: next.channel }, null, 2),
  );
  return updatePrefs();
}

// ─────────────────────────── 版本比較 ───────────────────────────

/** "v2.0.0-alpha.1" → [2, 0, 0, "alpha", 1];沒有 prerelease 的排在後面(較新)。 */
function parseVersion(raw: string): { nums: number[]; pre: (string | number)[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** semver 排序:a 是否比 b 新。無法解析時一律回 false(寧可不更新)。 */
export function isNewer(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;

  for (let i = 0; i < 3; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] > vb.nums[i];
  }
  // 1.0.0 > 1.0.0-alpha:有 prerelease 的比較舊。
  if (va.pre.length === 0 || vb.pre.length === 0) return vb.pre.length > 0 && va.pre.length === 0;

  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return false; // 較短的 prerelease 較舊
    if (y === undefined) return true;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y;
    if (typeof x === "number") return false; // 數字比字串小
    if (typeof y === "number") return true;
    return String(x) > String(y);
  }
  return false;
}

// ─────────────────────── 能不能自我更新 ───────────────────────

/**
 * 免安裝執行檔的路徑,以及它旁邊的 web/。開發模式(用 node 跑 dist/index.js)
 * 時 execPath 是 node 本身 —— 那種情況不該去覆蓋使用者的 node。
 */
function installLayout(): { exePath: string; webDir: string } | null {
  const exePath = process.execPath;
  const base = path.basename(exePath).toLowerCase();
  if (base !== "palserver-agent" && base !== "palserver-agent.exe") return null;
  return { exePath, webDir: path.join(path.dirname(exePath), "web") };
}

// ─────────────────────────── 檢查更新 ───────────────────────────

function readCache(): CachedCheck | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: GhAsset[];
}

/** 向 GitHub 問最新的 release;失敗時回傳磁碟上的舊結果(過時勝於空白)。 */
async function fetchLatestRelease(channel: AgentUpdatePrefs["channel"]): Promise<CachedCheck | null> {
  const cached = readCache();
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, {
      headers: { "User-Agent": `palserver-agent/${AGENT_VERSION}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const releases = (await res.json()) as GhRelease[];

    const candidates = releases
      .filter((r) => !r.draft && (channel === "prerelease" || !r.prerelease))
      .filter((r) => parseVersion(r.tag_name))
      .sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : 1));

    const latest = candidates[0] ?? null;
    const platform = ASSET_PLATFORM[process.platform];
    // 自我更新讀 .tar.gz(tar 在 Win10+/mac/Linux 都有);.zip 是給人手動下載的。
    const asset = latest?.assets.find((a) => a.name === `palserver-agent-${platform}.tar.gz`) ?? null;
    const checksums = latest?.assets.find((a) => a.name === CHECKSUMS_ASSET) ?? null;

    const info: CachedCheck = {
      latestVersion: latest ? latest.tag_name.replace(/^v/, "") : null,
      releaseUrl: latest?.html_url ?? null,
      releaseNotes: latest?.body?.trim() || null,
      publishedAt: latest?.published_at ?? null,
      assetUrl: asset?.browser_download_url ?? null,
      assetName: asset?.name ?? null,
      checksumsUrl: checksums?.browser_download_url ?? null,
      downloadSizeBytes: asset?.size ?? null,
      checkedAt: new Date().toISOString(),
      channel,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(info, null, 2));
    return info;
  } catch {
    return cached;
  }
}

export async function getUpdateStatus(force = false): Promise<AgentUpdateStatus> {
  const prefs = updatePrefs();
  const layout = installLayout();

  const base: AgentUpdateStatus = {
    supported: layout !== null,
    reason: layout
      ? undefined
      : "自我更新僅支援免安裝執行檔版本(開發模式請用 git pull + pnpm build)",
    currentVersion: AGENT_VERSION,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseNotes: null,
    publishedAt: null,
    downloadSizeBytes: null,
    checkedAt: null,
    phase,
    progress,
    lastError,
    prefs,
  };

  const cached = readCache();
  const fresh =
    cached &&
    cached.channel === prefs.channel &&
    Date.now() - Date.parse(cached.checkedAt) < CHECK_TTL_MS;
  const info = !force && fresh ? cached : await fetchLatestRelease(prefs.channel);
  if (!info) return { ...base, reason: base.reason ?? "無法連上 GitHub 檢查更新" };

  const available = info.latestVersion !== null && isNewer(info.latestVersion, AGENT_VERSION);
  return {
    ...base,
    latestVersion: info.latestVersion,
    updateAvailable: available,
    releaseUrl: info.releaseUrl,
    releaseNotes: info.releaseNotes,
    publishedAt: info.publishedAt,
    downloadSizeBytes: info.downloadSizeBytes,
    checkedAt: info.checkedAt,
    reason:
      base.reason ??
      (available && !info.assetUrl
        ? `這個版本沒有 ${process.platform} 的更新檔,請到 GitHub 手動下載`
        : undefined),
  };
}

// ─────────────────────────── 套用更新 ───────────────────────────

async function download(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": `palserver-agent/${AGENT_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`下載失敗:HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (total > 0) onProgress(Math.min(99, Math.round((seen / total) * 100)));
  });
  await pipeline(body, fs.createWriteStream(dest));
}

const sha256 = async (file: string): Promise<string> => {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
};

/** SHA256SUMS.txt 是 `<hex>  <filename>` 一行一個(sha256sum 的標準格式)。 */
function expectedHash(sums: string, assetName: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2]) === assetName) return m[1].toLowerCase();
  }
  return null;
}

/** 更新需要用到、但屬於 agent 本體的能力(擋更新的條件、關 server、寫日誌)。 */
export interface UpdateOps {
  /** 回傳拒絕原因,null = 現在可以更新。 */
  canApply: () => string | null;
  /** 重啟前先收掉 HTTP server 等資源。 */
  onRestart: () => Promise<void>;
  log: (msg: string) => void;
}

let applying: Promise<void> | null = null;

/**
 * 下載、驗證、換檔、重啟。回傳的 promise 在「即將重啟」時 resolve —— 呼叫端應該
 * 先把 HTTP 回應送出去,行程隨後就會被換掉。
 *
 * canApply 由呼叫端提供(例如:有實例正在安裝伺服器檔案時不准更新)。
 */
export function applyUpdate(opts: UpdateOps): Promise<void> {
  if (applying) return applying;
  applying = run(opts).finally(() => {
    applying = null;
  });
  return applying;
}

async function run({ canApply, onRestart, log }: UpdateOps): Promise<void> {
  const layout = installLayout();
  if (!layout) throw new Error("自我更新僅支援免安裝執行檔版本");
  const blocked = canApply();
  if (blocked) throw new Error(blocked);

  const status = await getUpdateStatus(true);
  if (!status.updateAvailable) throw new Error("已經是最新版本");
  const cached = readCache();
  if (!cached?.assetUrl || !cached.assetName) throw new Error("這個版本沒有適用於本平台的更新檔");
  if (!cached.checksumsUrl) throw new Error(`release 未附 ${CHECKSUMS_ASSET},為安全起見拒絕更新`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "palserver-update-"));
  lastError = null;
  try {
    phase = "downloading";
    progress = 0;
    log(`下載 ${cached.assetName}(${status.latestVersion})…`);
    const pkg = path.join(work, cached.assetName);
    await download(cached.assetUrl, pkg, (pct) => {
      progress = pct;
    });

    phase = "verifying";
    progress = null;
    const sumsRes = await fetch(cached.checksumsUrl, {
      headers: { "User-Agent": `palserver-agent/${AGENT_VERSION}` },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!sumsRes.ok) throw new Error(`無法下載 ${CHECKSUMS_ASSET}:HTTP ${sumsRes.status}`);
    const want = expectedHash(await sumsRes.text(), cached.assetName);
    if (!want) throw new Error(`${CHECKSUMS_ASSET} 裡找不到 ${cached.assetName} 的雜湊`);
    const got = await sha256(pkg);
    if (got !== want) throw new Error(`檔案雜湊不符(可能損毀或被竄改):${got.slice(0, 12)}…`);
    log("SHA256 驗證通過");

    phase = "extracting";
    const unpacked = path.join(work, "unpacked");
    fs.mkdirSync(unpacked);
    await execFileP("tar", ["-xzf", pkg, "-C", unpacked], { windowsHide: true });

    const exeName = path.basename(layout.exePath);
    const newExe = path.join(unpacked, exeName);
    const newWeb = path.join(unpacked, "web");
    const newLicense = path.join(unpacked, "LICENSE.md");
    if (!fs.existsSync(newExe)) throw new Error(`更新檔裡找不到 ${exeName}`);

    phase = "swapping";
    // Windows 不能覆蓋執行中的 exe,但可以改名它 —— 改名後原路徑就空出來了。
    // 舊檔留到下次開機再清(見 cleanupOldBinaries)。
    const retired = `${layout.exePath}.old-${Date.now()}`;
    fs.renameSync(layout.exePath, retired);
    try {
      fs.copyFileSync(newExe, layout.exePath);
      fs.chmodSync(layout.exePath, 0o755);
      if (fs.existsSync(newWeb)) {
        // 先把新 web 完整複製到目標同目錄(staging),成功後才動舊的;
        // rename 幾乎不會失敗,失敗也能把舊的原樣還原 —— 避免舊版流程
        // 「先搬走舊的、複製新的失敗」導致 web 消失、前端 404。
        const staged = `${layout.webDir}.new-${Date.now()}`;
        const oldWeb = `${layout.webDir}.old-${Date.now()}`;
        fs.cpSync(newWeb, staged, { recursive: true });
        const hadOld = fs.existsSync(layout.webDir);
        if (hadOld) fs.renameSync(layout.webDir, oldWeb);
        try {
          fs.renameSync(staged, layout.webDir);
        } catch (err) {
          if (hadOld) fs.renameSync(oldWeb, layout.webDir);
          fs.rmSync(staged, { recursive: true, force: true });
          throw err;
        }
        fs.rmSync(oldWeb, { recursive: true, force: true });
      }
      // 授權條款必須留在散布出去的副本旁(PolyForm Notices)。
      if (fs.existsSync(newLicense)) {
        fs.copyFileSync(newLicense, path.join(path.dirname(layout.exePath), "LICENSE.md"));
      }
    } catch (err) {
      // 換檔失敗就把舊執行檔放回去,至少維持可用。
      fs.rmSync(layout.exePath, { force: true });
      fs.renameSync(retired, layout.exePath);
      throw err;
    }
    log(`已更新到 ${status.latestVersion},正在重新啟動…`);

    phase = "restarting";
    await onRestart();
    respawn(layout.exePath);
  } catch (err) {
    phase = "idle";
    progress = null;
    lastError = err instanceof Error ? err.message : String(err);
    log(`更新失敗:${lastError}`);
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const BOOT_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const BOOT_RUN_NAME = "palserver-agent";

/** Windows 登入自啟:寫 HKCU Run key(免管理員權限)。只在免安裝執行檔有意義。
 *  回傳是否有實際套用(非 Windows / 開發模式回 false)。 */
export async function setBootStart(enabled: boolean): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const layout = installLayout();
  if (!layout) return false;
  try {
    if (enabled) {
      await execFileP(
        "reg",
        ["add", BOOT_RUN_KEY, "/v", BOOT_RUN_NAME, "/t", "REG_SZ", "/d", `"${layout.exePath}"`, "/f"],
        { windowsHide: true },
      );
    } else {
      await execFileP("reg", ["delete", BOOT_RUN_KEY, "/v", BOOT_RUN_NAME, "/f"], { windowsHide: true }).catch(
        () => {},
      ); // 不存在時 delete 會失敗,視為已達成
    }
    return true;
  } catch {
    return false;
  }
}

/** 目前是否已設定登入自啟(查 Run key)。 */
export async function getBootStart(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileP("reg", ["query", BOOT_RUN_KEY, "/v", BOOT_RUN_NAME], { windowsHide: true });
    return stdout.includes(BOOT_RUN_NAME);
  } catch {
    return false;
  }
}

/** 重啟自己(給「儲存系統設定後套用」用)。只在免安裝執行檔有意義;
 *  開發模式(execPath 是 node)不做,交由使用者手動重啟。 */
export function restartSelf(): boolean {
  const base = path.basename(process.execPath).toLowerCase();
  if (base !== "palserver-agent" && base !== "palserver-agent.exe") return false;
  respawn(process.execPath);
  return true;
}

/** 用同樣的參數重新啟動自己,然後讓舊行程退場。 */
function respawn(exePath: string): void {
  const child = spawn(exePath, process.argv.slice(2), {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  // 給新行程一點時間搶下埠口,再讓自己消失。
  setTimeout(() => process.exit(0), 500).unref();
}

/** 開機時清掉上次更新留下的舊執行檔(Windows 當下刪不掉,只能等重開)。 */
export function cleanupOldBinaries(): void {
  const layout = installLayout();
  if (!layout) return;
  const dir = path.dirname(layout.exePath);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\.old-\d+$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  } catch {
    /* 清不掉就算了,下次再說 */
  }
}

/**
 * 背景檢查:每 6 小時看一次有沒有新版。開了 autoApply 就直接裝(裝完會重啟);
 * 否則只更新快取,讓 GUI 顯示「有新版本」。
 */
export function startUpdateChecker(opts: UpdateOps): void {
  const tick = async () => {
    const prefs = updatePrefs();
    if (prefs.envDisabled || !prefs.autoCheck) return;
    try {
      const status = await getUpdateStatus(true);
      if (!status.updateAvailable) return;
      opts.log(`有新版本可用:${status.latestVersion}(目前 ${AGENT_VERSION})`);
      if (prefs.autoApply && status.supported) await applyUpdate(opts);
    } catch {
      /* 檢查失敗不吵人,下個週期再試 */
    }
  };
  // 開機先等一下,別跟啟動流程搶頻寬。
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), CHECK_INTERVAL_MS).unref();
}
