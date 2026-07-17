/**
 * PalDefender Config.json options the GUI manages.
 * Keys and semantics from the official docs
 * (ultimeit.github.io/PalDefender/FileTypes/Config.md).
 *
 * Only scalar settings (bool / int / float) are exposed here — the array
 * settings (MOTD, bannedChatWords, bannedNames, bannedTechnologies, adminIPs)
 * are left to the raw JSON editor for now. Writes merge, so any key we don't
 * list is preserved untouched (PalDefender adds keys per version).
 */

export type PdOptionCategory =
  | "anticheat"
  | "protection"
  | "admin"
  | "chat"
  | "announce"
  | "logging"
  | "misc";

export type PdOptionMeta =
  | { type: "bool"; default: boolean; category: PdOptionCategory; label: string; hint?: string; warn?: string }
  | { type: "int"; default: number; min: number; max: number; category: PdOptionCategory; label: string; hint?: string; warn?: string }
  | { type: "float"; default: number; min: number; max: number; step: number; category: PdOptionCategory; label: string; hint?: string; warn?: string };

export const PALDEFENDER_OPTIONS = {
  // ── 反外掛處置 ──
  shouldWarnCheaters: { type: "bool", default: true, category: "anticheat", label: "警告作弊者", hint: "偵測到作弊時傳送警告訊息給該玩家。" },
  shouldWarnCheatersReason: { type: "bool", default: true, category: "anticheat", label: "警告時附上原因" },
  shouldKickCheaters: { type: "bool", default: false, category: "anticheat", label: "自動踢出作弊者" },
  shouldBanCheaters: { type: "bool", default: false, category: "anticheat", label: "自動封鎖作弊者" },
  shouldIPBanCheaters: { type: "bool", default: false, category: "anticheat", label: "自動 IP 封鎖作弊者", warn: "IP 封鎖可能誤傷同一 IP 下的其他玩家。" },

  // ── 漏洞防護 ──
  steamidProtection: { type: "bool", default: true, category: "protection", label: "防止重複 UserId 登入" },
  blockTowerBossCapture: { type: "bool", default: false, category: "protection", label: "禁止捕捉塔主" },
  disableIllegalItemProtection: { type: "bool", default: false, category: "protection", label: "停用非法道具防護", warn: "關閉後模組/除錯道具將不再被攔截,一般不建議停用。" },
  doActionUponIllegalPalStats: { type: "bool", default: true, category: "protection", label: "自動處理異常帕魯數值" },
  palStatsMaxRank: { type: "int", default: -1, min: -1, max: 20, category: "protection", label: "帕魯強化上限", hint: "-1 = 自動偵測。" },
  pvpMaxToBuildingDamage: { type: "int", default: 0, min: 0, max: 100000, category: "protection", label: "PvP 對建築最大傷害(0 = 不限)" },
  pvpMaxToPlayerDamage: { type: "int", default: 0, min: 0, max: 100000, category: "protection", label: "PvP 對玩家最大傷害(0 = 不限)", hint: "Beta 功能。" },
  pvpMaxToPalDamage: { type: "int", default: 0, min: 0, max: 100000, category: "protection", label: "PvP 對帕魯最大傷害(0 = 不限)" },
  pveMaxToPalBanThreshold: { type: "int", default: 0, min: 0, max: 1000000, category: "protection", label: "PvE 帕魯傷害封鎖閥值(0 = 關閉)" },
  treeLimiter: { type: "float", default: 0, min: 0, max: 5, step: 0.05, category: "protection", label: "砍樹速率限制(秒/棵)", hint: "限制每棵樹的最短破壞時間,避免火箭快速砍樹造成大量卡頓。0 = 關閉。" },

  // ── 白名單與管理員 ──
  useWhitelist: { type: "bool", default: false, category: "admin", label: "啟用白名單(WhiteList.json)",
    warn: "開啟前先到「玩家」分頁把自己與朋友加入白名單 — 名單為空時所有人(包括你的朋友)都會被擋在門外。" },
  useAdminWhitelist: { type: "bool", default: false, category: "admin", label: "啟用管理員 IP 白名單", hint: "需在 adminIPs 設定 IP(用原始檔編輯)。官方建議開啟以防漏洞。" },
  adminAutoLogin: { type: "bool", default: false, category: "admin", label: "白名單管理員加入時自動登入管理模式" },
  preventAdminPasswordInChat: { type: "bool", default: true, category: "admin", label: "防止管理員密碼在聊天中外洩" },
  allowAdminCheats: { type: "bool", default: true, category: "admin", label: "允許管理員使用作弊指令(如 godmode)" },
  allowGodmodeOnehit: { type: "bool", default: false, category: "admin", label: "godmode 可一擊擊殺" },

  // ── 聊天 ──
  chatBypassWait: { type: "bool", default: false, category: "chat", label: "移除聊天冷卻時間" },
  chatMessageMaxLen: { type: "int", default: 200, min: 1, max: 1000, category: "chat", label: "聊天訊息長度上限" },

  // ── 公告 ──
  announceConnections: { type: "bool", default: false, category: "announce", label: "公告玩家上下線" },
  dontAnnounceAdminConnections: { type: "bool", default: false, category: "announce", label: "不公告管理員上下線" },
  announcePunishments: { type: "bool", default: false, category: "announce", label: "公告作弊處罰(踢出/封鎖)" },
  announcePlayerDeaths: { type: "bool", default: false, category: "announce", label: "公告玩家死亡" },
  announceOpenOilrigBoxes: { type: "bool", default: false, category: "announce", label: "公告鑽油平台寶箱開啟" },
  announceHelicopterKills: { type: "bool", default: false, category: "announce", label: "公告直升機擊殺" },
  announcePlayerSummons: { type: "bool", default: false, category: "announce", label: "公告玩家召喚帕魯" },
  announceAdminSummons: { type: "bool", default: false, category: "announce", label: "公告管理員召喚帕魯" },

  // ── 日誌 ──
  logChat: { type: "bool", default: false, category: "logging", label: "記錄聊天訊息" },
  logRCON: { type: "bool", default: false, category: "logging", label: "記錄 RCON 指令使用" },
  logPlayerLogins: { type: "bool", default: false, category: "logging", label: "記錄玩家上下線" },
  logPlayerDeaths: { type: "bool", default: false, category: "logging", label: "記錄玩家死亡" },
  logPlayerBuildings: { type: "bool", default: false, category: "logging", label: "記錄玩家建築(建造/取消/拆除)" },
  logPlayerSummons: { type: "bool", default: false, category: "logging", label: "記錄玩家召喚帕魯" },
  logPlayerCaptures: { type: "bool", default: false, category: "logging", label: "記錄玩家捕捉帕魯" },
  logCraftings: { type: "bool", default: false, category: "logging", label: "記錄玩家製作" },
  logTechUnlocks: { type: "bool", default: false, category: "logging", label: "記錄科技解鎖" },
  logPlayerUID: { type: "bool", default: false, category: "logging", label: "日誌中記錄玩家 UserId" },
  logPlayerIP: { type: "bool", default: false, category: "logging", label: "日誌中記錄玩家 IP" },
  logNetworking: { type: "bool", default: false, category: "logging", label: "記錄用戶端網路資料" },

  // ── 其他 ──
  exitServerOnStartupFailure: {
    type: "bool", default: false, category: "misc",
    label: "PalDefender 啟動失敗時關閉伺服器",
    hint: "保護存檔不在無反外掛的情況下運行。",
    warn: "這會以錯誤碼結束行程。GUI 已能辨識這種「啟動即失敗」的關閉並自動停止重啟(不會與崩潰自動重啟打成無限迴圈),但仍請留意重啟紀錄中的「啟動失敗」提示並修正 PalDefender 問題。",
  },
  disableButchering: { type: "bool", default: false, category: "misc", label: "停用屠宰" },
  disableRenaming: { type: "bool", default: false, category: "misc", label: "停用角色改名" },
  disablePalRenaming: { type: "bool", default: false, category: "misc", label: "停用帕魯改名" },
  OilrigGoalBoxLocktime: { type: "int", default: 300, min: 0, max: 3600, category: "misc", label: "鑽油平台目標寶箱鎖定時間(秒)" },
  RCONTimeout: { type: "float", default: 5, min: 1, max: 60, step: 0.5, category: "misc", label: "RCON 連線逾時(秒)" },
  RCONUsePacketIdFix: { type: "bool", default: false, category: "misc", label: "修正 RCON 封包 ID 問題" },
} as const satisfies Record<string, PdOptionMeta>;

export type PdOptionKey = keyof typeof PALDEFENDER_OPTIONS;

export const PD_CATEGORY_LABELS: Record<PdOptionCategory, string> = {
  anticheat: "反外掛處置",
  protection: "漏洞防護",
  admin: "白名單與管理員",
  chat: "聊天",
  announce: "公告",
  logging: "日誌",
  misc: "其他",
};

export type PalDefenderConfig = Partial<Record<PdOptionKey, number | boolean>>;

/** MOTD(登入公告)是 Config.json 的字串陣列,每行一則;上限做基本防呆。 */
export const PD_MOTD_MAX_LINES = 30;
export const PD_MOTD_MAX_LEN = 500;

export interface PalDefenderConfigStatus {
  supported: boolean;
  reason?: string;
  /** false when Config.json doesn't exist yet (server never started) */
  exists: boolean;
  values: PalDefenderConfig;
  /** MOTD 各行(字串陣列);scalar 之外另行處理。空陣列 = 未設定。 */
  motd: string[];
}

/** 寫入用的 patch:scalar 設定 +(可選)MOTD 陣列。 */
export type PalDefenderConfigPatch = PalDefenderConfig & { motd?: string[] };
