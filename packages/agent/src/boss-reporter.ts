import {
  BOSS_REPORTER_MOD_NAME,
  BOSS_STATE_REL,
  isBossStateStale,
  type BossRespawnState,
  type BossRespawnStatus,
} from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverPlatform } from "./platform.js";
import { installComponent } from "./mods.js";
import { enableModsTxt } from "./palschema.js";
import {
  runtimeExists,
  runtimeMkdir,
  runtimeReadText,
  runtimeRemove,
  runtimeWriteText,
} from "./runtime-files.js";

/**
 * 頭目重生時間(贊助者先行版 boss-respawn):安裝純伺服器端的 PalserverBossReporter
 * UE4SS Lua 模組,模組每 15s 把頭目 spawner 死活寫到 Pal/Saved/palserver-boss-state.json,
 * agent 讀檔回報給 web。模組只讀取遊戲狀態、不改任何遊戲行為,玩家端無需安裝。
 *
 * 相依 UE4SS(Lua 載入器);缺就裝 Palworld 專用的 Okaetsu fork(experimental-palworld,
 * 與 PalSchema 同一份),已裝任一版則沿用。設計沿用 palschema.ts 的安裝/狀態模式。
 */

const WIN64_REL = "Pal/Binaries/Win64";
const BOSS_MARKER_REL = `${WIN64_REL}/.palserver-boss-reporter.json`;

/**
 * 遠端交付:boss-reporter Lua 的原始碼在獨立 repo(io-software-ai/palserver-boss-reporter)管理,
 * agent 安裝時抓其 GitHub Release 最新版的 main.lua,
 * 讓 mod 修正不必等 GUI 改版就能送達。**不再內嵌於 agent**——抓不到(無網路 / repo 或 release
 * 尚未建立)就讓安裝失敗並提示,不做內嵌 fallback。repo 與直接下載 URL 皆可 env 覆寫。
 * 優先走 GitHub 的 latest/download 直鏈,避免匿名 REST API 每小時 60 次的共享 IP 限流。
 */
const BOSS_REPORTER_REPO = process.env.PALSERVER_BOSS_REPORTER_REPO || "io-software-ai/palserver-boss-reporter";
const BOSS_REPORTER_URL_OVERRIDE = process.env.PALSERVER_BOSS_REPORTER_URL; // 直接指定 main.lua 下載 URL
const GH_HEADERS = { "user-agent": "palserver-gui", accept: "application/vnd.github+json" };
const stripV = (tag: string) => tag.replace(/^v/i, "");

interface GhRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

function latestBossReporterAssetUrl(): string {
  return `https://github.com/${BOSS_REPORTER_REPO}/releases/latest/download/main.lua`;
}

export function versionFromReleaseUrl(url: string): string | null {
  const match = url.match(/\/releases\/download\/([^/]+)\/main\.lua(?:[?#]|$)/i);
  return match ? stripV(decodeURIComponent(match[1])) : null;
}

/**
 * latest/download 會先 302 到 /releases/download/<tag>/main.lua。手動接住第一跳即可同時取得
 * 實際資產 URL 與版本,全程不消耗 GitHub REST API 配額。
 */
export async function resolveLatestBossReporterAsset(): Promise<{ url: string; version: string | null } | null> {
  const latestUrl = latestBossReporterAssetUrl();
  try {
    const res = await fetch(latestUrl, { headers: { "user-agent": "palserver-gui" }, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      const url = new URL(location, latestUrl).toString();
      return { url, version: versionFromReleaseUrl(url) };
    }
    return res.ok ? { url: latestUrl, version: versionFromReleaseUrl(res.url) } : null;
  } catch {
    return null;
  }
}

/** 最新版查詢:6h 記憶體快取、非阻塞——冷取回 null 並在背景刷新,不拖慢 status 輪詢。 */
let latestCache: { tag: string | null; at: number } | null = null;
let latestRefreshing = false;
const LATEST_TTL = 6 * 60 * 60 * 1000;
async function fetchLatestBossReporterTag(): Promise<string | null> {
  const direct = await resolveLatestBossReporterAsset();
  if (direct?.version) return direct.version;
  // 非標準 Release/資產名稱才回退 API;正常 main.lua 發布完全不消耗 API 配額。
  try {
    const res = await fetch(`https://api.github.com/repos/${BOSS_REPORTER_REPO}/releases/latest`, {
      headers: GH_HEADERS,
    });
    return res.ok ? stripV((await res.json() as GhRelease).tag_name) : null;
  } catch {
    return null;
  }
}
function latestBossReporterVersion(): string | null {
  if (latestCache && Date.now() - latestCache.at < LATEST_TTL) return latestCache.tag;
  if (!latestRefreshing) {
    latestRefreshing = true;
    void fetchLatestBossReporterTag()
      .then((tag) => { latestCache = { tag, at: Date.now() }; })
      .finally(() => { latestRefreshing = false; });
  }
  return latestCache?.tag ?? null; // 冷啟第一次回舊值(或 null),下次輪詢就有
}

/** 抓遠端最新 Lua;latest/download 直鏈優先,非標準資產名稱才回退 Releases API。 */
export async function fetchRemoteBossLua(): Promise<{ lua: string; version: string } | null> {
  try {
    let url = BOSS_REPORTER_URL_OVERRIDE;
    let version = "custom";
    if (!url) {
      const direct = await resolveLatestBossReporterAsset();
      if (direct) {
        url = direct.url;
        version = direct.version ?? "latest";
      } else {
        const res = await fetch(`https://api.github.com/repos/${BOSS_REPORTER_REPO}/releases/latest`, {
          headers: GH_HEADERS,
        });
        if (!res.ok) return null;
        const rel = (await res.json()) as GhRelease;
        const asset = rel.assets.find((a) => /\.lua$/i.test(a.name));
        if (!asset) return null;
        url = asset.browser_download_url;
        version = stripV(rel.tag_name);
      }
    }
    const luaRes = await fetch(url, { headers: { "user-agent": "palserver-gui" } });
    if (!luaRes.ok) return null;
    const lua = await luaRes.text();
    // 健全性:必須是我們的模組(避免抓到空檔 / GitHub 錯誤頁 / 被改寫的內容)。
    if (!lua.includes("PalserverBossReporter")) return null;
    return { lua, version };
  } catch {
    return null;
  }
}

/** UE4SS 是否在位(不分 fork/標準,三種佈局都查)。 */
async function ue4ssPresent(rec: InstanceRecord, ctx: DriverContext): Promise<boolean> {
  for (const f of [`${WIN64_REL}/UE4SS/UE4SS.dll`, `${WIN64_REL}/ue4ss/UE4SS.dll`, `${WIN64_REL}/UE4SS.dll`]) {
    if (await runtimeExists(rec, ctx, f, "f")) return true;
  }
  return false;
}

/** UE4SS 的 Mods 目錄(相對安裝根):fork 大寫 UE4SS/、標準新版 ue4ss/、舊版扁平 Mods/。 */
async function ue4ssModsRel(rec: InstanceRecord, ctx: DriverContext): Promise<string> {
  for (const cand of [`${WIN64_REL}/UE4SS/Mods`, `${WIN64_REL}/ue4ss/Mods`, `${WIN64_REL}/Mods`]) {
    if (await runtimeExists(rec, ctx, cand, "d")) return cand;
  }
  return `${WIN64_REL}/ue4ss/Mods`; // 全新裝標準 UE4SS 後的預設佈局
}

async function readBossMarker(rec: InstanceRecord, ctx: DriverContext): Promise<{ version?: string }> {
  try {
    return JSON.parse(await runtimeReadText(rec, ctx, BOSS_MARKER_REL)) as { version?: string };
  } catch {
    return {};
  }
}

/** 讀模組寫出的狀態檔;缺檔或壞檔回 null。 */
export async function readBossState(rec: InstanceRecord, ctx: DriverContext): Promise<BossRespawnState | null> {
  try {
    const parsed = JSON.parse(await runtimeReadText(rec, ctx, BOSS_STATE_REL)) as BossRespawnState;
    if (!parsed || !Array.isArray(parsed.bosses)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getBossReporterStatus(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<BossRespawnStatus> {
  if (serverPlatform(rec) !== "windows") {
    return {
      supported: false,
      reason: "頭目回報模組僅支援 Windows 伺服器",
      ue4ss: false,
      modInstalled: false,
      version: null,
      state: null,
    };
  }
  if (!(await runtimeExists(rec, ctx, WIN64_REL, "d"))) {
    return {
      supported: false,
      reason: "伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器",
      ue4ss: false,
      modInstalled: false,
      version: null,
      state: null,
    };
  }
  const modsRel = await ue4ssModsRel(rec, ctx);
  const modInstalled = await runtimeExists(
    rec,
    ctx,
    `${modsRel}/${BOSS_REPORTER_MOD_NAME}/Scripts/main.lua`,
    "f",
  );
  const state = await readBossState(rec, ctx);
  const now = Math.floor(Date.now() / 1000);
  return {
    supported: true,
    ue4ss: await ue4ssPresent(rec, ctx),
    modInstalled,
    version: modInstalled ? (await readBossMarker(rec, ctx)).version ?? null : null,
    // 只在已安裝時查最新版(徽章只在已安裝時才顯示);非阻塞,查不到回 null 即不顯示徽章。
    latestVersion: modInstalled ? latestBossReporterVersion() : null,
    state,
    stale: isBossStateStale(state, now),
  };
}

/**
 * 安裝(或更新)頭目回報模組:必要時先裝 UE4SS,再寫入 Lua 模組並於 mods.txt 啟用。
 * 呼叫端需確保伺服器已停止(UE4SS DLL 執行中會被鎖)。冪等:重跑即覆蓋成最新 Lua。
 */
export async function installBossReporter(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<{ version: string }> {
  const status = await getBossReporterStatus(rec, ctx);
  if (!status.supported) throw Object.assign(new Error(status.reason ?? "unsupported"), { statusCode: 409 });

  // 1) 相依 UE4SS:缺就裝標準版(已裝任一版則沿用,避免兩份互相打架)。
  if (!status.ue4ss) {
    await installComponent(rec, ctx, "ue4ss");
  }

  // 2) 從遠端 mod repo 抓最新 Lua 寫入(Scripts/main.lua + enabled.txt)。無內嵌 fallback:
  //    抓不到就中止安裝並提示(通常是 release 尚未發布或暫時連不上 GitHub)。
  const remote = await fetchRemoteBossLua();
  if (!remote) {
    throw Object.assign(
      new Error(
        "下載頭目回報模組失敗:請確認 io-software-ai/palserver-boss-reporter 已發布含 main.lua 資產的 Release,或稍後再試。",
      ),
      { statusCode: 502 },
    );
  }
  const { lua, version } = remote;
  const modsRel = await ue4ssModsRel(rec, ctx);
  const modRel = `${modsRel}/${BOSS_REPORTER_MOD_NAME}`;
  await runtimeMkdir(rec, ctx, `${modRel}/Scripts`);
  await runtimeWriteText(rec, ctx, `${modRel}/Scripts/main.lua`, lua);
  await runtimeWriteText(rec, ctx, `${modRel}/enabled.txt`, "");

  // 3) mods.txt 啟用(冪等:存在就改值,否則附加)。
  const modsTxtRel = `${modsRel}/mods.txt`;
  const cur = (await runtimeExists(rec, ctx, modsTxtRel, "f"))
    ? await runtimeReadText(rec, ctx, modsTxtRel)
    : "";
  await runtimeWriteText(rec, ctx, modsTxtRel, enableModsTxt(cur, [BOSS_REPORTER_MOD_NAME]));

  await runtimeWriteText(rec, ctx, BOSS_MARKER_REL, JSON.stringify({ version }, null, 2));
  return { version };
}

/** 移除頭目回報模組(保留 UE4SS,其他模組可能還要用)。 */
export async function removeBossReporter(rec: InstanceRecord, ctx: DriverContext): Promise<void> {
  const modsRel = await ue4ssModsRel(rec, ctx);
  await runtimeRemove(rec, ctx, `${modsRel}/${BOSS_REPORTER_MOD_NAME}`);
  const modsTxtRel = `${modsRel}/mods.txt`;
  if (await runtimeExists(rec, ctx, modsTxtRel, "f")) {
    const re = new RegExp(`^${BOSS_REPORTER_MOD_NAME}\\s*:`);
    const filtered = (await runtimeReadText(rec, ctx, modsTxtRel))
      .split("\n")
      .filter((l) => !re.test(l.trim()))
      .join("\n");
    await runtimeWriteText(rec, ctx, modsTxtRel, filtered);
  }
  await runtimeRemove(rec, ctx, BOSS_MARKER_REL).catch(() => {});
  // 一併清掉狀態檔,否則日後重裝時 Lua 的 loadPrevState 會把過期的死亡時間/倒數復活。
  await runtimeRemove(rec, ctx, BOSS_STATE_REL).catch(() => {});
}
