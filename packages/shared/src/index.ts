import { z } from "zod";
import { WORLD_OPTIONS, type OptionMeta } from "./options.js";

export * from "./options.js";
export * from "./commands.js";
export * from "./engine-options.js";
export * from "./paldefender-options.js";
export * from "./features.js";

/** Value type an option can hold at runtime. */
export type WorldOptionValue = string | number | boolean;
export type WorldSettings = Record<keyof typeof WORLD_OPTIONS, WorldOptionValue>;

function zodFor(meta: OptionMeta): z.ZodTypeAny {
  switch (meta.type) {
    case "float":
      return z.number().min(meta.min).max(meta.max).default(meta.default);
    case "int":
      return z.number().int().min(meta.min).max(meta.max).default(meta.default);
    case "bool":
      return z.boolean().default(meta.default);
    case "enum":
      return z.enum(meta.choices as [string, ...string[]]).default(meta.default);
    case "string":
      return z.string().max(meta.maxLength).default(meta.default);
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
    /** 給予方式:pal=直接給帕魯(givepal_j,需玩家);egg=給帕魯蛋(giveegg_j,需蛋 ID)。 */
    mode: z.enum(["pal", "egg"]).default("pal"),
    /** 目標玩家的 UserId(givepal_j 的第一個參數;egg 模式不需要)。 */
    userId: z.string().trim().max(128).optional(),
    /** 蛋 ID,例:PalEgg_Ice_01(giveegg_j 的第一個參數;pal 模式不需要)。 */
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
  .refine((d) => (d.mode === "egg" ? !!d.eggId : !!d.userId), {
    message: "pal 模式需要 userId,egg 模式需要 eggId",
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
  cpuPercent: number;
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

/** Map coordinates as the game shows them: x grows east, y grows north. */
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
}

export interface WorldSave {
  guid: string;
  /** true when GameUserSettings.ini's DedicatedServerName points here */
  active: boolean;
  sizeBytes: number;
  modifiedAt: string;
  playerSaves: PlayerSave[];
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

/* ── automatic restarts ── */

export type RestartReason = "scheduled" | "memory" | "crash" | "manual";

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
  if (a === 26) return "Radmin VPN";
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
