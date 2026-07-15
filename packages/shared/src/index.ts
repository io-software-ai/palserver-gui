import { z } from "zod";
import { WORLD_OPTIONS, type OptionMeta } from "./options.js";

export * from "./options.js";
export * from "./commands.js";
export * from "./engine-options.js";
export * from "./launch-options.js";
export * from "./paldefender-options.js";
export * from "./pal-stats-options.js";
export * from "./features.js";

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
  /** UDP port the server listens on (host port for docker). */
  gamePort: z.number().int().min(1024).max(65535).default(8211),
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
  level: z.number().int().min(1).max(100).optional(),
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
  /** 星星 / 濃縮等級,0–4。 */
  condensedPals: z.number().int().min(0).max(4).optional(),
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
  ue4ss: { installed: boolean; version: string | null };
  paldefender: { installed: boolean; version: string | null };
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
  enabled: false,
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
}

export interface SavePlayersSnapshot {
  worldGuid: string;
  generatedAt: string;
  levelSavMtime: string;
  players: SavePlayerProfile[];
}

/** 快照清單回應:玩家欄位齊全但不含 pals 明細(單一玩家詳情另查)。 */
export interface SavePlayersSummary {
  generatedAt: string | null;
  levelSavMtime: string | null;
  players: Omit<SavePlayerProfile, "pals">[];
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
