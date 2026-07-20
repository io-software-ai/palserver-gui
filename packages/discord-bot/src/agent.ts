import type { InstanceSummary, LiveStatus } from "@palserver/shared";
import { config } from "./config.js";

/** agent 呼叫失敗(連線失敗、401、非 2xx)一律丟這個,handler 統一捕捉成 danger embed。 */
export class AgentError extends Error {}

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

/** 打 agent REST API:自動帶 Bearer token,401/非 2xx 一律轉成明確的 AgentError。 */
async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${config.agentUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.agentToken}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new AgentError(
      `無法連線到 agent(${config.agentUrl}):${err instanceof Error ? err.message : String(err)}`,
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

let cachedInstance: { id: string; name: string } | undefined;

/** 決定這個 bot 要操作哪個實例:AGENT_INSTANCE_ID 指定就用它,否則取第一個。結果快取,
 * 同一次啟動不會每次指令都重打 /api/instances。 */
export async function resolveInstance(): Promise<{ id: string; name: string }> {
  if (cachedInstance) return cachedInstance;
  const instances = await agentRequest<InstanceSummary[]>("/api/instances");
  if (config.agentInstanceId) {
    const found = instances.find((i) => i.id === config.agentInstanceId);
    if (!found) {
      throw new AgentError(`找不到 AGENT_INSTANCE_ID 指定的實例(${config.agentInstanceId})。`);
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
