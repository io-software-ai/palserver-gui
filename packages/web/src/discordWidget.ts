import { useEffect, useState } from "react";

/**
 * Discord 社群 widget(線上人數)。公開端點,免 auth,回 `Access-Control-Allow-Origin: *`,
 * 可以從瀏覽器直接 fetch,不需要走 agent/worker 代理。
 *
 * 讀取策略比照 promoConfig.ts / stats.ts:session 內只 fetch 一次(module-level `fetched`
 * flag)+ timeout + localStorage 快取(含時間戳,TTL 對齊 Discord widget.json 官方文件標示的
 * 5 分鐘快取週期)。失敗(離線/逾時/403 未開放 widget)一律靜默降級 —— 回舊快取或 null,
 * 呼叫端在 null 時應該隱藏線上人數 badge、只保留純邀請連結。
 */

const WIDGET_URL = (guildId: string) => `https://discord.com/api/guilds/${guildId}/widget.json`;
const CACHE_KEY = "palserver.discordWidget";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedWidget {
  presenceCount: number;
  fetchedAt: number;
}

function readCache(): CachedWidget | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (raw && typeof raw.presenceCount === "number" && typeof raw.fetchedAt === "number") {
      return raw as CachedWidget;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(presenceCount: number): void {
  try {
    const entry: CachedWidget = { presenceCount, fetchedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage 滿了或被封鎖(無痕模式等)—— 不影響功能,下次 session 再抓 */
  }
}

let shared: number | null = readCache()?.presenceCount ?? null;
let fetched = false;
const listeners = new Set<(n: number | null) => void>();

async function refresh(guildId: string): Promise<void> {
  if (fetched) return;
  fetched = true;
  const cache = readCache();
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return; // 快取還新鮮,這個 session 不重打
  try {
    const res = await fetch(WIDGET_URL(guildId), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return; // widget 未開放(403)/guild 打不到 → 靜默降級,維持舊快取或 null
    const data = await res.json();
    if (typeof data?.presence_count === "number") {
      shared = data.presence_count;
      writeCache(data.presence_count);
      listeners.forEach((l) => l(shared));
    }
  } catch {
    /* 離線/逾時 → 維持快取或 null,不拋錯、不重試 */
  }
}

/** 回傳 Discord 社群線上人數(presence_count)。抓不到/尚未抓到回 null,呼叫端應隱藏 badge。 */
export function useDiscordWidget(guildId: string): number | null {
  const [count, setCount] = useState(shared);
  useEffect(() => {
    listeners.add(setCount);
    void refresh(guildId);
    setCount(shared);
    return () => {
      listeners.delete(setCount);
    };
  }, [guildId]);
  return count;
}
