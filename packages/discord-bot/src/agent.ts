import https from "node:https";
import type {
  BackupInfo,
  BossRespawnStatus,
  ConnectionInfo,
  InstanceSummary,
  LiveStatus,
  PdGuildList,
  SavePlayersSummary,
  SavesStatus,
  VersionStatus,
} from "@palserver/shared";

/** agent 呼叫失敗(連線失敗、401、非 2xx)一律丟這個,handler 統一捕捉成 danger embed。 */
export class AgentError extends Error {}

// 模組級可變設定 —— 一個行程只跑一個 bot,所以用單例即可。standalone 由 index.ts 讀 env 後
// 呼叫 configureAgent();agent 同機內嵌則由 startBot() 帶參數呼叫。
let agentUrl = "http://127.0.0.1:8250";
let agentToken = "";
let agentInstanceId: string | undefined;
let cachedInstance: { id: string; name: string } | undefined;

/** 設定要連的 agent(URL / token / 固定實例)。重設時清掉實例快取,讓下次重新解析。 */
export function configureAgent(opts: { agentUrl: string; agentToken?: string; instanceId?: string }): void {
  agentUrl = opts.agentUrl.replace(/\/+$/, "");
  agentToken = opts.agentToken?.trim() || "";
  agentInstanceId = opts.instanceId?.trim() || undefined;
  cachedInstance = undefined;
}

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec.error === "string") return rec.error;
      if (typeof rec.message === "string") return rec.message;
    }
    return JSON.stringify(body);
  } catch {
    return res.statusText || "未知錯誤";
  }
}

function isLoopbackHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1")
    );
  } catch {
    return false;
  }
}

/** 對 loopback 的 https(agent 同機開 TLS 時是自簽憑證)用 node:https + rejectUnauthorized:false ——
 *  只放行「連自己這台 agent」;discord.js 連 Discord 仍走全域 fetch,真實憑證照常驗證,不被弱化。 */
function loopbackHttpsFetch(url: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(
            new Response(chunks.length ? Buffer.concat(chunks) : null, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 打 agent REST API:自動帶 Bearer token,401/非 2xx 一律轉成明確的 AgentError。 */
async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${agentUrl}${path}`;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // 同機部署連 127.0.0.1 時 agent 免 token(loopback),AGENT_TOKEN 留空就不帶 header。
    ...(agentToken ? { authorization: `Bearer ${agentToken}` } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };

  let res: Response;
  try {
    res = isLoopbackHttps(url)
      ? await loopbackHttpsFetch(url, method, headers, init?.body as string | undefined)
      : await fetch(url, { ...init, headers });
  } catch (err) {
    throw new AgentError(
      `無法連線到 agent(${agentUrl}):${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new AgentError("AGENT_TOKEN 失效,請重新設定(不會自動重試)。");
  }
  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new AgentError(`agent 回應錯誤(HTTP ${res.status}):${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 決定這個 bot 要操作哪個實例:AGENT_INSTANCE_ID 指定就用它,否則取第一個。結果快取,
 * 同一次啟動不會每次指令都重打 /api/instances。 */
export async function resolveInstance(): Promise<{ id: string; name: string }> {
  if (cachedInstance) return cachedInstance;
  const instances = await agentRequest<InstanceSummary[]>("/api/instances");
  if (agentInstanceId) {
    const found = instances.find((i) => i.id === agentInstanceId);
    if (!found) {
      throw new AgentError(`找不到 AGENT_INSTANCE_ID 指定的實例(${agentInstanceId})。`);
    }
    cachedInstance = { id: found.id, name: found.name };
    return cachedInstance;
  }
  const first = instances[0];
  if (!first) throw new AgentError("agent 目前沒有任何實例,請先在 GUI 建立一個。");
  cachedInstance = { id: first.id, name: first.name };
  return cachedInstance;
}

export const agent = {
  live: (instanceId: string) => agentRequest<LiveStatus>(`/api/instances/${instanceId}/live`),

  announce: (instanceId: string, message: string) =>
    agentRequest<{ announced: string }>(`/api/instances/${instanceId}/announce`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  save: (instanceId: string) =>
    agentRequest<{ saved: boolean }>(`/api/instances/${instanceId}/save`, {
      method: "POST",
      body: "{}",
    }),

  restart: (instanceId: string) =>
    agentRequest<InstanceSummary>(`/api/instances/${instanceId}/restart`, {
      method: "POST",
      body: "{}",
    }),

  kick: (instanceId: string, userId: string, message?: string) =>
    agentRequest<{ kicked: string }>(`/api/instances/${instanceId}/players/${userId}/kick`, {
      method: "POST",
      body: JSON.stringify(message ? { message } : {}),
    }),

  ban: (instanceId: string, value: string, reason?: string) =>
    agentRequest<{ ok: boolean; action: string; value: string }>(
      `/api/instances/${instanceId}/moderation/ban`,
      { method: "POST", body: JSON.stringify(reason ? { value, reason } : { value }) },
    ),

  rcon: (instanceId: string, command: string) =>
    agentRequest<{ command: string; output: string }>(`/api/instances/${instanceId}/rcon`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),

  start: (instanceId: string) =>
    agentRequest<InstanceSummary>(`/api/instances/${instanceId}/start`, { method: "POST", body: "{}" }),

  stop: (instanceId: string) =>
    agentRequest<InstanceSummary>(`/api/instances/${instanceId}/stop`, { method: "POST", body: "{}" }),

  connection: (instanceId: string) =>
    agentRequest<ConnectionInfo>(`/api/instances/${instanceId}/connection`),

  versionStatus: (instanceId: string) =>
    agentRequest<VersionStatus>(`/api/instances/${instanceId}/version`),

  update: (instanceId: string) =>
    agentRequest<unknown>(`/api/instances/${instanceId}/update`, { method: "POST", body: "{}" }),

  savesStatus: (instanceId: string) => agentRequest<SavesStatus>(`/api/instances/${instanceId}/saves`),

  backupNow: (instanceId: string, worldGuid: string) =>
    agentRequest<BackupInfo>(`/api/instances/${instanceId}/saves/backup`, {
      method: "POST",
      body: JSON.stringify({ worldGuid }),
    }),

  unban: (instanceId: string, value: string) =>
    agentRequest<{ ok: boolean }>(`/api/instances/${instanceId}/moderation/unban`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),

  playersSummary: (instanceId: string) =>
    agentRequest<SavePlayersSummary>(`/api/instances/${instanceId}/saves/players-snapshot`),

  guilds: (instanceId: string) => agentRequest<PdGuildList>(`/api/instances/${instanceId}/guilds`),

  bossRespawns: (instanceId: string) =>
    agentRequest<BossRespawnStatus>(`/api/instances/${instanceId}/boss-respawns`),
};

/** /kick 只吃 userId,但玩家在 Discord 端只會打名字——用 /live 的在線玩家名單解析,
 * 不分大小寫比對。找不到在線玩家就丟錯(kick 本來就只對在線玩家有意義)。 */
export async function resolveOnlinePlayer(
  instanceId: string,
  name: string,
): Promise<{ userId: string; name: string }> {
  const live = await agent.live(instanceId);
  const target = name.trim().toLowerCase();
  const found = live.players.find((p) => p.name.trim().toLowerCase() === target);
  if (!found) {
    throw new AgentError(`找不到在線玩家「${name}」(kick 只能對在線玩家操作,請確認名稱正確)。`);
  }
  return { userId: found.userId, name: found.name };
}
