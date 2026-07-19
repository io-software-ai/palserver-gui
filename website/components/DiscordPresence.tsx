'use client';

import { useEffect, useState } from 'react';
import type { Dictionary } from '@/i18n/dictionaries';

/** 官方 Discord 邀請連結,固定常數,不依賴 widget.json 的 instant_invite(會過期/隨 widget 設定變動)。 */
export const DISCORD_INVITE = 'https://discord.gg/w3YupCut';

const WIDGET_URL = 'https://discord.com/api/guilds/1205193368771104808/widget.json';
const CACHE_KEY = 'discord-presence-count';
const CACHE_TTL = 5 * 60 * 1000; // 5 分鐘,對齊 Discord 端 widget.json 的 max-age=300,避免同使用者反覆抓

/** 緊湊記數,沿用 Stats.tsx 的格式(3259 -> 3.3K)。 */
const fmt = (n: number) =>
  n >= 1e6
    ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    : n >= 1000
      ? Math.round(n / 1000) + 'K'
      : String(n);

function readCache(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { n, t } = JSON.parse(raw) as { n: number; t: number };
    if (typeof n === 'number' && n > 0 && Date.now() - t < CACHE_TTL) return n;
  } catch {
    /* localStorage 不可用(隱私模式等)就當沒快取 */
  }
  return null;
}

function writeCache(n: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ n, t: Date.now() }));
  } catch {
    /* 寫入失敗不影響功能,忽略即可 */
  }
}

/**
 * Discord 伺服器線上人數(widget.json 的 presence_count——只算線上,非全部成員,上限與 100 筆成員清單無關)。
 * 靜態站無 server runtime,一律 client fetch(已實測 CORS 對任意 Origin 開放,免 credentials)。
 * 抓不到(離線 / widget 關閉回 403)就回傳 null,呼叫端自行決定 fallback UI,數字只是加分不擋 CTA。
 */
function useDiscordPresence(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const cached = readCache();
    if (cached !== null) {
      setCount(cached);
      return;
    }
    let cancelled = false;
    fetch(WIDGET_URL)
      .then((r) => (r.ok ? (r.json() as Promise<{ presence_count?: number }>) : Promise.reject(r.status)))
      .then((data) => {
        if (cancelled || typeof data.presence_count !== 'number' || data.presence_count <= 0) return;
        setCount(data.presence_count);
        writeCache(data.presence_count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}

/** 獨立當一格用(如 Hero 的 chip):抓到之前顯示 d.join 保底文字,抓到後換成「N 人在線」。 */
export default function DiscordPresence({ d }: { d: Dictionary['discord'] }) {
  const count = useDiscordPresence();
  return <>{count === null ? d.join : d.online.replace('{n}', fmt(count))}</>;
}

/** 附掛在既有按鈕旁的小徽章:抓到人數前不輸出任何內容,避免把按鈕本來的文字(如「Discord」)擠掉或造成閃爍。 */
export function DiscordLiveBadge({ d }: { d: Dictionary['discord'] }) {
  const count = useDiscordPresence();
  if (count === null) return null;
  return <span className="live">{d.online.replace('{n}', fmt(count))}</span>;
}
