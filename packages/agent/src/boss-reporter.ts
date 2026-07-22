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
import { BOSS_REPORTER_LUA } from "./boss-reporter-lua.generated.js";
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
 * 相依 UE4SS(Lua 載入器);缺就裝標準版(UE4SS-RE),已裝任一版(含 PalSchema 的
 * Okaetsu fork)則沿用。設計沿用 palschema.ts 的安裝/狀態模式。
 */

const BOSS_REPORTER_MOD_VERSION = "1.6";
const WIN64_REL = "Pal/Binaries/Win64";
const BOSS_MARKER_REL = `${WIN64_REL}/.palserver-boss-reporter.json`;

/**
 * 遠端交付:boss-reporter Lua 放在獨立 mod repo 的 GitHub Release,agent 安裝時抓最新版,
 * 讓 mod 修正不必等 GUI 改版就能送達(沿用 mods.ts 的 GitHub Releases 模式)。抓不到
 * (無網路 / repo 或 release 尚未建立 / rate limit)一律退回 agent 內嵌的 BOSS_REPORTER_LUA,
 * 確保功能永遠可用。repo 與直接下載 URL 皆可用 env 覆寫(測試/私有鏡像)。
 */
const BOSS_REPORTER_REPO = process.env.PALSERVER_BOSS_REPORTER_REPO || "io-software-ai/palserver-boss-reporter";
const BOSS_REPORTER_URL_OVERRIDE = process.env.PALSERVER_BOSS_REPORTER_URL; // 直接指定 main.lua 下載 URL
const GH_HEADERS = { "user-agent": "palserver-gui", accept: "application/vnd.github+json" };
const stripV = (tag: string) => tag.replace(/^v/i, "");

interface GhRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/** 最新版查詢:6h 記憶體快取、非阻塞——冷取回 null 並在背景刷新,不拖慢 status 輪詢。 */
let latestCache: { tag: string | null; at: number } | null = null;
let latestRefreshing = false;
const LATEST_TTL = 6 * 60 * 60 * 1000;
async function fetchLatestBossReporterTag(): Promise<string | null> {
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

/** 抓遠端最新 Lua(release 的 *.lua 資產);抓不到/內容不對回 null 讓呼叫端退回內嵌。 */
async function fetchRemoteBossLua(): Promise<{ lua: string; version: string } | null> {
  try {
    let url = BOSS_REPORTER_URL_OVERRIDE;
    let version = "custom";
    if (!url) {
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
    version: modInstalled ? (await readBossMarker(rec, ctx)).version ?? BOSS_REPORTER_MOD_VERSION : null,
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

  // 2) 寫入我們的 Lua 模組(Scripts/main.lua + enabled.txt)。
  //    優先抓遠端 mod repo 的最新 Lua;抓不到就用 agent 內嵌版當離線 fallback。
  const remote = await fetchRemoteBossLua();
  const lua = remote?.lua ?? BOSS_REPORTER_LUA;
  const version = remote?.version ?? BOSS_REPORTER_MOD_VERSION;
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
