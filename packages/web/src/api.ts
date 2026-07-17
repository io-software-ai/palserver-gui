import type {
  AgentInfo,
  AgentUpdatePrefs,
  AgentUpdateStatus,
  BackupInfo,
  BackupSchedule,
  ConfigHealth,
  ConnectionInfo,
  ConfigSnapshotInfo,
  ConfigSnapshotList,
  CreateInstanceInput,
  CustomPalInput,
  DirEntry,
  EngineSettings,
  EngineSettingsStatus,
  ExternalWorldCandidate,
  FileContent,
  HostFixResult,
  ImportSaveResult,
  InstanceDetail,
  InstanceStats,
  InstanceSummary,
  KnownPlayer,
  LaunchOptions,
  LicenseStatus,
  LiveStatus,
  LogSource,
  LogSourceId,
  ModComponent,
  ModerationLists,
  ModsStatus,
  PalDefenderConfigPatch,
  PalDefenderConfigStatus,
  PalSchemaStatus,
  PalStatsStatus,
  PalStatValues,
  PdGuildList,
  PdGuildDetail,
  PdPlayerList,
  PdRestStatus,
  PlayerDetail,
  PresenceEvent,
  RconCommandsResponse,
  RestartPolicy,
  RestartStatus,
  AutoScanSetting,
  SaveGuild,
  SaveHealthStatus,
  SavePlayerProfile,
  SavePlayersSummary,
  SaveScanStats,
  SavesStatus,
  VersionStatus,
  WorldSettings,
} from "@palserver/shared";

export interface Connection {
  url: string; // e.g. http://localhost:8250
  token: string;
}

/** 匿名使用統計(遙測)狀態 — 對應 agent 的 GET/PUT /api/telemetry。 */
export interface TelemetryStatus {
  enabled: boolean;
  /** true = 被 PALSERVER_TELEMETRY=0 強制停用,GUI 開關無效。 */
  envDisabled: boolean;
  installId: string;
}

/** 系統/網路設定的單一欄位:目前生效值 + 是否被環境變數鎖定。 */
export interface AgentSettingField<T> {
  value: T;
  envLocked: boolean;
}
export interface AgentSettingsStatus {
  requireToken: AgentSettingField<boolean>;
  tls: AgentSettingField<boolean>;
  agentPort: AgentSettingField<number>;
  agentHost: AgentSettingField<string>;
  webOrigins: AgentSettingField<string>;
  autoOpenBrowser: AgentSettingField<boolean>;
  /** 免安裝執行檔可一鍵重啟;開發模式為 false(需手動重啟)。 */
  canRestart: boolean;
}
export interface AgentSettingsPatch {
  requireToken?: boolean;
  tls?: boolean;
  agentPort?: number;
  agentHost?: string;
  webOrigins?: string;
  autoOpenBrowser?: boolean;
}

export interface ConfigSnapshotResult {
  supported: boolean;
  reason?: string;
  snapshot?: ConfigSnapshotInfo;
}

export interface ConfigSnapshotRestoreResult {
  supported: boolean;
  reason?: string;
  snapshot?: ConfigSnapshotInfo;
  safetySnapshot?: ConfigSnapshotInfo;
}

/** 埠檢查結果(agent GET /ports/check)。 */
export interface PortCheckEntry {
  key: "game" | "query" | "rest" | "rcon" | "paldefender";
  port: number;
  protocol: "udp" | "tcp";
  free: boolean;
  suggestion?: number;
}
export interface PortsCheckResult {
  supported: boolean;
  reason?: string;
  ports: PortCheckEntry[];
  anyConflict: boolean;
}

const STORAGE_KEY = "palserver.connection";

export function loadConnection(): Connection | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Connection) : null;
}

export function saveConnection(conn: Connection | null): void {
  if (conn) localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  else localStorage.removeItem(STORAGE_KEY);
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * 偵測某位址是不是 palserver agent,並回報此請求是否已授權(本機 loopback 會
 * 直接 authenticated=true)。連不到 / 非 agent 回 null。連線畫面用它判斷:
 * same-origin 有 agent = 合一版;否則是純 web 站,請玩家輸入自己的 agent 位址。
 */
export async function probeAgent(url: string, token?: string): Promise<AgentInfo | null> {
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: timeoutSignal(6000),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as AgentInfo;
    return info?.name === "palserver-agent" ? info : null;
  } catch {
    return null;
  }
}

/** 用配對碼向 agent 換發長 token。 */
export async function pairAgent(url: string, code: string): Promise<string> {
  const res = await fetch(`${url}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
    signal: timeoutSignal(6000),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.token;
}

export class AgentClient {
  /** onUnauthorized:任何請求收到 401 時呼叫,讓 App 清掉失效連線、退回連線畫面。 */
  constructor(
    private conn: Connection,
    private onUnauthorized?: () => void,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.conn.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.conn.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new Error("unauthorized");
    }
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as T;
  }

  info(): Promise<AgentInfo> {
    return this.request("/api/info");
  }

  /** 目前的配對碼,用來讓其他裝置登入。 */
  pairingCode(): Promise<{ pairingCode: string }> {
    return this.request("/api/pair/code");
  }

  /** 重新產生配對碼(舊碼與舊連結即刻失效)。 */
  rotatePairingCode(): Promise<{ pairingCode: string }> {
    return this.request("/api/pair/rotate", { method: "POST" });
  }

  /** 這台 agent 的可連 IPv4 位址,用來組給其他裝置的登入連結。 */
  agentAddresses(): Promise<{ addresses: { ip: string; vpn: string | null }[] }> {
    return this.request("/api/addresses");
  }

  /** GUI 自我更新狀態(force=true 略過 agent 端的 6 小時檢查快取)。 */
  updateStatus(force = false): Promise<AgentUpdateStatus> {
    return this.request(`/api/update${force ? "?force=1" : ""}`);
  }

  setUpdatePrefs(patch: Partial<Omit<AgentUpdatePrefs, "envDisabled">>): Promise<AgentUpdateStatus> {
    return this.request("/api/update/prefs", { method: "PUT", body: JSON.stringify(patch) });
  }

  /** 開始更新。agent 會下載、驗證、換檔後重啟自己 —— 之後輪詢 updateStatus()。 */
  applyUpdate(): Promise<{ applying: boolean; latestVersion: string | null }> {
    return this.request("/api/update/apply", { method: "POST" });
  }

  /** 匿名使用統計(遙測)目前狀態。envDisabled=true 表示被環境變數強制停用。 */
  telemetry(): Promise<TelemetryStatus> {
    return this.request("/api/telemetry");
  }

  setTelemetry(enabled: boolean): Promise<TelemetryStatus> {
    return this.request("/api/telemetry", { method: "PUT", body: JSON.stringify({ enabled }) });
  }

  /** 系統 / 網路設定(對應 GET/PUT /api/settings)。改動寫進 agent 的 settings.json,重啟後生效。 */
  agentSettings(): Promise<AgentSettingsStatus> {
    return this.request("/api/settings");
  }
  saveAgentSettings(patch: AgentSettingsPatch): Promise<{ ok: boolean }> {
    return this.request("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
  }
  /** 重啟 agent 以套用系統設定;restarting=false 表示開發模式,需手動重啟。 */
  restartAgent(): Promise<{ restarting: boolean }> {
    return this.request("/api/restart", { method: "POST", body: JSON.stringify({}) });
  }

  /** 贊助者識別碼(先行版授權)狀態。 */
  license(): Promise<LicenseStatus> {
    return this.request("/api/license");
  }

  setLicense(code: string): Promise<LicenseStatus> {
    return this.request("/api/license", { method: "PUT", body: JSON.stringify({ code }) });
  }

  clearLicense(): Promise<LicenseStatus> {
    return this.request("/api/license", { method: "DELETE" });
  }

  /** 日誌翻譯(log-tools):一批英文行走 agent 代理 Google Translate(換行批次),tl=目標語碼。
   *  回傳與輸入等長的譯文陣列(對不上/失敗的該格為空字串)。 */
  translateBatch(texts: string[], tl: string): Promise<{ texts: string[] }> {
    return this.request(`/api/translate`, { method: "POST", body: JSON.stringify({ q: texts, tl }) });
  }

  listInstances(): Promise<InstanceSummary[]> {
    return this.request("/api/instances");
  }

  getInstance(id: string): Promise<InstanceDetail> {
    return this.request(`/api/instances/${id}`);
  }

  createInstance(input: CreateInstanceInput): Promise<InstanceSummary> {
    return this.request("/api/instances", { method: "POST", body: JSON.stringify(input) });
  }

  /** announceTemplate(含 {n} 佔位)只用於 stop/restart:agent 會用它在遊戲聊天室
   * 倒數公告(語言由呼叫端決定),秒數取自該實例伺服器重啟設定的 announceSeconds。 */
  action(
    id: string,
    action: "start" | "stop" | "restart",
    announceTemplate?: string,
  ): Promise<InstanceSummary> {
    return this.request(`/api/instances/${id}/${action}`, {
      method: "POST",
      body: announceTemplate ? JSON.stringify({ announceTemplate }) : undefined,
    });
  }

  deleteInstance(id: string): Promise<void> {
    return this.request(`/api/instances/${id}`, { method: "DELETE" });
  }

  updateSettings(
    id: string,
    patch: Partial<WorldSettings>,
  ): Promise<{ applied: string; settings: WorldSettings }> {
    return this.request(`/api/instances/${id}/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  /** 修改伺服器路徑(僅 native):把現有伺服器檔案搬到新位置。空字串 = 搬回 agent
   *  管理的資料夾。跨磁碟搬移在背景進行,回傳 { moving: true },實例會短暫顯示「安裝中」。 */
  updateServerDir(id: string, serverDir: string): Promise<{ serverDir?: string | null; moving?: boolean }> {
    return this.request(`/api/instances/${id}/server-dir`, {
      method: "PUT",
      body: JSON.stringify({ serverDir }),
    });
  }

  /** 匯出下載網址(存檔+設定的 tar.gz;僅 native)。瀏覽器直接開它下載,token 走 query。 */
  exportUrl(id: string): string {
    const url = new URL(`${this.conn.url}/api/instances/${id}/export`);
    url.searchParams.set("token", this.conn.token);
    return url.toString();
  }

  /** 複製伺服器(僅 native):用相同設定+世界存檔開一個新實例,回傳新實例摘要。 */
  duplicateInstance(id: string, name?: string): Promise<InstanceSummary> {
    return this.request(`/api/instances/${id}/duplicate`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    });
  }

  stats(id: string): Promise<InstanceStats> {
    return this.request(`/api/instances/${id}/stats`);
  }

  mods(id: string): Promise<ModsStatus> {
    return this.request(`/api/instances/${id}/mods`);
  }

  installMod(
    id: string,
    component: ModComponent,
    channel: "stable" | "beta" = "stable",
  ): Promise<{ version: string }> {
    return this.request(`/api/instances/${id}/mods/${component}/install`, {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
  }

  uninstallMod(id: string, component: ModComponent): Promise<{ removed: string }> {
    return this.request(`/api/instances/${id}/mods/${component}/uninstall`, { method: "POST" });
  }

  toggleLuaMod(id: string, name: string, enabled: boolean): Promise<ModsStatus> {
    return this.request(`/api/instances/${id}/mods/lua-toggle`, {
      method: "POST",
      body: JSON.stringify({ name, enabled }),
    });
  }

  /** 自訂帕魯(贊助者先行版):PalDefender 範本 + givepal_j。 */
  giveCustomPal(id: string, input: CustomPalInput): Promise<{ output: string }> {
    return this.request(`/api/instances/${id}/pals/give`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** 批量給予道具(贊助者先行版)。非贊助者回 403。 */
  giveItems(
    id: string,
    userId: string,
    items: { itemId: string; amount: number }[],
  ): Promise<{ output: string }> {
    return this.request(`/api/instances/${id}/items/give`, {
      method: "POST",
      body: JSON.stringify({ userId, items }),
    });
  }

  /** 傳送玩家(贊助者先行版):target = 目標玩家 UserId 或座標「x y」。非贊助者回 403。 */
  teleport(id: string, source: string, target: string): Promise<{ output: string }> {
    return this.request(`/api/instances/${id}/teleport`, {
      method: "POST",
      body: JSON.stringify({ source, target }),
    });
  }

  live(id: string): Promise<LiveStatus> {
    return this.request(`/api/instances/${id}/live`);
  }

  rconCommands(id: string): Promise<RconCommandsResponse> {
    return this.request(`/api/instances/${id}/rcon/commands`);
  }

  rconExec(id: string, command: string): Promise<{ command: string; output: string }> {
    return this.request(`/api/instances/${id}/rcon`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }

  knownPlayers(id: string): Promise<KnownPlayer[]> {
    return this.request(`/api/instances/${id}/players/known`);
  }

  playerDetail(id: string, identifier: string): Promise<PlayerDetail> {
    return this.request(`/api/instances/${id}/players/${encodeURIComponent(identifier)}/detail`);
  }

  moderation(id: string): Promise<ModerationLists> {
    return this.request(`/api/instances/${id}/moderation`);
  }

  moderate(
    id: string,
    action: "whitelist_add" | "whitelist_remove" | "ban" | "unban" | "banip" | "unbanip",
    value: string,
    reason?: string,
  ): Promise<unknown> {
    return this.request(`/api/instances/${id}/moderation/${action}`, {
      method: "POST",
      body: JSON.stringify({ value, reason }),
    });
  }

  presenceEvents(id: string, limit = 100): Promise<PresenceEvent[]> {
    return this.request(`/api/instances/${id}/players/events?limit=${limit}`);
  }

  announce(id: string, message: string): Promise<{ announced: string }> {
    return this.request(`/api/instances/${id}/announce`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  playerAction(
    id: string,
    userId: string,
    action: "kick" | "ban" | "unban",
    message?: string,
  ): Promise<unknown> {
    return this.request(`/api/instances/${id}/players/${encodeURIComponent(userId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  saveWorld(id: string): Promise<{ saved: boolean }> {
    return this.request(`/api/instances/${id}/save`, { method: "POST", body: "{}" });
  }

  /** PalDefender 統一玩家名冊(含離線,需 1.8+)。 */
  palDefenderPlayers(id: string): Promise<PdPlayerList> {
    return this.request(`/api/instances/${id}/paldefender-players`);
  }

  guilds(id: string): Promise<PdGuildList> {
    return this.request(`/api/instances/${id}/guilds`);
  }

  guild(id: string, guildId: string): Promise<PdGuildDetail> {
    return this.request(`/api/instances/${id}/guilds/${encodeURIComponent(guildId)}`);
  }

  palDefenderRest(id: string): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest`);
  }

  setPalDefenderRestEnabled(id: string, enabled: boolean): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  }

  setPalDefenderRestPort(id: string, port: number): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest/port`, {
      method: "PUT",
      body: JSON.stringify({ port }),
    });
  }

  provisionPalDefenderToken(id: string, regenerate = false): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest/token`, {
      method: "POST",
      body: JSON.stringify({ regenerate }),
    });
  }

  palDefenderConfig(id: string): Promise<PalDefenderConfigStatus> {
    return this.request(`/api/instances/${id}/paldefender-config`);
  }

  updatePalDefenderConfig(id: string, patch: PalDefenderConfigPatch): Promise<PalDefenderConfigStatus> {
    return this.request(`/api/instances/${id}/paldefender-config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  /** PalSchema(帕魯物種數值編輯器,贊助者先行版 pal-stats)安裝狀態。 */
  palSchema(id: string): Promise<PalSchemaStatus> {
    return this.request(`/api/instances/${id}/palschema`);
  }

  /** 安裝需先停伺服器(執行中回 409);非贊助者回 403。 */
  installPalSchema(id: string): Promise<{ installed: string; version: string; applied: string }> {
    return this.request(`/api/instances/${id}/palschema/install`, { method: "POST" });
  }

  uninstallPalSchema(id: string): Promise<{ removed: string }> {
    return this.request(`/api/instances/${id}/palschema/uninstall`, { method: "POST" });
  }

  /** 物種數值(PalSchema DataTable patch)目前狀態 + 各 row 已寫入的值。 */
  palStats(id: string): Promise<PalStatsStatus> {
    return this.request(`/api/instances/${id}/pal-stats`);
  }

  /** 只需送有填的欄位;values 會與該 row 既有內容合併寫入。 */
  updatePalStats(id: string, row: string, values: PalStatValues): Promise<PalStatsStatus> {
    return this.request(`/api/instances/${id}/pal-stats`, {
      method: "PUT",
      body: JSON.stringify({ row, values }),
    });
  }

  /** 清空所有物種數值調整(改回原本設定)。非贊助者也可用。 */
  clearPalStats(id: string): Promise<PalStatsStatus> {
    return this.request(`/api/instances/${id}/pal-stats`, { method: "DELETE" });
  }

  configHealth(id: string): Promise<ConfigHealth> {
    return this.request(`/api/instances/${id}/config-health`);
  }

  listConfigBackups(id: string): Promise<ConfigSnapshotList> {
    return this.request(`/api/instances/${id}/config-backups`);
  }

  createConfigBackup(id: string, reason?: string): Promise<ConfigSnapshotResult> {
    return this.request(`/api/instances/${id}/config-backups`, {
      method: "POST",
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    });
  }

  configBackupDownloadUrl(id: string, name: string): string {
    const url = new URL(`${this.conn.url}/api/instances/${encodeURIComponent(id)}/config-backups/download`);
    url.searchParams.set("name", name);
    url.searchParams.set("token", this.conn.token);
    return url.toString();
  }

  restoreConfigBackup(id: string, name: string): Promise<ConfigSnapshotRestoreResult> {
    return this.request(`/api/instances/${id}/config-backups/restore`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  regenerateConfig(id: string, file: "world" | "engine"): Promise<{ path: string; backedUp: boolean }> {
    return this.request(`/api/instances/${id}/config/regenerate`, {
      method: "POST",
      body: JSON.stringify({ file }),
    });
  }

  engineSettings(id: string): Promise<EngineSettingsStatus> {
    return this.request(`/api/instances/${id}/engine-settings`);
  }

  updateEngineSettings(id: string, values: EngineSettings): Promise<EngineSettingsStatus> {
    return this.request(`/api/instances/${id}/engine-settings`, {
      method: "PUT",
      body: JSON.stringify(values),
    });
  }

  launchOptions(id: string): Promise<{ launchOptions: LaunchOptions; queryPort: number | null }> {
    return this.request(`/api/instances/${id}/launch-options`);
  }

  updateLaunchOptions(
    id: string,
    patch: { launchOptions?: LaunchOptions; queryPort?: number | null },
  ): Promise<{ launchOptions: LaunchOptions; queryPort: number | null; applied: string }> {
    return this.request(`/api/instances/${id}/launch-options`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  connection(id: string): Promise<ConnectionInfo> {
    return this.request(`/api/instances/${id}/connection`);
  }

  version(id: string): Promise<VersionStatus> {
    return this.request(`/api/instances/${id}/version`);
  }

  updateServer(id: string, fresh = false): Promise<{ started: boolean; hint: string }> {
    return this.request(`/api/instances/${id}/update`, { method: "POST", body: JSON.stringify({ fresh }) });
  }

  restartPolicy(id: string): Promise<RestartStatus> {
    return this.request(`/api/instances/${id}/restart-policy`);
  }

  updateRestartPolicy(id: string, policy: RestartPolicy): Promise<RestartPolicy> {
    return this.request(`/api/instances/${id}/restart-policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    });
  }

  /** 把 ini 的外部改動併回 store(編輯原始檔存檔後、開啟世界設定面板時呼叫)。 */
  syncWorldIni(id: string): Promise<{ settings: WorldSettings; changedKeys: string[] }> {
    return this.request(`/api/instances/${id}/settings/sync-ini`, { method: "POST", body: "{}" });
  }

  saves(id: string): Promise<SavesStatus> {
    return this.request(`/api/instances/${id}/saves`);
  }

  createBackup(id: string, worldGuid: string): Promise<BackupInfo> {
    return this.request(`/api/instances/${id}/saves/backup`, {
      method: "POST",
      body: JSON.stringify({ worldGuid }),
    });
  }

  disableWorldOptions(id: string, worldGuid: string): Promise<{ disabledTo: string }> {
    return this.request(`/api/instances/${id}/saves/world-options-fix`, {
      method: "POST",
      body: JSON.stringify({ worldGuid }),
    });
  }

  playersSnapshot(id: string, worldGuid?: string): Promise<SavePlayersSummary & { worldGuid: string }> {
    const q = worldGuid ? `?worldGuid=${encodeURIComponent(worldGuid)}` : "";
    return this.request(`/api/instances/${id}/saves/players-snapshot${q}`);
  }

  /** 帕魯歸屬過戶:把共玩殘留 uid 名下的帕魯過戶給指定玩家(需停服,會先強制備份)。 */
  palOwnerFix(
    id: string,
    worldGuid: string,
    toSav: string,
  ): Promise<{ fromUid: string; toUid: string; patchedPalOwners: number; backup: string }> {
    return this.request(`/api/instances/${id}/saves/pal-owner-fix`, {
      method: "POST",
      body: JSON.stringify({ worldGuid, toSav }),
    });
  }

  playerSnapshotProfile(
    id: string,
    worldGuid: string,
    uid: string,
  ): Promise<{ worldGuid: string; profile: SavePlayerProfile }> {
    return this.request(
      `/api/instances/${id}/saves/players-snapshot?worldGuid=${encodeURIComponent(worldGuid)}&uid=${encodeURIComponent(uid)}`,
    );
  }

  guildsSnapshot(id: string, worldGuid?: string): Promise<{
    worldGuid: string;
    generatedAt: string | null;
    guilds: SaveGuild[];
  }> {
    const q = worldGuid ? `?worldGuid=${encodeURIComponent(worldGuid)}` : "";
    return this.request(`/api/instances/${id}/saves/guilds-snapshot${q}`);
  }

  /** 掃描統計歷史(排行榜/週報;每次健檢追加一筆)+ 自動掃描設定。 */
  statsHistory(
    id: string,
    worldGuid?: string,
  ): Promise<{ worldGuid: string; history: SaveScanStats[]; autoScan: AutoScanSetting }> {
    const q = worldGuid ? `?worldGuid=${encodeURIComponent(worldGuid)}` : "";
    return this.request(`/api/instances/${id}/saves/stats-history${q}`);
  }

  /** 啟動前埠占用檢查(遺戲/查詢/REST/RCON/PalDefender)。 */
  portsCheck(id: string): Promise<PortsCheckResult> {
    return this.request(`/api/instances/${id}/ports/check`);
  }

  /** 套用埠修改(啟動前衝突面板)。 */
  portsUpdate(
    id: string,
    patch: Partial<Record<"game" | "query" | "rest" | "rcon" | "paldefender", number>>,
  ): Promise<{ gamePort: number; queryPort: number | null }> {
    return this.request(`/api/instances/${id}/ports`, { method: "PUT", body: JSON.stringify(patch) });
  }

  /** 每小時自動掃描開關。 */
  setAutoScan(id: string, enabled: boolean): Promise<AutoScanSetting> {
    return this.request(`/api/instances/${id}/saves/auto-scan`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  }

  saveHealth(id: string, worldGuid: string): Promise<SaveHealthStatus> {
    return this.request(`/api/instances/${id}/saves/health?worldGuid=${encodeURIComponent(worldGuid)}`);
  }

  startSaveHealth(id: string, worldGuid: string): Promise<SaveHealthStatus> {
    return this.request(`/api/instances/${id}/saves/health`, {
      method: "POST",
      body: JSON.stringify({ worldGuid }),
    });
  }

  restoreBackup(id: string, backup: string): Promise<{ worldGuid: string; safetyBackup: string }> {
    return this.request(`/api/instances/${id}/saves/restore`, {
      method: "POST",
      body: JSON.stringify({ backup }),
    });
  }

  hostFix(id: string, worldGuid: string, oldSav: string, newSav: string): Promise<HostFixResult> {
    return this.request(`/api/instances/${id}/saves/host-fix`, {
      method: "POST",
      body: JSON.stringify({ worldGuid, oldSav, newSav }),
    });
  }

  inspectImportSave(sourcePath: string): Promise<{ worlds: ExternalWorldCandidate[] }> {
    return this.request("/api/import-save/inspect", {
      method: "POST",
      body: JSON.stringify({ sourcePath }),
    });
  }

  importSave(id: string, worldPath: string, overwrite: boolean): Promise<ImportSaveResult> {
    return this.request(`/api/instances/${id}/import-save`, {
      method: "POST",
      body: JSON.stringify({ worldPath, overwrite }),
    });
  }

  deleteBackup(id: string, name: string): Promise<void> {
    return this.request(`/api/instances/${id}/saves/backup?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  backupDownloadUrl(id: string, name: string): string {
    const url = new URL(`${this.conn.url}/api/instances/${id}/saves/backup/download`);
    url.searchParams.set("name", name);
    url.searchParams.set("token", this.conn.token);
    return url.toString();
  }

  setActiveWorld(id: string, worldGuid: string): Promise<{ active: string }> {
    return this.request(`/api/instances/${id}/saves/active`, {
      method: "POST",
      body: JSON.stringify({ worldGuid }),
    });
  }

  deletePlayerSave(id: string, worldGuid: string, file: string): Promise<void> {
    const q = new URLSearchParams({ worldGuid, file });
    return this.request(`/api/instances/${id}/saves/player?${q}`, { method: "DELETE" });
  }

  /** 鏡像遷移：把此實例的存檔+INI+GameUserSettings 複製到目標實例。 */
  mirrorWorld(id: string, targetId: string): Promise<{ mirrored: boolean; worldGuid: string; targetId: string }> {
    return this.request(`/api/instances/${id}/mirror`, {
      method: "POST",
      body: JSON.stringify({ targetId }),
    });
  }

  /** Pak mod 列表（跨平台）。 */
  listPakMods(id: string): Promise<{ mods: { name: string; size: number; enabled: boolean }[] }> {
    return this.request(`/api/instances/${id}/pak-mods`);
  }

  /** 啟停 pak mod。 */
  togglePakMod(id: string, name: string, enabled: boolean): Promise<{ toggled: string; enabled: boolean }> {
    return this.request(`/api/instances/${id}/pak-mods/toggle`, {
      method: "POST",
      body: JSON.stringify({ name, enabled }),
    });
  }

  /** 移除 pak mod。 */
  removePakMod(id: string, name: string): Promise<void> {
    const q = new URLSearchParams({ name });
    return this.request(`/api/instances/${id}/pak-mods?${q}`, { method: "DELETE" });
  }

  updateBackupSchedule(id: string, patch: Partial<BackupSchedule>): Promise<BackupSchedule> {
    return this.request(`/api/instances/${id}/saves/schedule`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  runBackupSchedule(id: string): Promise<BackupSchedule> {
    return this.request(`/api/instances/${id}/saves/schedule/run`, { method: "POST", body: "{}" });
  }

  listFiles(id: string, path: string): Promise<{ path: string; entries: DirEntry[] }> {
    return this.request(`/api/instances/${id}/files?path=${encodeURIComponent(path)}`);
  }

  readFile(id: string, path: string): Promise<FileContent> {
    return this.request(`/api/instances/${id}/files/content?path=${encodeURIComponent(path)}`);
  }

  writeFile(id: string, path: string, content: string): Promise<{ saved: string }> {
    return this.request(`/api/instances/${id}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
  }

  makeDir(id: string, path: string): Promise<{ created: string }> {
    return this.request(`/api/instances/${id}/files/dir`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  deleteFile(id: string, path: string): Promise<void> {
    return this.request(`/api/instances/${id}/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  }

  async uploadFile(id: string, path: string, file: File): Promise<{ uploaded: string; size: number }> {
    const res = await fetch(
      `${this.conn.url}/api/instances/${id}/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: file,
      },
    );
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as { uploaded: string; size: number };
  }

  logSources(id: string): Promise<LogSource[]> {
    return this.request(`/api/instances/${id}/logs/sources`);
  }

  logsSocket(id: string, source: LogSourceId = "agent"): WebSocket {
    const wsUrl = this.conn.url.replace(/^http/, "ws");
    return new WebSocket(
      `${wsUrl}/api/instances/${id}/logs?token=${encodeURIComponent(this.conn.token)}&source=${source}`,
    );
  }
}
