import { useEffect, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";

/**
 * 深淺色模式:預設跟隨系統(auto),但 auto 只是還沒選過的初始狀態 ——
 * 一旦手動切換就只在淺色/深色之間互切,不再回到跟隨系統。
 * 手動選擇時在 <html> 上掛 data-theme,styles.css 據此覆蓋色票;
 * 選擇存 localStorage,main.tsx 在 React 掛載前先套用,避免閃色。
 */

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "palserver.theme";

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

/**
 * header 上的圓形切換鈕,點一下在淺色/深色之間互切(從目前實際外觀的
 * 反面開始)。圖示顯示目前實際的深淺色(太陽/月亮);還沒選過時跟著
 * 系統外觀走,系統切換時圖示也即時跟著換。
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const isDark = mode === "dark" || (mode === "auto" && systemDark);
  const toggle = () => {
    const next: ThemeMode = isDark ? "light" : "dark";
    setMode(next);
    applyThemeMode(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* 無痕模式等存不進去就只作用這一次 */
    }
  };
  const Icon = isDark ? FiMoon : FiSun;
  const label = isDark ? "深色模式" : "淺色模式";
  return (
    <button
      className="rounded-full border-2 border-line bg-card-soft p-2 text-ink transition hover:-translate-y-px hover:border-pal active:translate-y-0 active:scale-95"
      onClick={toggle}
      title={`外觀:${label}(點擊切換)`}
      aria-label={`外觀:${label}`}
    >
      <Icon className="size-4" />
    </button>
  );
}
