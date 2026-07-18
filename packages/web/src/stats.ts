/**
 * 全球匿名統計(packages/stats 的 Cloudflare Worker)。這裡只「讀」公開彙總數字;
 * 上報是 agent 端的事(packages/agent/src/telemetry.ts)。
 */

export const STATS_URL = "https://stats.iosoftware.ai";

export interface GlobalStats {
  /** GUI 在 GitHub Releases 的下載總數(統計端抓不到時為 null)。 */
  downloads: number | null;
  /** 管理者總數(不重複匿名安裝數)。 */
  admins: number;
  /** 全球不重複玩家數。 */
  players: number;
  instancesCreated: number;
  serverStarts: number;
}

export async function fetchGlobalStats(): Promise<GlobalStats | null> {
  try {
    const res = await fetch(`${STATS_URL}/api/stats`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (await res.json()) as GlobalStats;
  } catch {
    return null;
  }
}
