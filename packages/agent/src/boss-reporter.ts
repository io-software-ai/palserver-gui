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

const BOSS_REPORTER_MOD_VERSION = "1.5";
const WIN64_REL = "Pal/Binaries/Win64";
const BOSS_MARKER_REL = `${WIN64_REL}/.palserver-boss-reporter.json`;

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
  const modsRel = await ue4ssModsRel(rec, ctx);
  const modRel = `${modsRel}/${BOSS_REPORTER_MOD_NAME}`;
  await runtimeMkdir(rec, ctx, `${modRel}/Scripts`);
  await runtimeWriteText(rec, ctx, `${modRel}/Scripts/main.lua`, BOSS_REPORTER_LUA);
  await runtimeWriteText(rec, ctx, `${modRel}/enabled.txt`, "");

  // 3) mods.txt 啟用(冪等:存在就改值,否則附加)。
  const modsTxtRel = `${modsRel}/mods.txt`;
  const cur = (await runtimeExists(rec, ctx, modsTxtRel, "f"))
    ? await runtimeReadText(rec, ctx, modsTxtRel)
    : "";
  await runtimeWriteText(rec, ctx, modsTxtRel, enableModsTxt(cur, [BOSS_REPORTER_MOD_NAME]));

  await runtimeWriteText(rec, ctx, BOSS_MARKER_REL, JSON.stringify({ version: BOSS_REPORTER_MOD_VERSION }, null, 2));
  return { version: BOSS_REPORTER_MOD_VERSION };
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
