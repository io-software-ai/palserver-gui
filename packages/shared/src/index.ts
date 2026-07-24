import { z } from "zod";
import { WORLD_OPTIONS, type OptionMeta } from "./options.js";
import { DEFAULT_BOT_LANG, type BotLang } from "./game-names.js";

export * from "./options.js";
export * from "./commands.js";
export * from "./engine-options.js";
export * from "./launch-options.js";
export * from "./paldefender-options.js";
export * from "./pal-stats-options.js";
export * from "./features.js";
export * from "./world-presets.js";
export * from "./boss-respawn.js";
export * from "./game-names.js";
export * from "./map-helpers.js";
export * from "./pal-avatars.generated.js";
export * from "./log-events.js";
export * from "./webhooks.js";

/** Value type an option can hold at runtime. */
export type WorldOptionValue = string | number | boolean;
export type WorldSettings = Record<keyof typeof WORLD_OPTIONS, WorldOptionValue>;

function zodFor(meta: OptionMeta): z.ZodTypeAny {
  // .catch(default):單一欄位驗證失敗(超出範圍 / 型別錯 / 舊存檔的髒值)就退回預設,而不是
  // 讓整包 parse 丟例外。這很關鍵 —— store 載入時任一實例的任一設定超範圍,不該讓整個 agent
  // 開機崩潰(曾發生:ItemWeightRate 被存成 0、舊版 schema min 0.1 → agent 打不開)。
  switch (meta.type) {
    case "float": {
      // soft:只擋 NaN/Infinity 與非正值,上限放很寬(玩家想填極端值就讓他填,前端另做提醒);
      // 非 soft:照建議範圍嚴格限制。
      const b = z.number().finite();
      return (meta.soft ? b.min(0).max(100000) : b.min(meta.min).max(meta.max))
        .default(meta.default)
        .catch(meta.default);
    }
    case "int": {
      const b = z.number().int().finite();
      return (meta.soft ? b.min(0).max(1000000) : b.min(meta.min).max(meta.max))
        .default(meta.default)
        .catch(meta.default);
    }
    case "bool":
      return z.boolean().default(meta.default).catch(meta.default);
    case "enum":
      return z.enum(meta.choices as [string, ...string[]]).default(meta.default).catch(meta.default);
    case "string":
      return z.string().max(meta.maxLength).default(meta.default).catch(meta.default);
  }
}

const shape = Object.fromEntries(
  Object.entries(WORLD_OPTIONS).map(([key, meta]) => [key, zodFor(meta)]),
);

/** Full settings object; missing keys are filled with defaults on parse. */
export const WorldSettingsSchema = z.object(shape) as unknown as z.ZodType<WorldSettings>;

/** Partial patch used by PUT /instances/:id/settings. */
export const UpdateSettingsSchema = z
  .object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])))
  .strict() as unknown as z.ZodType<Partial<WorldSettings>>;

export const InstanceStatusSchema = z.enum([
  "created", // no runtime yet (never started, or removed) — start materializes it
  "installing", // native: server files downloading; watch the logs for progress
  "running",
  "restarting",
  "starting", // k8s: StatefulSet scaling up (Pod not ready yet)
  "exited",
  "missing",
]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

/** How the agent runs the server: native = spawn PalServer directly on the
 * host (default, no Docker needed); docker = run it in a container. */
export const BackendSchema = z.enum(["native", "docker", "k8s"]);
export type Backend = z.infer<typeof BackendSchema>;

export const CreateInstanceSchema = z.object({
  // 顯示名稱,允許中文、底線、破折號、空白等任意字元。實際的資料夾用隨機 id、
  // Docker 容器名會自動正規化,所以名稱不需要限制字元集,只要非空、長度合理即可。
  name: z.string().trim().min(1).max(40),
  backend: BackendSchema.default("native"),
  flavor: z.enum(["vanilla", "modded"]).default("vanilla"),
  /** docker only: 自訂容器鏡像(如 ghcr.io/…/palworld:tag);省略則用內建的
   * vanilla/modded 映像。方便沿用已在 Docker 部署的其他帕魯鏡像。 */
  dockerImage: z.string().trim().max(200).optional(),
  /** docker/k8s: 執行環境。"wine" = 跑 Windows binary via Wine(支援 PalDefender)。
   *  undefined 或 "native" = 原生 Linux binary。 */
  runtime: z.enum(["native", "wine"]).optional(),
  /** UDP port the server listens on (host port for docker)。
   *  省略 = 由 agent 自動分配(從 8211 起找沒被登記且 OS 綁得起來的埠)。 */
  gamePort: z.number().int().min(1024).max(65535).optional(),
  /** native only: custom server directory (absolute path). An existing
   * dedicated-server install (e.g. C:\steamcmd\steamapps\common\PalServer)
   * is adopted as-is; an empty or new directory becomes the install target.
   * Omit to install under the agent data folder. */
  serverDir: z.string().max(500).optional(),
  k8sNamespace: z.string().optional(),
  k8sStatefulSet: z.string().optional(),
  k8sServiceName: z.string().optional(),
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;

/**
 * 自訂帕魯(贊助者先行版功能 custom-pal):透過 PalDefender 的 PalTemplate + RCON
 * `givepal_j` 發一隻客製帕魯給玩家。欄位對應 PalTemplate:詞條=Passives、體質=IVs、
 * 星星=CondensedPals、靈魂=PalSouls。省略的欄位就用 PalDefender 預設。
 */
export const CustomPalSchema = z
  .object({
    /** 給予方式:pal=直接給帕魯(givepal_j,RCON);egg=給帕魯蛋(PalDefender REST,可指定玩家)。 */
    mode: z.enum(["pal", "egg"]).default("pal"),
    /** 目標玩家的 UserId。兩種模式都需要(egg 走 REST 的 /give/paleggs/{userId})。 */
    userId: z.string().trim().max(128).optional(),
    /** 蛋 ID,例:PalEgg_Ice_01(egg 模式必填)。 */
    eggId: z.string().trim().max(64).optional(),
    /** 帕魯種類 ID,例:Anubis(paldb.cc 可查)。 */
    palId: z.string().trim().min(1).max(64),
  nickname: z.string().trim().max(40).optional(),
  gender: z.enum(["Male", "Female", "None"]).optional(),
  /* max 255:遊戲內可偵測的最高等級。 */
  level: z.number().int().min(1).max(255).optional(),
  /** 主動技(最多 3 個技能 ID)。 */
  activeSkills: z.array(z.string().trim().min(1).max(64)).max(3).optional(),
  /** 詞條 / 被動技(技能 ID)。 */
  passives: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  /** 體質 / IV,0–255。 */
  ivs: z
    .object({
      health: z.number().int().min(0).max(255).optional(),
      attackMelee: z.number().int().min(0).max(255).optional(),
      attackShot: z.number().int().min(0).max(255).optional(),
      defense: z.number().int().min(0).max(255).optional(),
    })
    .optional(),
  /** 濃縮消耗隻數(PalDefender CondensedPals 吃數量,不是星星等級)。
   *  當前版本滿濃縮需 48 隻。 */
  condensedPals: z.number().int().min(0).max(48).optional(),
  /** 靈魂強化,每項 0–20。 */
  souls: z
    .object({
      health: z.number().int().min(0).max(20).optional(),
      attack: z.number().int().min(0).max(20).optional(),
      defense: z.number().int().min(0).max(20).optional(),
      craftSpeed: z.number().int().min(0).max(20).optional(),
    })
    .optional(),
    partnerSkillLevel: z.number().int().min(1).max(5).optional(),
  })
  .refine((d) => !!d.userId && (d.mode !== "egg" || !!d.eggId), {
    message: "需要目標玩家 userId;egg 模式另需 eggId",
  });
export type CustomPalInput = z.infer<typeof CustomPalSchema>;

/** 最後一次安裝/更新失敗的原因,讓 UI 不用翻日誌就能看到。
 *  code=disk-full 讓前端翻成友善的當地語言提示;其餘顯示 message 原文。 */
export interface InstallError {
  code: "disk-full" | "error";
  message: string;
}

export interface InstanceSummary {
  id: string;
  name: string;
  backend: Backend;
  flavor: "vanilla" | "modded";
  /** docker/k8s: "wine" = Windows binary via Wine; undefined = native. */
  runtime?: "native" | "wine";
  gamePort: number;
  status: InstanceStatus;
  createdAt: string;
  /** cached, so listing instances never hits the network */
  gameVersion: string | null;
  updateAvailable: boolean | null;
  /** installed enhancements (PalDefender / UE4SS), for the 原味/強化 label */
  enhancements: string[];
  /** 最後一次安裝/更新失敗的原因(成功或安裝中時為 null);僅 native。 */
  installError: InstallError | null;
  /** 安裝/更新進度百分比(0–100,DepotDownloader 輸出解析);非安裝中為 null。僅 native。 */
  installProgress: number | null;
}

export interface InstanceDetail extends InstanceSummary {
  settings: WorldSettings;
  /** agent 啟動時自動開服(每實例;在「設定」分頁切換)。 */
  autoStart?: boolean;
  /** docker: container id · native: process id (null when not running). */
  runtimeId: string | null;
  /** user-configured server dir; null when the agent picks the folder. */
  serverDir: string | null;
  /** the actual absolute path the server files live in — resolved even when
   * agent-managed (native only; null for docker). */
  effectiveServerDir: string | null;
}

export interface InstanceStats {
  /** null when a backend has not collected two valid samples yet. */
  cpuPercent: number | null;
  /** 主機/容器可用的邏輯核心數,讓前端判讀 cpuPercent 的滿載基準。 */
  cpuCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  /** 伺服器行程樹的行程數(native);docker 省略。 */
  processCount?: number;
  /** 行程已運行秒數(取主行程);取不到時省略。 */
  uptimeSeconds?: number;
}

/** Mod-management state for one instance (native backend only). */
export interface ModsStatus {
  /** false when the backend/platform can't manage mods (docker, non-adopted…). */
  supported: boolean;
  reason?: string;
  /** 伺服器本體檔案是否已就位;false = 尚未安裝完成(前端據此隱藏 pak 卡等)。
   *  舊版 agent 沒有此欄位 → 前端以 true 處理。 */
  serverInstalled?: boolean;
  /** enabled:false = 已「暫時停用」(主 DLL 改名保留,檔案都在);舊 agent 無此欄位。 */
  ue4ss: { installed: boolean; version: string | null; enabled?: boolean };
  paldefender: { installed: boolean; version: string | null; enabled?: boolean };
  /** UE4SS Lua mods found under the mods dir. */
  luaMods: { name: string; enabled: boolean }[];
  /** Server-dir-relative path of the Lua mods folder (layout varies by UE4SS
   * version); null when UE4SS isn't installed yet. */
  luaModsDir: string | null;
  /** .pak files under Pal/Content/Paks (excluding the game's own pak). */
  pakMods: string[];
}

export type ModComponent = "ue4ss" | "paldefender";

/* ── PalDefender REST API: player detail (pals & inventory) ── */

export interface PdPal {
  instanceId: string;
  palId: string;
  nickname: string;
  gender: string;
  level: number;
  shiny: boolean;
  /** which group it's in */
  location: "team" | "palbox" | "basecamp";
}

export interface PdItemSlot {
  itemId: string;
  count: number;
  container: string;
}

export interface PlayerDetail {
  available: boolean;
  reason?: string;
  name: string;
  playerUid: string;
  userId: string;
  guildName: string;
  pals: PdPal[];
  teamCount: number;
  palboxCount: number;
  items: PdItemSlot[];
  /** 玩家存在但 /pals 端點抓不到(PalDefender 目前未把 /pals 標為支援離線玩家)。 */
  palsUnavailable?: boolean;
  /** 玩家存在但 /items 端點抓不到(同上,離線玩家常見)。 */
  itemsUnavailable?: boolean;
  /** 已解鎖科技(PalDefender 1.8+ /techs);取不到時 null。 */
  techs: PlayerTechs | null;
  /** 進度概要(PalDefender 1.8+ /progression);取不到時 null。 */
  progression: PlayerProgression | null;
}

/** 玩家已解鎖的科技(PalDefender /techs)。 */
export interface PlayerTechs {
  unlocked: string[];
  unlockedCount: number;
  totalCount: number;
}

/** 玩家進度概要(PalDefender /progression 擷取重點)。 */
export interface PlayerProgression {
  level: number;
  exp: number;
  unusedStatusPoints: number;
  technologyPoints: number;
  ancientTechnologyPoints: number;
  /** 擊敗頭目總數 */
  bossesDefeated: number;
  /** 捕捉過的帕魯種類數(tribeCaptureCount) */
  palsCaptured: number;
}

/** PalDefender /players 的一筆玩家(線上 + 離線的統一名冊)。 */
export interface PdPlayerSummary {
  name: string;
  userId: string;
  playerUid: string;
  guildName: string;
  /** Status 為 Online 時 true。 */
  online: boolean;
  ip: string;
  /** 最後存檔的世界座標(Unreal;WorldLocation)。前端走 savToMap 畫到地圖,
   * 讓離線玩家也能在地圖上顯示最後位置。拿不到時為 undefined。 */
  worldX?: number;
  worldY?: number;
}

/** PalDefender /players 回傳:存檔內所有玩家(含離線)。 */
export interface PdPlayerList {
  available: boolean;
  reason?: string;
  onlineCount: number;
  totalCount: number;
  players: PdPlayerSummary[];
}

/** 一個公會據點。座標用 world_pos(Unreal 世界座標),前端一律走 savToMap 轉圖上座標,
 * 跟玩家點用同一套轉換,保證對齊。 */
export interface PdGuildBase {
  id: string;
  worldX: number;
  worldY: number;
}

/** PalDefender /guilds 的一個公會。 */
export interface PdGuild {
  id: string;
  name: string;
  level: number;
  adminName: string;
  memberCount: number;
  /** 成員的 PlayerUID 清單。 */
  members: string[];
  bases: PdGuildBase[];
}

/** PalDefender /guilds 回傳。`detailed` = 有贊助者授權、可看名稱/成員等細節;
 * 沒授權時仍給據點位置(bases),但 name/level/members 會被清空。 */
export interface PdGuildList {
  available: boolean;
  detailed: boolean;
  reason?: string;
  guilds: PdGuild[];
}

/** GET /guild/{id} 的一名成員。 */
export interface PdGuildMember {
  playerUid: string;
  name: string;
  status: string;
}

/** GET /guild/{id} 的一個據點(比 /guilds 多了等級與狀態)。 */
export interface PdGuildCamp {
  id: string;
  level: number;
  worldX: number;
  worldY: number;
  state: string;
}

/** GET /guild/{id} 的公會詳情(贊助者功能)。 */
export interface PdGuildDetail {
  available: boolean;
  reason?: string;
  id: string;
  name: string;
  level: number;
  adminName: string;
  memberCount: number;
  members: PdGuildMember[];
  camps: PdGuildCamp[];
}

/** Whether the agent can reach PalDefender's REST API for this instance. */
export interface PdRestStatus {
  /** PalDefender plugin present */
  installed: boolean;
  /** RESTConfig.json exists (generated on first boot) */
  configExists: boolean;
  /** REST enabled in RESTConfig.json */
  enabled: boolean;
  /** the agent has a usable bearer token */
  hasToken: boolean;
  /** REST API 監聽的埠(RESTConfig.json 的 Port,預設 17993) */
  port: number;
  reason?: string;
}

/* ── PalDefender whitelist & banlist ──
 * Read from the plugin's JSON files (so the lists show even when the server
 * is down); changes go through RCON commands, per the plugin's own guidance
 * not to hand-edit these files. */

export interface WhitelistEntry {
  /** either a player UserId or an IP (possibly a masked range) */
  value: string;
  isIp: boolean;
}

export interface BanEntry {
  userId: string | null;
  ip: string | null;
  reason?: string;
}

export interface ModerationLists {
  supported: boolean;
  reason?: string;
  /** whether useWhitelist is on in Config.json */
  whitelistEnabled: boolean;
  whitelist: WhitelistEntry[];
  bans: BanEntry[];
}

/** A log stream the instance can serve. `agent` is our own capture (install
 * progress + stdout); `game` is the server's UE log; `paldefender` is the
 * plugin's own rotating log. */
export type LogSourceId = "agent" | "game" | "paldefender";

export interface LogSource {
  id: LogSourceId;
  label: string;
  /** false when the underlying file/dir doesn't exist (yet). */
  available: boolean;
}

/** One entry in the instance file browser (rooted at the server dir). */
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
  /** text file, small enough to open in the editor */
  editable: boolean;
}

export interface FileContent {
  path: string;
  content: string;
}

/* ── Palworld server REST API (docs.palworldgame.com/api/rest-api) ──
 * The agent proxies these; the game's own API is never exposed to the UI. */

export interface RestPlayer {
  name: string;
  accountName: string;
  playerId: string;
  userId: string;
  ip: string;
  ping: number;
  location_x: number;
  location_y: number;
  level: number;
  building_count: number;
}

export interface RestServerInfo {
  version: string;
  servername: string;
  description: string;
  worldguid: string;
}

export interface RestMetrics {
  serverfps: number;
  currentplayernum: number;
  serverframetime: number;
  maxplayernum: number;
  uptime: number;
  basecampnum: number;
  days: number;
}

/* ── REST /game-data (Palworld 1.0+): world actor snapshot ── */

export interface GameDataActor {
  Type: "Character" | "PalBox";
  UnitType?: "Player" | "OtomoPal" | "BaseCampPal" | "WildPal" | "NPC";
  InstanceID: string;
  NickName: string;
  TrainerInstanceID?: string;
  TrainerNickName?: string;
  userid?: string;
  ip?: string;
  level?: number;
  HP?: number;
  MaxHP?: number;
  GuildID?: string;
  GuildName?: string;
  LocationX: number;
  LocationY: number;
  LocationZ: number;
}

export interface GameDataSnapshot {
  Time: string;
  FPS: number;
  AverageFPS: number;
  ActorData: GameDataActor[];
}

/* World-coordinate conversion. The REST API reports Unreal/save-file
 * coordinates; the in-game map uses a [-1000, 1000] square. Offsets are the
 * midpoints of the sav bounds and the scale is sav units per map unit, from
 * the game's DT_WorldMapUIData.
 *
 * Unreal's axes are X = north(+) / south(-) and Y = east(+) / west(-), so the
 * map's horizontal axis comes from sav Y and its vertical axis from sav X —
 * they are NOT parallel. Cross-checked against the world bounds:
 *   sav X -582888..335112 → map y (north) -1000..1000
 *   sav Y -301000..617000 → map x (east)  -1000..1000
 */
export const WORLD_OFFSET = { northSouth: 123888, eastWest: -158000 } as const;
export const WORLD_SCALE = 459;
export const MAP_BOUND = 1000;

/** Map coordinates as the game shows them: x grows east, y grows north.
 *  這組小座標(約 -1000~1000)正是 PalDefender tp / spawn 等指令吃的「Map coordinates」,
 *  所以地圖描點直接用 Leaflet 的 latlng(lat=mapY, lng=mapX)即可,不需再轉世界座標。 */
export function savToMap(savX: number, savY: number): { x: number; y: number } {
  return {
    x: (savY + WORLD_OFFSET.eastWest) / WORLD_SCALE,
    y: (savX + WORLD_OFFSET.northSouth) / WORLD_SCALE,
  };
}

/** 世界樹(1.0 終局區域)是獨立座標區,不在主世界底圖上。
 *  邊界來源:paldb.cc treemap_data_en.js 的 landScapeRealPositionMin/Max
 *  (研究依據 .claude/notes/worldtree-map-research.md);主世界 X 上限 349400,
 *  兩區僅在 X∈[347351.5,349400] 極窄角落重疊(0.14%,實際是海/空白)。 */
export const WORLD_TREE_BOUNDS = {
  min: { x: 347351.5, y: -818197 },
  max: { x: 689148.5, y: -476400 },
} as const;

/** 這個世界座標是否落在世界樹(用 X 軸判別,比 Y 乾淨)。 */
export function isWorldTreeCoord(savX: number): boolean {
  return savX > 350000;
}

/** 世界座標 → 世界樹地圖座標:±1000 正方形,底圖 worldtree-map.webp 的四角
 *  即 WORLD_TREE_BOUNDS(與主世界同款線性縮放+XY 對調;X/Y span 相等,正方形)。 */
export function savToWorldTreeMap(savX: number, savY: number): { x: number; y: number } {
  const span = WORLD_TREE_BOUNDS.max.x - WORLD_TREE_BOUNDS.min.x;
  return {
    x: ((savY - WORLD_TREE_BOUNDS.min.y) / span) * 2000 - 1000,
    y: ((savX - WORLD_TREE_BOUNDS.min.x) / span) * 2000 - 1000,
  };
}

/** A player the agent has seen at least once on this instance — the roster
 * that survives logouts, so offline targets (e.g. /unban) stay selectable. */
export interface KnownPlayer {
  userId: string;
  name: string;
  accountName: string;
  online: boolean;
  firstSeen: string;
  lastSeen: string;
  /** completed sessions (a session still in progress isn't counted yet) */
  sessions: number;
  playtimeSeconds: number;
  lastLevel: number;
  /** 公會名(僅 PalDefender 名冊有;agent 自記錄的沒有)。 */
  guildName?: string;
}

export interface PresenceEvent {
  at: string;
  type: "join" | "leave";
  userId: string;
  name: string;
}

/** Aggregated live view; `available` is false when the server is down or
 * the REST API / admin password isn't configured. */
export interface LiveStatus {
  available: boolean;
  reason?: string;
  info: RestServerInfo | null;
  metrics: RestMetrics | null;
  players: RestPlayer[];
}

/* ── world saves & backups ── */

export interface PlayerSave {
  file: string;
  /** the .sav filename without extension — Palworld's internal PlayerUid */
  playerUid: string;
  sizeBytes: number;
  /** 檔案最後修改時間(k8s 後端拿不到,可能缺)。 */
  modifiedAt?: string;
  /** 匯入外部存檔「之後」才出現的角色檔(比對匯入時的快照)——共玩搬家時,
   *  這幾乎就是主機玩家加入後產生的新角色檔。無快照(非 GUI 匯入)則缺。 */
  newSinceImport?: boolean;
}

/** 共玩主機玩家的固定 PlayerUid,「檔名形式」(32 hex 無連字號,同 PlayerSave.playerUid)。
 *  見 docs/MIGRATION.md 情境 C 與內建主機角色修復。 */
export const COOP_HOST_UID = "00000000000000000000000000000001";

/** 主機角色修復(內建 palworld-host-save-fix)的結果。 */
export interface HostFixResult {
  /** 修復前的舊 PlayerUid(通常是共玩主機的 0000…0001)。 */
  oldUid: string;
  /** 角色資料移交過去的新 PlayerUid。 */
  newUid: string;
  /** Level.sav 裡被改寫的角色條目數(正常恰為 1)。 */
  patchedLevelEntries: number;
  /** 一併過戶的帕魯數(OwnerPlayerUId 由舊 uid 改為新 uid)。 */
  patchedPalOwners: number;
  /** 修復前自動備份的檔名。 */
  backup: string;
}

export interface WorldSave {
  guid: string;
  /** true when GameUserSettings.ini's DedicatedServerName points here */
  active: boolean;
  sizeBytes: number;
  modifiedAt: string;
  playerSaves: PlayerSave[];
  /** 共玩存檔遺留的 WorldOptions.sav 存在時為 true —— 它會覆蓋 ini 的世界設定
   *  (含 AdminPassword),必須停用伺服器才會改讀 GUI 管理的 ini。 */
  hasWorldOptions?: boolean;
}

export interface BackupInfo {
  name: string;
  worldGuid: string;
  sizeBytes: number;
  createdAt: string;
  /** true when the server flushed the world to disk before archiving */
  flushedBeforeBackup?: boolean;
}

/** Scheduled backups of the active world, run by the agent. */
export interface BackupSchedule {
  enabled: boolean;
  /** minutes between backups */
  intervalMinutes: number;
  /** how many archives of a world to keep; older ones are pruned */
  keep: number;
  /** skip a run when nobody is online (avoids piles of identical archives) */
  skipWhenEmpty: boolean;
  lastRunAt?: string;
  lastResult?: string;
}

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  // 預設啟用:沒動過備份設定的實例自動每小時備份(明確關閉過的照舊)。
  enabled: true,
  intervalMinutes: 60,
  keep: 10,
  skipWhenEmpty: true,
};

export interface SavesStatus {
  supported: boolean;
  reason?: string;
  worlds: WorldSave[];
  backups: BackupInfo[];
  schedule: BackupSchedule;
}

/* ── save health check (save-slim, stage 1: read-only) ── */

export interface SaveHealthCounts {
  players: number;
  /** players last seen more than 30 days before the save's mtime */
  playersInactive30d: number;
  pals: number;
  guilds: number;
  guildsEmpty: number;
  itemContainers: number;
  /** containers whose every slot is empty — looted-chest residue */
  itemContainersEmpty: number;
  itemSlots: number;
  charContainers: number;
  mapObjects: number;
  dropItems: number;
  dynamicItems: number;
}

export interface SaveHealthPlayerRow {
  name: string;
  uid: string;
  /** null when the timestamp is missing or implausible */
  lastOnlineDaysAgo: number | null;
  guildName: string;
}

export interface SaveHealthReport {
  worldGuid: string;
  generatedAt: string;
  /** release tag of the palsav tool that produced the JSON */
  toolTag: string;
  levelSavBytes: number;
  /** mtime of Level.sav at analysis time — the "now" that day counts are relative to */
  levelSavMtime: string;
  playersDirBytes: number;
  playerSavCount: number;
  worldDirBytes: number;
  counts: SaveHealthCounts;
  /** sorted by days offline, descending; capped at 100 */
  inactivePlayers: SaveHealthPlayerRow[];
  /** capped at 50 */
  emptyGuildNames: string[];
  /** worldSaveData 頂層 section 名稱清單 —— 診斷用(判斷某類資料是否存在於
   *  存檔,例:有沒有 boss spawner 之類的 section 可以接) */
  worldSections?: string[];
}

/** 存檔掃描順帶建立的「玩家快照」— 玩家詳情頁的檔案級資料來源。 */
export interface SavePalRow {
  /** 角色實例 id(CharacterSaveParameterMap key.InstanceId)— 與 PalDefender
   *  REST 的 PdPal.instanceId 同源,可跨資料來源精準對上同一隻帕魯。 */
  instanceId: string;
  /** 物種 id(CharacterID;BOSS_ 前綴 = 首領/alpha 個體) */
  characterId: string;
  nickname?: string;
  level: number | null;
  gender: "male" | "female" | null;
  /** 星級(Rank,0/1 = 未強化) */
  rank: number;
  isLucky: boolean;
  isBoss: boolean;
  talentHp: number | null;
  talentShot: number | null;
  talentDefense: number | null;
  passives: string[];
  /** 依所在容器分類:party = 玩家身上(隊伍)、palbox = 帕魯箱、base = 據點/其他容器;
   *  unknown = 玩家 .sav 解析不到容器對照(舊快照或解析失敗)。 */
  location: "party" | "palbox" | "base" | "unknown";
  /** 所在容器的零基槽位;舊快照可能沒有此欄位。 */
  slotIndex?: number | null;
  /** 據點工作帕魯的位置;舊快照或非據點帕魯沒有此欄位。 */
  base?: {
    id: string;
    name: string;
    guildId: string;
    guildName: string;
    /** 世界座標(sav 座標系;web 端用 savToMap 轉地圖座標) */
    x: number;
    y: number;
  };
}

export interface SaveItemStack {
  itemId: string;
  count: number;
}

/** 離線物品清單:玩家 .sav 的容器 id × Level.sav 的容器內容 join 而來。 */
export interface SavePlayerInventory {
  /** 金幣(static_id "Money" 的總數,已從各清單中抽出) */
  money: number;
  /** 背包 */
  common: SaveItemStack[];
  /** 重要物品(關鍵道具) */
  essential: SaveItemStack[];
  /** 武器欄 */
  weapons: SaveItemStack[];
  /** 防具/飾品欄 */
  armor: SaveItemStack[];
  /** 食物欄 */
  food: SaveItemStack[];
}

export interface SaveGuildBase {
  id: string;
  name: string;
  /** 世界座標(sav 座標系;web 端用 savToMap 轉地圖座標) */
  x: number;
  y: number;
}

export interface SavePlayerGuild {
  name: string;
  role: "admin" | "member";
  memberCount: number;
  /** 公會的據點等級(整個公會共用) */
  baseCampLevel: number | null;
  bases: SaveGuildBase[];
}

export interface SavePlayerProfile {
  uid: string;
  name: string;
  level: number | null;
  exp: number | null;
  guildName: string | null;
  lastOnlineDaysAgo: number | null;
  palCount: number;
  /** 依等級降冪;超過上限只留前段(palCount 仍是真實總數) */
  pals: SavePalRow[];
  /** 離線物品;玩家 .sav 解析不到容器 id 時為 null(舊快照/解析失敗) */
  inventory?: SavePlayerInventory | null;
  /** 公會職位與據點;不在任何公會(或舊快照)為 null */
  guild?: SavePlayerGuild | null;
  /** 加點分配:存檔內部名稱(日文,如「最大HP」)→ 點數;UI 負責在地化 */
  statusPoints?: { name: string; points: number }[];
  unusedStatusPoints?: number | null;
  /** 圖鑑捕捉紀錄:曾捕捉過的物種 characterId 清單(玩家 .sav 的 RecordData.PalCaptureCount)。
   *  解析不到(舊快照/玩家檔壞掉)為 null。 */
  paldeck?: string[] | null;
}

export interface SaveGuildWorkerPal {
  characterId: string;
  level: number | null;
}

/** 公會完整檔案(存檔掃描產出;公會頁用)。 */
export interface SaveGuild {
  id: string;
  name: string;
  adminUid: string | null;
  baseCampLevel: number | null;
  members: { uid: string; name: string; lastOnlineDaysAgo: number | null }[];
  /** 據點含駐守工作帕魯(WorkerDirector 容器) */
  bases: (SaveGuildBase & { workers: SaveGuildWorkerPal[] })[];
  /** 公會倉庫內容;掃描時解析不到(舊快照)為 null */
  storage: SaveItemStack[] | null;
  /** 公會研究:進行中的研究 id 與各項累積工作量;無資料為 null */
  research: { currentId: string | null; entries: { id: string; workAmount: number }[] } | null;
}

export interface SavePlayersSnapshot {
  worldGuid: string;
  generatedAt: string;
  levelSavMtime: string;
  players: SavePlayerProfile[];
  /** 公會清單(較晚加入的欄位;舊快照沒有) */
  guilds?: SaveGuild[];
  /** 據點工作容器中的完整帕魯個體;較晚加入,舊快照沒有。 */
  basePals?: SavePalRow[];
}

/** 快照清單回應:玩家欄位齊全但不含 pals 明細(單一玩家詳情另查)。 */
export interface SavePlayersSummary {
  generatedAt: string | null;
  levelSavMtime: string | null;
  players: Omit<SavePlayerProfile, "pals">[];
}

/** 配種計算器使用的輕量存檔快照。保留個體來源,方便玩家回到正確的帕魯箱找雙親。 */
export interface SaveBreedingPal extends SavePalRow {
  ownerUid: string;
  ownerName: string;
  /** 主人所屬公會;選定玩家時用來自動納入同公會據點帕魯。 */
  ownerGuildId?: string;
}

export interface SaveBreedingSnapshot {
  worldGuid: string;
  generatedAt: string | null;
  pals: SaveBreedingPal[];
}

/** 每次掃描落地的精簡統計(排行榜/週報用;存 save-stats-history.json,追加不覆蓋)。 */
export interface SaveScanTopPal {
  characterId: string;
  nickname?: string;
  level: number | null;
  /** 星級(rank 0/1=未強化) */
  rank: number | null;
  /** 三項個體值加總(0-300) */
  ivTotal: number;
  passiveCount: number;
  /** 詞條 id 清單(最多 8;舊統計沒有此欄位) */
  passives?: string[];
}

/** 最強帕魯加權評分 — agent 選各玩家最強帕魯與前端榜單排序共用,改公式兩邊一起改。
 *  等級 1:1、IV 總和 ×0.1(滿 300 折 30)、星級 ×10(滿 4 星折 40)、詞條數 ×5。 */
export function topPalScore(tp: Pick<SaveScanTopPal, "level" | "rank" | "ivTotal" | "passiveCount">): number {
  const stars = Math.max((tp.rank ?? 0) - 1, 0);
  return (tp.level ?? 0) + tp.ivTotal * 0.1 + stars * 10 + tp.passiveCount * 5;
}

/** 每小時自動掃描存檔(排行榜/週報的資料來源;與備份排程同款的每實例設定檔)。 */
export interface AutoScanSetting {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string | null;
  lastResult?: string | null;
}

export const DEFAULT_AUTO_SCAN: AutoScanSetting = { enabled: false, intervalMinutes: 60 };

export interface SaveScanPlayerStat {
  uid: string;
  name: string;
  level: number | null;
  /** 金錢;解析不到為 null */
  money: number | null;
  palCount: number;
  /** 圖鑑捕捉物種數;解析不到為 null */
  paldeckCount: number | null;
  /** 最強帕魯(等級→IV 總和→星級排序的第一名);沒帕魯為 null */
  topPal: SaveScanTopPal | null;
}

export interface SaveScanGuildStat {
  id: string;
  name: string;
  memberCount: number;
  baseCount: number;
  baseCampLevel: number | null;
  /* 以下為深度比較欄位(2026-07 追加;舊統計沒有,消費端要容忍 undefined) */
  /** 成員平均/最高等級(只算等級已知的成員;無資料為 null) */
  avgLevel?: number | null;
  maxLevel?: number | null;
  /** 7 天內上線過的成員數 */
  activeMembers?: number;
  /** 各據點駐守工作帕魯總數 */
  workerPals?: number;
  /** 公會倉庫物品種類數(掃不到為 null) */
  storageKinds?: number | null;
  /** 公會研究已投入項目數(掃不到為 null) */
  researchDone?: number | null;
  /** 成員金錢合計(可解析者) */
  totalMoney?: number;
  /** 成員名下帕魯合計 */
  totalPals?: number;
}

/** 公會綜合實力評分 — 排行榜排序用,公式顯示在榜單副標,改公式同步改文案。
 *  平均等級 + 活躍成員×5 + 據點×8 + 據點等級×3 + 駐守帕魯×0.5 + 研究×2。 */
export function guildScore(g: SaveScanGuildStat): number {
  return (
    (g.avgLevel ?? 0) +
    (g.activeMembers ?? 0) * 5 +
    g.baseCount * 8 +
    (g.baseCampLevel ?? 0) * 3 +
    (g.workerPals ?? 0) * 0.5 +
    (g.researchDone ?? 0) * 2
  );
}

export interface SaveScanStats {
  scannedAt: string;
  levelSavMtime: string;
  players: SaveScanPlayerStat[];
  guilds: SaveScanGuildStat[];
}

export type SaveHealthPhase = "idle" | "download" | "convert" | "analyze";

export interface SaveHealthStatus {
  supported: boolean;
  reason?: string;
  phase: SaveHealthPhase;
  /** null while progress is indeterminate (the convert phase) */
  progressPct: number | null;
  error: string | null;
  report: SaveHealthReport | null;
}

/* ── automatic restarts ── */

export type RestartReason = "scheduled" | "memory" | "crash" | "manual" | "startup-failure";

export interface RestartPolicy {
  /** Restart on a timer: every N minutes, or at fixed times of day. */
  scheduled: {
    enabled: boolean;
    mode: "interval" | "daily";
    intervalMinutes: number;
    /** "HH:MM" in the agent host's local time */
    dailyTimes: string[];
  };
  /** Restart when the server's memory stays above a threshold. */
  memory: {
    enabled: boolean;
    thresholdMB: number;
    /** consecutive 30s checks above the threshold before acting (ignores spikes) */
    sustainedChecks: number;
  };
  /** Bring the server back after it exits on its own. */
  crash: {
    enabled: boolean;
    /** give up (and stop retrying) beyond this many restarts in one hour */
    maxPerHour: number;
  };
  /** Warn players over the REST API before a planned restart. 0 = no warning. */
  announceSeconds: number;
  /** 自動重啟倒數公告的在地化模板:GUI 儲存設定時以「當下介面語言」寫入,
   *  agent 端沒有 UI 語言概念,只套模板({n}=秒數、{reason}=原因標籤)。
   *  沒存過(舊設定)時 agent 退回內建繁中訊息。 */
  announceTemplates?: {
    /** 例:"伺服器將在 {n} 秒後重新啟動({reason})" */
    restart: string;
    /** {reason} 的標籤:排定重啟 / 記憶體超標 */
    reasonScheduled: string;
    reasonMemory: string;
  };
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  scheduled: { enabled: false, mode: "interval", intervalMinutes: 360, dailyTimes: ["05:00"] },
  memory: { enabled: false, thresholdMB: 12288, sustainedChecks: 3 },
  crash: { enabled: true, maxPerHour: 5 },
  announceSeconds: 30,
};

export interface RestartEvent {
  at: string;
  reason: RestartReason;
  ok: boolean;
  detail: string;
}

export interface RestartStatus {
  supported: boolean;
  reason?: string;
  policy: RestartPolicy;
  events: RestartEvent[];
  restartsLastHour: number;
  /** current memory of the server process tree, when running */
  memoryMB: number | null;
}

/* ── game version / updates ── */

export interface VersionStatus {
  supported: boolean;
  reason?: string;
  /** the game's own version string, e.g. "v0.7.2" (from REST /info or RCON Info) */
  gameVersion: string | null;
  /** manifest id of the installed content depot */
  installedBuild: string | null;
  /** manifest id on Steam's public branch */
  latestBuild: string | null;
  latestUpdatedAt: string | null;
  /** null when we can't tell (adopted Steam install, or Steam unreachable) */
  updateAvailable: boolean | null;
  checkedAt: string | null;
}

/* ── config-file health (PalWorldSettings.ini / Engine.ini) ── */

export interface FileHealth {
  exists: boolean;
  corrupted: boolean;
  reason?: string;
  /** server-dir-relative path, or null when unsupported */
  path: string | null;
}

export interface ConfigHealth {
  supported: boolean;
  world: FileHealth;
  engine: FileHealth;
}

/* ── INI configuration snapshots ── */

export type ConfigSnapshotFileName = "PalWorldSettings.ini" | "Engine.ini";

/** The only files a configuration snapshot may contain. */
export interface ConfigSnapshotFiles {
  /** null means the server has not generated this file yet. */
  "PalWorldSettings.ini": string | null;
  "Engine.ini": string | null;
}

export interface ConfigSnapshotMetadata {
  instanceId: string;
  backend: Backend;
}

/** JSON payload stored below an instance's config-backups directory. */
export interface ConfigSnapshot {
  files: ConfigSnapshotFiles;
  metadata: ConfigSnapshotMetadata;
  reason: string;
  createdAt: string;
  /** UTF-8 byte size of the INI files that exist. */
  size: number;
}

/** Snapshot payload plus its agent-generated, filesystem-safe identifier. */
export interface ConfigSnapshotInfo extends ConfigSnapshot {
  id: string;
}

export interface ConfigSnapshotList {
  supported: boolean;
  reason?: string;
  snapshots: ConfigSnapshotInfo[];
}

/** How a friend can reach this server (LAN / VPN / public). */
/**
 * 認出常見「遊戲用 VPN」的位址,回傳顯示名稱;不是已知 VPN 就回 null。這些 VPN 都在
 * 固定網段配發位址,可直接從 IP 判斷:
 *  - Tailscale:100.64.0.0/10(CGNAT 保留段)
 *  - Radmin VPN:26.0.0.0/8
 *  - Hamachi:25.0.0.0/8
 */
export function detectVpn(ip: string): string | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const [a, b] = p.map(Number);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  if (a === 100 && b >= 64 && b <= 127) return "Tailscale";
  if (a === 26) return "Radmin";
  if (a === 25) return "Hamachi";
  return null;
}

export interface ConnectionInfo {
  gamePort: number;
  /** private LAN addresses (same-network friends) */
  lan: string[];
  /** 偵測到的 VPN 位址(Tailscale / Radmin VPN / Hamachi …),各附顯示名稱 */
  vpns: { name: string; address: string }[];
  /** public IP, best-effort (null when unknown/offline) */
  publicIp: string | null;
  /** host is behind a router → direct connect needs port forwarding */
  behindNat: boolean;
  /** 使用者設定的公開位址(playit.gg 隧道等;null = 未設定) */
  externalAddress: string | null;
}

export interface AgentInfo {
  name: string;
  version: string;
  dockerVersion: string;
  instanceCount: number;
  /** 此請求是否已授權(本機 loopback 或帶了正確 token)。前端據此決定直接進入或引導配對。 */
  authenticated: boolean;
  /** agent 所在主機平台(process.platform:darwin / win32 / linux)。前端用來提示 macOS 限制。 */
  platform: string;
  /** agent 主機 CPU 架構(process.arch:arm64 / x64 / arm 等)。arm64 不支援 wine,前端據此隱藏 wine checkbox。 */
  arch: string;
  /** Linux 主機是否安裝了 Wine(native backend modded 需要走 Wine)。 */
  wineAvailable: boolean;
  /** 此平台可用的 backend 清單。前端依此動態顯示/隱藏 backend 選項。
   * Windows 只支援 native（Docker Desktop UDP 不可靠）；
   * Linux 支援 native/docker/k8s；macOS 只支援 native（無 Palworld server binary）。 */
  availableBackends: Backend[];
}

/** GUI 自我更新的偏好設定(存在 agent 的 data dir)。 */
export interface AgentUpdatePrefs {
  /** 定期到 GitHub 查有沒有新版(只查、不裝)。 */
  autoCheck: boolean;
  /** 查到新版就自動裝好並重啟 agent。預設關閉 —— 更新是使用者的決定。 */
  autoApply: boolean;
  /** prerelease 也算數(alpha/beta 使用者)。 */
  channel: "stable" | "prerelease";
  /** true = 被 PALSERVER_AUTO_UPDATE=0 強制停用,以上開關無效。 */
  envDisabled: boolean;
}

/** 自我更新的階段;idle 以外都代表 applyUpdate() 正在跑。 */
export type UpdatePhase = "idle" | "downloading" | "verifying" | "extracting" | "swapping" | "restarting";

export interface AgentUpdateStatus {
  /** 只有免安裝執行檔(SEA)能自我更新;開發模式 / npm 安裝不行。 */
  supported: boolean;
  /** supported=false 或檢查失敗時的說明。 */
  reason?: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  downloadSizeBytes: number | null;
  checkedAt: string | null;
  phase: UpdatePhase;
  /** downloading 階段的進度 0–100,其他階段為 null。 */
  progress: number | null;
  /** 上次更新失敗的原因(成功或沒跑過為 null)。 */
  lastError: string | null;
  prefs: AgentUpdatePrefs;
}

export interface ApiError {
  error: string;
}

/* ── 匯入外部存檔(其他專用伺服器 / 本機共玩存檔 / 舊版 v1 GUI)── */

/** 掃描外部路徑找到的可匯入世界。 */
export interface ExternalWorldCandidate {
  /** 資料夾名,匯入後沿用為世界 GUID。 */
  guid: string;
  /** 絕對路徑,回填給匯入請求的 worldPath。 */
  path: string;
  sizeMB: number;
  /** Players/*.sav 數量。 */
  players: number;
  lastModified: string;
  /** 含本機共玩的主機玩家存檔(…0001.sav)→ 需跑 host-save-fix,前端要警告。 */
  coopHost: boolean;
}

export interface ImportSaveResult {
  worldGuid: string;
  /** 匯入前是否有自動備份原本的啟用世界。 */
  backedUp: boolean;
  /** 匯入時發現共玩遺留的 WorldOptions.sav 並已自動停用(改名保留)。 */
  worldOptionsDisabled?: boolean;
}

/* ── 公開地圖(伺服器主一鍵把地圖公開到全網)──
 * agent 定時把「已在 agent 端過濾好」的快照推到雲端 Worker,公開 viewer 只讀 Worker,
 * 不會直接連到 agent。發布金鑰(secret)不放在這個型別裡 —— 它只存在 agent 端,詳見
 * packages/agent/src/public-map.ts。 */

/** 每實例的公開地圖發布設定(前端可見/可改的部分)。 */
export interface PublicMapSettings {
  enabled: boolean;
  /** 公開分享 ID(進 viewer 網址的 ?s= 參數)。啟用時由 agent 產生;停用後保留,
   *  重新啟用沿用同一個,除非呼叫 rotate。 */
  shareId?: string;
  showPlayers: boolean;
  showPlayerNames: boolean;
  showOfflinePlayers: boolean;
  showBases: boolean;
  showGuildNames: boolean;
  /** 頭目重生:在公開地圖疊野外/封印頭目的死活與重生倒數,並顯示地下城頭目層。
   *  需伺服器已安裝 PalserverBossReporter 模組(否則快照無資料,viewer 開關不出現)。 */
  showBossRespawns: boolean;
  /** 發布延遲(分鐘):0 = 即時;5 / 15 = 發布 N 分鐘前的緩衝快照,防止即時 PvP 用地圖抓位置。 */
  delayMinutes: 0 | 5 | 15;
}

export const DEFAULT_PUBLIC_MAP_SETTINGS: PublicMapSettings = {
  enabled: false,
  showPlayers: true,
  showPlayerNames: false,
  showOfflinePlayers: false,
  showBases: true,
  showGuildNames: false,
  showBossRespawns: false,
  delayMinutes: 0,
};

/** 上次推送雲端 Worker 的結果,供管理頁顯示。 */
export interface PublicMapPublishResult {
  at: number;
  ok: boolean;
  error?: string;
}

/** GET / PUT /api/instances/:id/public-map 的回應形狀。 */
export interface PublicMapStatus {
  settings: PublicMapSettings;
  shareUrl: string | null;
  lastPublish: PublicMapPublishResult | null;
}

/** 一條事件通知路由:一組事件 → 一個 Discord 頻道。bot 可設多條,達成「不同事件送不同頻道」
 *  (例:聊天獨立一個頻道)或「同組事件送多個頻道」(bot 同時在多個 Discord 伺服器/群組時)。 */
export interface DiscordNotifyRoute {
  /** 這條路由要貼到的 Discord 頻道 id。 */
  channelId: string;
  /** 要送到此頻道的事件型別(同 webhook 訂閱語法:精確 / "player.*" / "*")。 */
  events: string[];
}

/** 同機 Discord bot(agent 自跑並監督;見 packages/agent/src/discord-bot-manager.ts)前端可見/可改的設定。
 *  token 不放這個型別 —— 只寫入 agent 端,前端靠 DiscordBotStatus.tokenSet 得知是否已設。 */
export interface DiscordBotSettings {
  enabled: boolean;
  /** 管理員白名單:只有這些 Discord user id 能用管理指令(broadcast/restart/kick/ban/rcon…)。
   *  留空 = 沒有人能用管理指令(whitelist-only,不看 Discord 伺服器管理員權限)。 */
  adminUserIds: string[];
  /** 事件通知路由:每條 = 一組事件 → 一個頻道(空陣列 = 不發通知)。bot 用 gateway 直接貼,免另設 webhook URL。
   *  同一事件命中多條路由時會貼到多個頻道(bot 需在各該頻道有發言權限)。 */
  notifyRoutes: DiscordNotifyRoute[];
  /** 狀態面板頻道 id(留空 = 不顯示):bot 在該頻道維護一則每分鐘自動更新的伺服器狀態 embed。 */
  statusChannelId?: string;
  /** bot 輸出與事件通知的語言(en / ja / zh-TW / zh-CN)。 */
  language: BotLang;
}

export const DEFAULT_DISCORD_BOT_SETTINGS: DiscordBotSettings = {
  enabled: false,
  adminUserIds: [],
  notifyRoutes: [],
  language: DEFAULT_BOT_LANG,
};

/** 同機 bot 子行程的一行輸出(供 GUI「Discord Bot」分頁的日誌檢視)。 */
export interface DiscordBotLogLine {
  /** epoch ms。 */
  at: number;
  level: "info" | "error";
  line: string;
}

/** GET / PUT /api/instances/:id/discord-bot 的回應形狀。永不含 token 本身。 */
export interface DiscordBotStatus {
  settings: DiscordBotSettings;
  /** 是否已設定 bot token(不回傳 token 本身,僅告知有無)。 */
  tokenSet: boolean;
  /** bot 子行程目前是否在執行(agent 同機自跑)。 */
  running: boolean;
  /** 最近一次非預期退出/連線失敗的簡述(達重啟上限而停用時亦記於此),供 UI 顯示。 */
  lastError?: string;
}

/** 快照裡的座標屬於主世界底圖還是世界樹(見 savToMap / savToWorldTreeMap)。 */
export type PublicMapArea = "world" | "tree";

/** 快照裡的一個玩家點(在線或離線,同一形狀)。 */
export interface PublicMapPlayerPoint {
  /** 名字,或關閉「顯示玩家名稱」時的匿名代號(Player 1..n)。 */
  n: string;
  lv: number;
  x: number;
  y: number;
  m: PublicMapArea;
  /** 頭像圖示檔名(game-data/pals/ 內的裸檔名,與 GUI PlayerAvatar 同一顆雜湊 +
   *  同一份候選清單挑出來的 —— 見 pickPalAvatarIcon)。URL 前綴由消費端決定。 */
  icon?: string;
  /** 偷襲警告:這個(在線)玩家目前站在「非自己公會」的據點附近(RAID_RADIUS 內)。
   *  只有 showPlayers 與 showBases 兩個圖層都開啟時才會算、才會出現這個欄位;
   *  離線玩家一律不計算(對齊 GUI 只對在線玩家判定的行為)。 */
  warn?: boolean;
}

/** 快照裡的一個公會據點。 */
export interface PublicMapBasePoint {
  x: number;
  y: number;
  m: PublicMapArea;
  /** 公會名 — 只有「顯示公會名稱」開啟且贊助者授權(guild-map)才有,否則整欄省略。 */
  g?: string;
  /** 公會配色(HSL 字串,guildColorFromId(guildId) 算好的)。跟 g 是獨立開關 ——
   *  顏色本身不洩漏公會名稱,showGuildNames 關閉時仍可能帶這個欄位。 */
  c?: string;
}

/** 快照裡野外/封印頭目的重生狀態點。agent 端已用 assignReportedBosses 一對一配好,
 *  以 bosses.json 的「地圖座標」為鍵發出(viewer 用 `${x},${y}` 疊到自帶靜態 marker 上,
 *  故只需狀態、不需 name/icon)。只有 showBossRespawns 開啟且模組有回報時才出現。 */
export interface PublicMapBossPoint {
  x: number;
  y: number;
  m: PublicMapArea;
  /** 'alive' | 'dead' | 'unknown'(對齊 shared BossLiveStatus;實際 unknown 不會發出)。 */
  st: "alive" | "dead" | "unknown";
  /** 預估重生 epoch 秒(st==='dead' 且觀測到擊殺時);否則省略。
   *  ⚠ 單位是「秒」,與 generatedAt(毫秒)不同,消費端勿混用。 */
  ra?: number;
  /** 倒數採實測重生間隔(true)還是官方預設 3600s 估算(false/省略)。 */
  ms?: boolean;
}

/** 公開地圖快照格式 v1 — 雲端 Worker 與公開 viewer 依此消費,欄位名不可改。
 *  過濾在 agent 端完成:被設定關掉的圖層,對應欄位整個省略(不是空陣列)。 */
export interface PublicMapSnapshot {
  v: 1;
  name: string;
  generatedAt: number;
  onlineCount: number;
  maxPlayers?: number;
  show: {
    players: boolean;
    names: boolean;
    offline: boolean;
    bases: boolean;
    guildNames: boolean;
    bossRespawns: boolean;
  };
  players?: PublicMapPlayerPoint[];
  offline?: PublicMapPlayerPoint[];
  bases?: PublicMapBasePoint[];
  /** 野外/封印頭目重生狀態(以地圖座標為鍵疊到 viewer 自帶靜態頭目 marker;省略=無資料)。 */
  bosses?: PublicMapBossPoint[];
}
