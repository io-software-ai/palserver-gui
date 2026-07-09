import type {
  AgentInfo,
  CreateInstanceInput,
  DirEntry,
  FileContent,
  InstanceDetail,
  InstanceStats,
  InstanceSummary,
  LiveStatus,
  LogSource,
  LogSourceId,
  ModComponent,
  ModsStatus,
  RconCommandsResponse,
  WorldSettings,
} from "@palserver/shared";

export interface Connection {
  url: string; // e.g. http://localhost:8250
  token: string;
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

export class AgentClient {
  constructor(private conn: Connection) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.conn.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.conn.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as T;
  }

  info(): Promise<AgentInfo> {
    return this.request("/api/info");
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

  stats(id: string): Promise<InstanceStats> {
    return this.request(`/api/instances/${id}/stats`);
  }

  mods(id: string): Promise<ModsStatus> {
    return this.request(`/api/instances/${id}/mods`);
  }

  installMod(id: string, component: ModComponent): Promise<{ version: string }> {
    return this.request(`/api/instances/${id}/mods/${component}/install`, { method: "POST" });
  }

  toggleLuaMod(id: string, name: string, enabled: boolean): Promise<ModsStatus> {
    return this.request(`/api/instances/${id}/mods/lua-toggle`, {
      method: "POST",
      body: JSON.stringify({ name, enabled }),
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
