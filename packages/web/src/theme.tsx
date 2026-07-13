import { useEffect, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import { useI18n } from "./i18n";

/**
 * 主題 = 「系列(family) × 深/淺」雙軸。
 *  - family: pal(帕魯原色,免費)、silver(白銀 Vercel,贊助)、emerald(翡翠棲地,贊助)
 *  - 深/淺: pal 支援 auto(跟隨系統);silver/emerald 為明確 light/dark
 * 手動選擇在 <html> 掛 data-theme,styles.css 據此覆蓋色票;存 localStorage,
 * main.tsx 在 React 掛載前先套用避免閃色。舊值 "sponsor" 遷移為 "silver-dark"。
 */

export const THEME_FAMILIES = ["pal", "silver", "emerald", "lilac", "cherry", "cat"] as const;
export type ThemeFamily = (typeof THEME_FAMILIES)[number];

/** 存檔/套用用的完整主題值。pal 家族沿用舊的 auto/light/dark(向後相容)。 */
export type ThemeMode =
  | "auto"
  | "light"
  | "dark"
  | "silver-light"
  | "silver-dark"
  | "emerald-light"
  | "emerald-dark"
  | "lilac-light"
  | "lilac-dark"
  | "cherry-light"
  | "cherry-dark"
  | "cat-light"
  | "cat-dark";

const KEY = "palserver.theme";

export function themeFamily(m: ThemeMode): ThemeFamily {
  if (m.startsWith("silver")) return "silver";
  if (m.startsWith("emerald")) return "emerald";
  if (m.startsWith("lilac")) return "lilac";
  if (m.startsWith("cherry")) return "cherry";
  if (m.startsWith("cat")) return "cat";
  return "pal";
}

/** 由「系列 + 是否深色」組出主題值。 */
export function composeTheme(family: ThemeFamily, dark: boolean): ThemeMode {
  if (family === "pal") return dark ? "dark" : "light";
  return `${family}-${dark ? "dark" : "light"}` as ThemeMode;
}

/** 此主題值在目前系統外觀下是否為深色(auto 才需要 systemDark)。 */
export function isThemeDark(m: ThemeMode, systemDark: boolean): boolean {
  if (m === "auto") return systemDark;
  return m.endsWith("dark");
}

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "sponsor") return "silver-dark"; // 舊值遷移
    if (
      v === "light" || v === "dark" ||
      v === "silver-light" || v === "silver-dark" ||
      v === "emerald-light" || v === "emerald-dark" ||
      v === "lilac-light" || v === "lilac-dark" ||
      v === "cherry-light" || v === "cherry-dark" ||
      v === "cat-light" || v === "cat-dark"
    ) {
      return v;
    }
    return "auto";
  } catch {
    return "auto";
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

/** 目前主題:跨元件共享的單一真相,避免 header 切換鈕與主題選擇器各持一份而不同步。 */
let currentMode: ThemeMode = loadThemeMode();
const modeListeners = new Set<(m: ThemeMode) => void>();

/** 套用並記住主題選擇,並通知所有訂閱者(header 切換鈕、主題選擇器…)。 */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  applyThemeMode(mode);
  try {
    if (mode === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* 無痕模式存不進去就只作用這一次 */
  }
  modeListeners.forEach((l) => l(mode));
}

/** 訂閱目前主題;任何地方 setThemeMode 後,用此 hook 的元件都會同步更新。 */
export function useThemeMode(): ThemeMode {
  const [m, setM] = useState<ThemeMode>(() => currentMode);
  useEffect(() => {
    modeListeners.add(setM);
    setM(currentMode); // render 與 effect 之間若有變動,補一次
    return () => {
      modeListeners.delete(setM);
    };
  }, []);
  return m;
}

/** 訂閱系統深淺色。 */
export function useSystemDark(): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return systemDark;
}

/**
 * header 上的圓形切換鈕:在目前主題「系列」內切換深/淺(從目前實際外觀的反面開始)。
 * 圖示顯示目前實際的深淺色(太陽/月亮)。
 */
export function ThemeToggle() {
  const { t } = useI18n();
  const mode = useThemeMode();
  const systemDark = useSystemDark();
  const isDark = isThemeDark(mode, systemDark);
  const toggle = () => setThemeMode(composeTheme(themeFamily(mode), !isDark));
  const Icon = isDark ? FiMoon : FiSun;
  const label = isDark ? t("深色模式") : t("淺色模式");
  return (
    <button
      className="rounded-full border-2 border-line bg-card-soft p-2 text-ink transition hover:-translate-y-px hover:border-pal active:translate-y-0 active:scale-95"
      onClick={toggle}
      title={t("外觀:{label}(點擊切換)", { label })}
      aria-label={t("外觀:{label}(點擊切換)", { label })}
    >
      <Icon className="size-4" />
    </button>
  );
}
