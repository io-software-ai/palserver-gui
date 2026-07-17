/**
 * The single source of truth for PalWorldSettings.ini options the GUI manages.
 * Keys and types follow the official server docs
 * (docs.palworldgame.com/settings-and-operation/configuration, v0.7.x).
 *
 * Defaults below seed NEW instances only. TODO(v2): once an instance's server
 * files are installed, parse the game's own DefaultPalWorldSettings.ini and
 * prefer its values — that keeps us correct across game updates.
 *
 * The zod schema, the agent's ini serializer, and the web settings editor are
 * all derived from this table, so adding an option here is the only step
 * needed to surface it end to end.
 */

export type OptionCategory =
  | "server"
  | "pal"
  | "player"
  | "guild"
  | "build"
  | "drop"
  | "world";

/** soft=true:min/max 只是「建議範圍」(滑桿範圍 + 超出時提醒),實際允許填更極端的值
 *  ——玩家就是想亂玩。非 soft(如埠號、人數上限)則嚴格限制。
 *  hint:顯示在設定項下方的說明/建議值文案(zh-TW 原文,前端 t() 翻譯),純 UI 用、不進 ini。 */
interface OptionExtras {
  hint?: string;
  /** 危險/破壞性選項的黃色警告(不可逆、或會斷 GUI 功能)。 */
  warn?: string;
}
export type OptionMeta =
  | ({ type: "float"; default: number; min: number; max: number; step: number; category: OptionCategory; soft?: boolean } & OptionExtras)
  | ({ type: "int"; default: number; min: number; max: number; category: OptionCategory; soft?: boolean } & OptionExtras)
  | ({ type: "bool"; default: boolean; category: OptionCategory } & OptionExtras)
  | ({ type: "enum"; default: string; choices: readonly string[]; category: OptionCategory } & OptionExtras)
  | ({ type: "string"; default: string; maxLength: number; secret?: boolean; category: OptionCategory } & OptionExtras);

// 倍率類:min/max 是建議範圍(滑桿),但允許超出(soft)—— 遊戲引擎不驗證 .ini,想亂玩就讓他玩。
const rate = (
  category: OptionCategory,
  d = 1,
  min = 0.1,
  max = 20,
  step = 0.1,
): OptionMeta => ({ type: "float", default: d, min, max, step, category, soft: true });

export const WORLD_OPTIONS = {
  // ── server ────────────────────────────────────────────────────────────
  ServerName: { type: "string", default: "palserver GUI Server", maxLength: 64, category: "server" },
  ServerDescription: { type: "string", default: "", maxLength: 256, category: "server" },
  ServerPassword: { type: "string", default: "", maxLength: 64, secret: true, category: "server" },
  AdminPassword: { type: "string", default: "", maxLength: 64, secret: true, category: "server" },
  ServerPlayerMaxNum: { type: "int", default: 32, min: 1, max: 99, category: "server" },
  CoopPlayerMaxNum: { type: "int", default: 4, min: 1, max: 8, category: "server" },
  PublicIP: { type: "string", default: "", maxLength: 64, category: "server" },
  PublicPort: { type: "int", default: 8211, min: 1024, max: 65535, category: "server",
    hint: "只影響社群伺服器列表顯示的埠,改這裡不會改實際監聽埠。要換連線埠請到「設定」分頁(或首頁卡片)看實際的遊戲埠。" },
  bIsMultiplay: { type: "bool", default: false, category: "server" },
  bShowPlayerList: { type: "bool", default: false, category: "server" },
  bIsShowJoinLeftMessage: { type: "bool", default: true, category: "server" },
  RESTAPIEnabled: { type: "bool", default: true, category: "server",
    warn: "關閉後 GUI 的玩家列表、踢出/封鎖、線上地圖、效能監控都會失效 — 除非你清楚在做什麼,建議保持開啟。" },
  RESTAPIPort: { type: "int", default: 8212, min: 1024, max: 65535, category: "server" },
  // 預設啟用:GUI 的倒數公告/廣播/指令台與 PalDefender 管理功能都靠 RCON;
  // 建立時會自動生管理員密碼與唯一埠。
  RCONEnabled: { type: "bool", default: true, category: "server",
    warn: "關閉後 GUI 的停機倒數公告、廣播、指令台都會失效 — 建議保持開啟。" },
  RCONPort: { type: "int", default: 25575, min: 1024, max: 65535, category: "server" },
  ChatPostLimitPerMinute: { type: "int", default: 10, min: 1, max: 120, category: "server" },
  LogFormatType: { type: "enum", default: "Text", choices: ["Text", "Json"], category: "server" },
  bIsUseBackupSaveData: { type: "bool", default: true, category: "server", hint: "官方註記:會增加磁碟負載。存檔碟是慢速硬碟時建議關閉;官方警告慢速儲存可能損毀存檔,建議使用 SSD。" },
  AutoSaveSpan: { type: "float", default: 30, min: 10, max: 600, step: 5, category: "server", hint: "高負載伺服器社群建議 300–600 秒可減少存檔卡頓;代價是異常關機時回檔的損失變大。" },
  Region: { type: "string", default: "", maxLength: 64, category: "server" },
  CrossplayPlatforms: {
    type: "string", default: "(Steam,Xbox,PS5,Mac)", maxLength: 256, category: "server",
  },
  BanListURL: {
    type: "string",
    default: "https://b.palworldgame.com/api/banlist.txt",
    maxLength: 512,
    category: "server",
  },
  bUseAuth: { type: "bool", default: true, category: "server" },
  bAllowClientMod: { type: "bool", default: true, category: "server" },
  bEnableVoiceChat: { type: "bool", default: false, category: "server" },
  VoiceChatMaxVolumeDistance: {
    type: "float", default: 3000, min: 0, max: 50000, step: 100, category: "server",
  },
  VoiceChatZeroVolumeDistance: {
    type: "float", default: 15000, min: 0, max: 50000, step: 100, category: "server",
  },
  AutoTransferMasterCheckIntervalSeconds: {
    type: "float", default: 3600, min: 60, max: 86400, step: 1, category: "server",
  },
  AutoTransferMasterThresholdDays: { type: "int", default: 14, min: 0, max: 365, category: "server" },
  ItemContainerForceMarkDirtyInterval: {
    type: "float", default: 1, min: 0, max: 60, step: 0.1, category: "server",
  },
  MaxGuildsPerFrame: { type: "int", default: 10, min: 1, max: 100, category: "server", hint: "每影格處理的公會數:越高公會更新越即時,CPU 成本也越高。" },
  PlayerDataPalStorageUpdateCheckTickInterval: {
    type: "float", default: 1, min: 0, max: 60, step: 0.1, category: "server",
  },

  // ── pal ───────────────────────────────────────────────────────────────
  PalCaptureRate: rate("pal", 1, 0.5, 20),
  PalSpawnNumRate: rate("pal", 1, 0.5, 20),
  PalDamageRateAttack: rate("pal"),
  PalDamageRateDefense: rate("pal"),
  PalStomachDecreaceRate: rate("pal"),
  PalStaminaDecreaceRate: rate("pal"),
  PalAutoHPRegeneRate: rate("pal"),
  PalAutoHpRegeneRateInSleep: rate("pal"),
  PalEggDefaultHatchingTime: { type: "float", default: 72, min: 0, max: 240, step: 1, category: "pal" },
  WorkSpeedRate: rate("pal", 1, 0.1, 20),
  bPalLost: { type: "bool", default: false, category: "pal",
    warn: "開啟後帕魯死亡即永久消失,無法復活 — 對休閒玩家非常嚴苛,開啟前請確定全員知情。" },
  bAllowGlobalPalboxExport: { type: "bool", default: true, category: "pal" },
  bAllowGlobalPalboxImport: { type: "bool", default: false, category: "pal" },
  EnablePredatorBossPal: { type: "bool", default: true, category: "pal" },
  MonsterFarmActionSpeedRate: rate("pal", 1, 0.1, 20),

  // ── player ────────────────────────────────────────────────────────────
  ExpRate: rate("player", 1, 0.1, 20),
  PlayerDamageRateAttack: rate("player"),
  PlayerDamageRateDefense: rate("player"),
  PlayerStomachDecreaceRate: rate("player"),
  PlayerStaminaDecreaceRate: rate("player"),
  PlayerAutoHPRegeneRate: rate("player"),
  PlayerAutoHpRegeneRateInSleep: rate("player"),
  ItemWeightRate: rate("player"),
  EquipmentDurabilityDamageRate: rate("player"),
  bEnablePlayerToPlayerDamage: { type: "bool", default: false, category: "player" },
  bEnableFriendlyFire: { type: "bool", default: false, category: "player" },
  bIsPvP: { type: "bool", default: false, category: "player" },
  DeathPenalty: {
    type: "enum",
    default: "All",
    choices: ["None", "Item", "ItemAndEquipment", "All"],
    category: "player",
  },
  bEnableFastTravel: { type: "bool", default: true, category: "player" },
  bIsStartLocationSelectByMap: { type: "bool", default: false, category: "player" },
  bExistPlayerAfterLogout: { type: "bool", default: false, category: "player" },
  bEnableNonLoginPenalty: { type: "bool", default: true, category: "player" },
  bAllowEnhanceStat_Health: { type: "bool", default: true, category: "player" },
  bAllowEnhanceStat_Attack: { type: "bool", default: true, category: "player" },
  bAllowEnhanceStat_Stamina: { type: "bool", default: true, category: "player" },
  bAllowEnhanceStat_Weight: { type: "bool", default: true, category: "player" },
  bAllowEnhanceStat_WorkSpeed: { type: "bool", default: true, category: "player" },
  AdditionalDropItemWhenPlayerKillingInPvPMode: {
    type: "enum",
    default: "PlayerDropItem",
    choices: ["None", "PlayerDropItem", "AllItems"],
    category: "player",
  },
  AdditionalDropItemNumWhenPlayerKillingInPvPMode: {
    type: "int", default: 1, min: 0, max: 9999, category: "player",
  },
  bAdditionalDropItemWhenPlayerKillingInPvPMode: {
    type: "bool", default: false, category: "player",
  },
  bDisplayPvPItemNumOnWorldMap_Player: { type: "bool", default: false, category: "player" },
  BlockRespawnTime: { type: "float", default: 5, min: 0, max: 3600, step: 0.5, category: "player" },
  RespawnPenaltyDurationThreshold: {
    type: "float", default: 0, min: 0, max: 3600, step: 0.5, category: "player",
  },
  RespawnPenaltyTimeScale: { type: "float", default: 2, min: 0, max: 10, step: 0.1, category: "player" },

  // ── guild ─────────────────────────────────────────────────────────────
  GuildPlayerMaxNum: { type: "int", default: 20, min: 1, max: 100, category: "guild" },
  BaseCampMaxNum: { type: "int", default: 128, min: 1, max: 1024, category: "guild" },
  BaseCampMaxNumInGuild: { type: "int", default: 4, min: 1, max: 10, category: "guild" },
  BaseCampWorkerMaxNum: { type: "int", default: 15, min: 1, max: 50, category: "guild", hint: "官方註記:調高會提高伺服器處理負載;高負載伺服器社群建議降到 10。" },
  bAutoResetGuildNoOnlinePlayers: { type: "bool", default: false, category: "guild" },
  AutoResetGuildTimeNoOnlinePlayers: {
    type: "float", default: 72, min: 1, max: 168, step: 1, category: "guild",
  },
  bEnableDefenseOtherGuildPlayer: { type: "bool", default: false, category: "guild" },
  bCanPickupOtherGuildDeathPenaltyDrop: { type: "bool", default: false, category: "guild" },
  bInvisibleOtherGuildBaseCampAreaFX: { type: "bool", default: false, category: "guild" },
  GuildRejoinCooldownMinutes: { type: "int", default: 0, min: 0, max: 10080, category: "guild" },
  bDisplayPvPItemNumOnWorldMap_BaseCamp: { type: "bool", default: false, category: "guild" },

  // ── build ─────────────────────────────────────────────────────────────
  BuildObjectDamageRate: rate("build"),
  BuildObjectDeteriorationDamageRate: rate("build", 1, 0, 20),
  bBuildAreaLimit: { type: "bool", default: false, category: "build" },
  MaxBuildingLimitNum: { type: "int", default: 0, min: 0, max: 10000, category: "build" },
  ServerReplicatePawnCullDistance: {
    type: "int", default: 15000, min: 5000, max: 15000, category: "build",
    hint: "怕魯/玩家的同步距離(公分):調低可減少同步負擔,但玩家會較晚看到遠處的生物。",
  },
  BuildObjectHpRate: rate("build", 1, 0.1, 20),
  bEnableBuildingPlayerUIdDisplay: { type: "bool", default: false, category: "build" },
  BuildingNameDisplayCacheTTLSeconds: {
    type: "int", default: 60, min: 0, max: 600, category: "build",
  },

  // ── drop ──────────────────────────────────────────────────────────────
  DropItemMaxNum: { type: "int", default: 3000, min: 0, max: 5000, category: "drop", hint: "掉落物是重載伺服器的主要負擔之一;高負載伺服器社群建議 2000–2500。" },
  DropItemAliveMaxHours: { type: "float", default: 1, min: 0, max: 24, step: 0.5, category: "drop", hint: "掉落物存活時數;高負載伺服器社群建議 0.5–1 小時,加快世界清理。" },
  CollectionDropRate: rate("drop", 1, 0.5, 20),
  EnemyDropItemRate: rate("drop", 1, 0.5, 20),
  ItemCorruptionMultiplier: rate("drop"),
  SupplyDropSpan: { type: "int", default: 180, min: 30, max: 1440, category: "drop" },
  DropItemMaxNum_UNKO: { type: "int", default: 100, min: 0, max: 5000, category: "drop" },
  bActiveUNKO: { type: "bool", default: false, category: "drop" },
  PhysicsActiveDropItemMaxNum: { type: "int", default: -1, min: -1, max: 10000, category: "drop", hint: "啟用物理計算的掉落物上限(-1 = 無上限);設上限可減少物理運算負擔。" },
  DenyTechnologyList: { type: "string", default: "", maxLength: 512, category: "drop",
    hint: "填科技的英文內部 ID,逗號分隔(例:Workbench,Pickaxe)。ID 對照表:docs.palworldgame.com 的 technologyids 頁面;填中文名稱無效。" },

  // ── world ─────────────────────────────────────────────────────────────
  Difficulty: {
    type: "enum", default: "None", choices: ["None", "Casual", "Normal", "Hard"], category: "world",
  },
  DayTimeSpeedRate: rate("world"),
  NightTimeSpeedRate: rate("world"),
  CollectionObjectHpRate: rate("world", 1, 0.5, 20),
  CollectionObjectRespawnSpeedRate: rate("world", 1, 0.5, 20),
  bEnableInvaderEnemy: { type: "bool", default: true, category: "world" },
  bEnableAimAssistPad: { type: "bool", default: true, category: "world" },
  bEnableAimAssistKeyboard: { type: "bool", default: false, category: "world" },
  bHardcore: { type: "bool", default: false, category: "world",
    warn: "硬核模式:玩家死亡即永久死亡(角色刪除)— 不可逆,開啟前請確定全員知情。" },
  bCharacterRecreateInHardcore: { type: "bool", default: false, category: "world" },
  RandomizerType: {
    type: "enum", default: "None", choices: ["None", "Region", "All"], category: "world",
    hint: "只在「建立新世界」時生效 — 既有世界改這個不會有任何變化。",
  },
  // 官方 ini 是帶引號的字串(RandomizerSeed=""),曾誤標為 int 導致寫出無引號的
  // 0 而觸發「missing opening symbol」解析錯誤;舊存的數字值由 schema 的 catch
  // 落回預設 ""(種子只在建立世界時有效,既有世界不受影響)。留空 = 隨機。
  RandomizerSeed: { type: "string", default: "", maxLength: 32, category: "world" },
  bIsRandomizerPalLevelRandom: { type: "bool", default: false, category: "world" },
} as const satisfies Record<string, OptionMeta>;

export type WorldOptionKey = keyof typeof WORLD_OPTIONS;

export const OPTION_CATEGORIES: readonly OptionCategory[] = [
  "server",
  "world",
  "pal",
  "player",
  "guild",
  "build",
  "drop",
];

export function optionKeysByCategory(category: OptionCategory): WorldOptionKey[] {
  return (Object.keys(WORLD_OPTIONS) as WorldOptionKey[]).filter(
    (k) => WORLD_OPTIONS[k].category === category,
  );
}
