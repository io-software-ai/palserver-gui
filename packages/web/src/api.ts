import type {
  AgentInfo,
  AgentUpdatePrefs,
  AgentUpdateStatus,
  BackupInfo,
  BackupSchedule,
  ConfigHealth,
  ConnectionInfo,
  CreateInstanceInput,
  CustomPalInput,
  DirEntry,
  EngineSettings,
  EngineSettingsStatus,
  FileContent,
  InstanceDetail,
  InstanceStats,
  InstanceSummary,
  KnownPlayer,
  LicenseStatus,
  LiveStatus,
  LogSource,
  LogSourceId,
  ModComponent,
  ModerationLists,
  ModsStatus,
  PalDefenderConfig,
  PalDefenderConfigStatus,
  PdRestStatus,
  PlayerDetail,
  PresenceEvent,
  RconCommandsResponse,
  RestartPolicy,
  RestartStatus,
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

const STORAGE_KEY = "palserver.connection";

export function loadConnection(): Connection | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Connection) : null;
}

export function saveConnection(conn: Connection | null): void {
  if (conn) localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  else localStorage.removeItem(STORAGE_KEY);
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
      signal: AbortSignal.timeout(6000),
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
    signal: AbortSignal.timeout(6000),
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

  listInstances(): Promise<InstanceSummary[]> {
    return this.request("/api/instances");
  }

  getInstance(id: string): Promise<InstanceDetail> {
    return this.request(`/api/instances/${id}`);
  }

  createInstance(input: CreateInstanceInput): Promise<InstanceSummary> {
    return this.request("/api/instances", { method: "POST", body: JSON.stringify(input) });
  }

  action(id: string, action: "start" | "stop" | "restart"): Promise<InstanceSummary> {
    return this.request(`/api/instances/${id}/${action}`, { method: "POST" });
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

  palDefenderRest(id: string): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest`);
  }

  setPalDefenderRestEnabled(id: string, enabled: boolean): Promise<PdRestStatus> {
    return this.request(`/api/instances/${id}/paldefender-rest/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
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

  updatePalDefenderConfig(id: string, patch: PalDefenderConfig): Promise<PalDefenderConfigStatus> {
    return this.request(`/api/instances/${id}/paldefender-config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  configHealth(id: string): Promise<ConfigHealth> {
    return this.request(`/api/instances/${id}/config-health`);
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

  connection(id: string): Promise<ConnectionInfo> {
    return this.request(`/api/instances/${id}/connection`);
  }

  version(id: string): Promise<VersionStatus> {
    return this.request(`/api/instances/${id}/version`);
  }

  updateServer(id: string): Promise<{ started: boolean; hint: string }> {
    return this.request(`/api/instances/${id}/update`, { method: "POST", body: "{}" });
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

  saves(id: string): Promise<SavesStatus> {
    return this.request(`/api/instances/${id}/saves`);
  }

  createBackup(id: string, worldGuid: string): Promise<BackupInfo> {
    return this.request(`/api/instances/${id}/saves/backup`, {
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
