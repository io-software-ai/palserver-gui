/** 環境變數讀取與驗證。缺必填直接丟明確錯誤,啟動時 fail fast。 */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`缺少環境變數 ${name}(必填)。請參考 .env.example 設定。`);
  return v;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: required("DISCORD_GUILD_ID"),
  /** agent 的 base URL,不含結尾斜線。預設本機(bot 與 agent 同機部署時最常見)。 */
  agentUrl: stripTrailingSlash(process.env.AGENT_URL?.trim() || "http://127.0.0.1:8250"),
  agentToken: required("AGENT_TOKEN"),
  /** 選填:固定操作的實例 id。留空則自動取 agent 回傳的第一個實例。 */
  agentInstanceId: process.env.AGENT_INSTANCE_ID?.trim() || undefined,
} as const;
