/**
 * 頭目重生時間(贊助者先行版 boss-respawn):純伺服器端 UE4SS Lua 模組
 * (PalserverBossReporter)每 15 秒輪詢頭目 spawner,把死活與時間戳寫到
 * Pal/Saved/palserver-boss-state.json;agent 讀檔、web 與 bosses.json 的
 * 全頭目清單做左外連接顯示。這裡放 agent ↔ web 共用型別與純函式(可單元測試)。
 *
 * 座標:模組回報的是 Unreal 世界座標,與 bosses.json 的地圖座標(±1000)配對前
 * 需先經 savToMap / savToWorldTreeMap 轉換(見 bossStateMapCoord)。
 */
import { isWorldTreeCoord, savToMap, savToWorldTreeMap } from "./index.js";

export const BOSS_REPORTER_MOD_NAME = "PalserverBossReporter";
/** 狀態檔相對遊戲安裝根的路徑(模組寫、agent 讀)。 */
export const BOSS_STATE_REL = "Pal/Saved/palserver-boss-state.json";
/** 官方預設野外頭目重生冷卻(秒);沒有實測值時用它算倒數。 */
export const DEFAULT_BOSS_RESPAWN_SECONDS = 3600;
/** state 距今超過這個秒數視為過時(模組每 15s 寫一次,寬限到 60s)。 */
export const BOSS_STATE_STALE_SECONDS = 60;
/** 世界座標轉地圖座標後,與 bosses.json 頭目配對的最大距離(地圖單位;吸收 mapdata 與
 *  實際 spawner 座標的偏差)。註:野外頭目地圖座標實測約 x∈[-1700,910]、y∈[-1980,840]。 */
export const BOSS_MATCH_MAP_RADIUS = 60;

/** 模組寫到 state 檔的一筆 spawner 狀態。 */
export interface BossStateEntry {
  /** spawner 名稱(如 81_1_grass_FBOSS_4);非帕魯名,對應地圖頭目靠座標。 */
  name: string;
  /** true=存活;false=已擊殺;null=無法判定(該區未載入 / 附近無玩家)。 */
  alive: boolean | null;
  /** 最近一次「活→死」的 epoch 秒;-1=未觀測到。 */
  diedAt: number;
  /** 最近一次「死→活」的 epoch 秒;-1=未觀測到。 */
  respawnedAt: number;
  /** 觀測到的實測重生冷卻(死→活的間隔,秒);-1=尚無完整一輪觀測。 */
  respawnInterval: number;
  /** spawner 的 Unreal 世界座標。 */
  x: number;
  y: number;
  z: number;
}

/** 模組輸出的整份狀態檔。 */
export interface BossRespawnState {
  version: number;
  /** 產生時間 epoch 秒(過時判斷用)。 */
  generatedAt: number;
  tick: number;
  spawnerTotal: number;
  bossCount: number;
  aliveCount: number;
  bosses: BossStateEntry[];
}

/** agent → web:頭目重生功能的整體狀態。 */
export interface BossRespawnStatus {
  /** false 時 reason 說明(非 Windows native / 伺服器未安裝完成)。 */
  supported: boolean;
  reason?: string;
  /** Lua 模組所需的 UE4SS 是否在位。 */
  ue4ss: boolean;
  /** 我們的 PalserverBossReporter Lua 模組是否已安裝。 */
  modInstalled: boolean;
  /** 我們安裝時記錄的模組版本;未安裝時為 null。 */
  version?: string | null;
  /** 模組寫出的最新狀態;尚無檔案(未啟動過)時為 null。 */
  state: BossRespawnState | null;
  /** state 是否過時(generatedAt 距今超過 BOSS_STATE_STALE_SECONDS)。 */
  stale?: boolean;
}

/** spawner 世界座標 → 地圖座標(自動分流主世界 / 世界樹)。 */
export function bossStateMapCoord(entry: Pick<BossStateEntry, "x" | "y">): { x: number; y: number } {
  return isWorldTreeCoord(entry.x) ? savToWorldTreeMap(entry.x, entry.y) : savToMap(entry.x, entry.y);
}

/**
 * 在模組回報的 spawner 中,找出離地圖座標 (mapX,mapY) 最近且在半徑內的一筆。
 * 找不到回 null。注意:單獨對每隻頭目呼叫這個會有「鄰近頭目共用同一 spawner」的誤配
 * 問題(bosses.json 有多對頭目間距 < 半徑),需要一對一指派時請用 assignReportedBosses。
 */
export function matchReportedBoss(
  mapX: number,
  mapY: number,
  reported: readonly BossStateEntry[],
  radius = BOSS_MATCH_MAP_RADIUS,
): BossStateEntry | null {
  let best: BossStateEntry | null = null;
  let bestD = radius;
  for (const e of reported) {
    const m = bossStateMapCoord(e);
    const d = Math.hypot(m.x - mapX, m.y - mapY);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * 一對一最近指派:把每個回報的 spawner 指給地圖座標最近、且在半徑內的頭目;最近的配對
 * 優先成立,配到的頭目與 spawner 都移出候選。避免鄰近頭目(bosses.json 有多對間距 < 半徑,
 * 如 Lyleen 與 Lyleen Noct 僅約 4.5 單位)共用同一 spawner,或把「所在區域未載入」的頭目
 * 誤標成鄰居的死活/倒數。呼叫端須先依世界(主世界 / 世界樹)分池後分別呼叫。
 * 回傳 Map<頭目物件, 指派到的 spawner>;沒配到的頭目不在 Map 內(= 狀態未知)。
 */
export function assignReportedBosses<T extends { x: number; y: number }>(
  bosses: readonly T[],
  reported: readonly BossStateEntry[],
  radius = BOSS_MATCH_MAP_RADIUS,
): Map<T, BossStateEntry> {
  const pairs: { boss: T; entry: BossStateEntry; d: number }[] = [];
  for (const entry of reported) {
    const m = bossStateMapCoord(entry);
    for (const boss of bosses) {
      const d = Math.hypot(m.x - boss.x, m.y - boss.y);
      if (d <= radius) pairs.push({ boss, entry, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const out = new Map<T, BossStateEntry>();
  const usedEntry = new Set<BossStateEntry>();
  for (const p of pairs) {
    if (out.has(p.boss) || usedEntry.has(p.entry)) continue;
    out.set(p.boss, p.entry);
    usedEntry.add(p.entry);
  }
  return out;
}

export type BossLiveStatus = "alive" | "dead" | "unknown";

/** 由一筆 spawner 狀態算出的顯示資訊(死活 + 重生倒數)。 */
export interface BossRespawnInfo {
  status: BossLiveStatus;
  /** 已擊殺時間 epoch 秒(dead 且有觀測到擊殺時間時);否則 null。 */
  diedAt: number | null;
  /** 預估重生時間 epoch 秒(dead 且有 diedAt 時);否則 null。 */
  respawnAt: number | null;
  /** 距離重生的秒數(可為負 = 早該重生了);null = 無倒數可算。 */
  secondsLeft: number | null;
  /** 這筆倒數是否採用實測重生間隔(false = 用預設 3600s)。 */
  measured: boolean;
}

/**
 * 由一筆 spawner 狀態(null = 未配對到)算出顯示用的死活與重生倒數。
 * 重生間隔優先用模組實測到的 respawnInterval,沒有才退回 DEFAULT_BOSS_RESPAWN_SECONDS。
 */
export function bossRespawnInfo(entry: BossStateEntry | null, nowSec: number): BossRespawnInfo {
  const none: BossRespawnInfo = {
    status: "unknown",
    diedAt: null,
    respawnAt: null,
    secondsLeft: null,
    measured: false,
  };
  if (!entry || entry.alive === null) return none;
  if (entry.alive === true) return { ...none, status: "alive" };
  // alive === false → 已擊殺
  const diedAt = entry.diedAt > 0 ? entry.diedAt : null;
  if (diedAt === null) return { ...none, status: "dead" };
  const measured = entry.respawnInterval > 0;
  const interval = measured ? entry.respawnInterval : DEFAULT_BOSS_RESPAWN_SECONDS;
  const respawnAt = diedAt + interval;
  return { status: "dead", diedAt, respawnAt, secondsLeft: respawnAt - nowSec, measured };
}

/** state 是否過時(模組停了或伺服器沒在跑,回報不再更新)。 */
export function isBossStateStale(
  state: Pick<BossRespawnState, "generatedAt"> | null,
  nowSec: number,
  maxAgeSec = BOSS_STATE_STALE_SECONDS,
): boolean {
  if (!state) return false;
  return nowSec - state.generatedAt > maxAgeSec;
}
