import { useEffect, useState } from "react";

/**
 * Promo/config data (company links, the IP-direct-connect service, VPN
 * tutorials) lives in promo-config.json in the GitHub repo, so it can be
 * updated without shipping a new build.
 *
 * Load order (per requirement):
 *  1. use the localStorage cache immediately, if any (last successful fetch) —
 *     so offline shows the most recent known values, not blanks;
 *  2. fetch the raw file from GitHub; on success, refresh the cache + UI;
 *  3. if there's no cache and GitHub is unreachable, fall back to the copy
 *     bundled at /promo-config.json (same origin, always available offline);
 *  4. the hardcoded DEFAULT below is the last resort.
 */

export interface PromoConfig {
  company: { name: string; website: string; instagram: string; discord: string; sponsor: string };
  ipService: { name: string; website: string; discord: string };
  /** 常見問題站,header 與頁尾都會連過去。 */
  faq: string;
  /** 我們自己的遊戲伺服器代管維護服務(月費制),在引擎微調頁推廣。 */
  maintenanceService: { name: string; url: string; tagline: string; email: string };
  vpn: {
    radmin: { site: string; tutorial: string };
    tailscale: { site: string; tutorial: string };
  };
  /** playit.gg 官網與教學連結(邀請卡 playit 分頁)。 */
  playit: { site: string; tutorial: string };
  /** 感謝名單(header 右上角彈窗):開發人員 + 推廣大使 + 捐贈名單連結。 */
  credits: {
    developers: { name: string; role: string; url?: string }[];
    /** 推廣大使(YouTuber / 社群推廣者);舊版遠端設定可能沒有這欄。 */
    ambassadors?: { name: string; role: string; url?: string }[];
    donate: string;
  };
}

const REMOTE_URL =
  "https://raw.githubusercontent.com/io-software-ai/palserver-gui/main/promo-config.json";
const LOCAL_URL = "/promo-config.json";
const CACHE_KEY = "palserver.promoConfig";

/** Baked-in last resort, mirrors the committed promo-config.json. */
const DEFAULT: PromoConfig = {
  company: {
    name: "io software",
    website: "https://iosoftware.ai/",
    instagram: "https://www.instagram.com/iosoftware.ai/",
    discord: "https://discord.gg/sgMMdUZd3V",
    sponsor: "https://buymeacoffee.com/dalufish",
  },
  ipService: {
    name: "IP 直連設定服務",
    website: "https://iosoftware.ai/ip-connect-service",
    discord: "https://discord.gg/sgMMdUZd3V",
  },
  faq: "https://faq.toc.icu/",
  maintenanceService: {
    name: "遊戲伺服器維護服務",
    url: "https://iosoftware.ai/server-maintain-service",
    tagline: "版本更新、存檔備份、崩潰救援、連線設定,月費制透明計價,維運交給我們。",
    email: "contact@iosoftware.ai",
  },
  vpn: {
    radmin: {
      site: "https://www.radmin-vpn.com/",
      tutorial:
        "https://www.youtube.com/results?search_query=Radmin+VPN+Palworld+%E8%81%AF%E6%A9%9F+%E6%95%99%E5%AD%B8",
    },
    tailscale: {
      site: "https://tailscale.com/",
      tutorial:
        "https://www.youtube.com/results?search_query=Tailscale+Palworld+%E5%B0%88%E7%94%A8%E4%BC%BA%E6%9C%8D%E5%99%A8+%E6%95%99%E5%AD%B8",
    },
  },
  playit: {
    site: "https://playit.gg/",
    tutorial:
      "https://www.youtube.com/results?search_query=playit.gg+Palworld+%E4%BC%BA%E6%9C%8D%E5%99%A8+%E6%95%99%E5%AD%B8",
  },
  credits: {
    developers: [
      { name: "Dalufish", role: "核心開發人員", url: "https://www.instagram.com/stories/easonlu0303/" },
      { name: "147", role: "核心團隊維護者", url: "https://toc.icu" },
      { name: "墨殘", role: "核心團隊維護者", url: "https://www.youtube.com/@Bad_Mo" },
      { name: "LilaS", role: "核心團隊維護者・資安", url: "https://lilas-tw.com/" },
      { name: "咖啡", role: "核心團隊維護者" },
    ],
    ambassadors: [{ name: "捷克", role: "推廣大使", url: "https://www.youtube.com/@PXJ" }],
    donate: "https://buymeacoffee.com/dalufish",
  },
};

function readCache(): PromoConfig | null {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function looksValid(v: unknown): v is Partial<PromoConfig> {
  const c = v as PromoConfig | null;
  return !!c?.company?.website && !!c?.ipService?.website && !!c?.vpn?.radmin?.site;
}

/** 把抓到的設定套在 DEFAULT 上,新欄位(遠端 JSON 還沒補的)才不會是 undefined。 */
function withDefaults(c: Partial<PromoConfig> | null): PromoConfig {
  return { ...DEFAULT, ...(c ?? {}) };
}

/**
 * Reactive config: starts from cache-or-default, then refreshes from GitHub.
 * Shared module state means it's fetched at most once per session.
 */
let shared: PromoConfig = withDefaults(readCache());
let fetched = false;
const listeners = new Set<(c: PromoConfig) => void>();

async function refresh(): Promise<void> {
  if (fetched) return;
  fetched = true;
  // 1) remote (GitHub) — the source of truth.
  try {
    const res = await fetch(REMOTE_URL, { cache: "no-cache", signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      if (looksValid(data)) {
        shared = withDefaults(data);
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        listeners.forEach((l) => l(shared));
        return;
      }
    }
  } catch {
    /* offline or blocked — fall through */
  }
  // 2) if we had no cache to begin with, try the bundled local copy.
  if (!readCache()) {
    try {
      const res = await fetch(LOCAL_URL, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        if (looksValid(data)) {
          shared = withDefaults(data);
          listeners.forEach((l) => l(shared));
        }
      }
    } catch {
      /* keep DEFAULT */
    }
  }
}

export function usePromoConfig(): PromoConfig {
  const [config, setConfig] = useState(shared);
  useEffect(() => {
    listeners.add(setConfig);
    void refresh();
    setConfig(shared);
    return () => {
      listeners.delete(setConfig);
    };
  }, []);
  return config;
}
