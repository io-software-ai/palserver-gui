import { useState } from "react";
import { FiCheck, FiLock, FiMoon, FiStar, FiSun, FiX } from "react-icons/fi";
import { t, useI18n } from "./i18n";
import { Overlay, card } from "./ui";
import {
  composeTheme,
  isThemeDark,
  setThemeMode,
  themeFamily,
  useSystemDark,
  useThemeMode,
  type ThemeFamily,
} from "./theme";

interface Swatch {
  bg: string;
  card: string;
  accent: string;
  ink: string;
  accentText: string;
}
interface ThemeDef {
  family: ThemeFamily;
  name: string;
  blurb: string;
  free: boolean;
  preview: Record<"light" | "dark", Swatch>;
}

/** 各主題的預覽色(對應 styles.css 的色票)——只給小預覽用,不影響實際主題。 */
const THEMES: ThemeDef[] = [
  {
    family: "pal",
    name: "帕魯原色",
    blurb: "陽光草原 / 梅紫夜",
    free: true,
    preview: {
      light: { bg: "#f7fbfd", card: "#ffffff", accent: "#3fa7e0", ink: "#2f3a45", accentText: "#ffffff" },
      dark: { bg: "#232030", card: "#2d2a3b", accent: "#5bb8ec", ink: "#eceaf2", accentText: "#0d1420" },
    },
  },
  {
    family: "silver",
    name: "白銀",
    blurb: "純黑白銀 / 極簡光暈",
    free: false,
    preview: {
      light: { bg: "#f4f5f7", card: "#ffffff", accent: "#18181b", ink: "#16171a", accentText: "#fafafa" },
      dark: { bg: "#000000", card: "#0f0f0f", accent: "#ededed", ink: "#fafafa", accentText: "#0a0a0a" },
    },
  },
  {
    family: "emerald",
    name: "極光翡翠",
    blurb: "鮮翡翠 / 青檸光暈",
    free: false,
    preview: {
      light: { bg: "#ecfdf4", card: "#ffffff", accent: "#10b981", ink: "#0f2b20", accentText: "#ffffff" },
      dark: { bg: "#123a2b", card: "#1b4a38", accent: "#24e39a", ink: "#ecfdf3", accentText: "#06241a" },
    },
  },
  {
    family: "lilac",
    name: "午夜紫",
    blurb: "薰衣草晝 / 午夜紫夜",
    free: false,
    preview: {
      light: { bg: "#f6f2fe", card: "#ffffff", accent: "#8b5cf6", ink: "#2a2140", accentText: "#ffffff" },
      dark: { bg: "#17122a", card: "#221a3c", accent: "#b79bff", ink: "#f0eafb", accentText: "#1a1030" },
    },
  },
  {
    family: "cherry",
    name: "櫻花粉",
    blurb: "淡櫻晝 / 深梅玫夜",
    free: false,
    preview: {
      light: { bg: "#fdf1f7", card: "#ffffff", accent: "#ee5fa0", ink: "#40222f", accentText: "#ffffff" },
      dark: { bg: "#2a1620", card: "#3a2130", accent: "#ff8ab8", ink: "#fdeef5", accentText: "#2a0f1c" },
    },
  },
  {
    family: "cat",
    name: "橘色貓貓",
    blurb: "暖薑橘晝 / 焦糖夜",
    free: false,
    preview: {
      light: { bg: "#fff6ec", card: "#ffffff", accent: "#f5943a", ink: "#3d2a1a", accentText: "#ffffff" },
      dark: { bg: "#241a11", card: "#322416", accent: "#ff9d4d", ink: "#fbeedd", accentText: "#2a1808" },
    },
  },
];

/** 主題的迷你即時預覽:用該主題真實色渲染的小卡(底 + 卡片 + 按鈕 + 文字列)。 */
function MiniPreview({ s }: { s: Swatch }) {
  return (
    <div
      className="flex h-20 flex-col justify-between rounded-xl p-2.5"
      style={{ background: s.bg }}
    >
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full" style={{ background: s.accent }} />
        <span className="h-1.5 w-10 rounded-full" style={{ background: s.ink, opacity: 0.75 }} />
      </div>
      <div className="rounded-lg p-1.5" style={{ background: s.card }}>
        <span className="mb-1 block h-1.5 w-3/4 rounded-full" style={{ background: s.ink, opacity: 0.45 }} />
        <span
          className="inline-block rounded-full px-2 py-0.5 text-[9px] font-bold"
          style={{ background: s.accent, color: s.accentText }}
        >
          Aa
        </span>
      </div>
    </div>
  );
}

/**
 * 外觀主題選擇器(質感彈窗):3 套主題各帶迷你即時預覽,頂部切深/淺,
 * 選中有勾勾;白銀 / 翡翠為贊助者專屬,未解鎖時鎖住並提示。
 */
export function ThemePicker({ entitled, onClose }: { entitled: boolean; onClose: () => void }) {
  useI18n();
  const systemDark = useSystemDark();
  const mode = useThemeMode();
  const [lockedHint, setLockedHint] = useState(false);

  const dark = isThemeDark(mode, systemDark);
  const activeFamily = themeFamily(mode);

  const apply = (family: ThemeFamily, free: boolean) => {
    if (!free && !entitled) {
      setLockedHint(true);
      return;
    }
    setThemeMode(composeTheme(family, dark));
  };
  const setDark = (d: boolean) => setThemeMode(composeTheme(activeFamily, d));

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[90vh] w-140 max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold">{t("外觀主題")}</h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {/* 深 / 淺 分段切換 */}
        <div className="flex gap-1 rounded-full border-2 border-line bg-card-soft p-1">
          {([
            ["light", t("淺色"), FiSun],
            ["dark", t("深色"), FiMoon],
          ] as const).map(([key, label, Icon]) => {
            const on = key === "dark" ? dark : !dark;
            return (
              <button
                key={key}
                onClick={() => setDark(key === "dark")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-[13px] font-extrabold transition ${
                  on ? "bg-pal text-white" : "text-ink-muted hover:text-ink"
                }`}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            );
          })}
        </div>

        {/* 主題卡 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEMES.map((th) => {
            const selected = activeFamily === th.family;
            const locked = !th.free && !entitled;
            return (
              <button
                key={th.family}
                onClick={() => apply(th.family, th.free)}
                className={`relative flex flex-col gap-2 rounded-cute border-2 p-2.5 text-left transition ${
                  selected ? "border-pal shadow-(--shadow-cute)" : "border-line hover:border-pal/50"
                } ${locked ? "opacity-75" : ""}`}
              >
                <MiniPreview s={th.preview[dark ? "dark" : "light"]} />
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-extrabold">{t(th.name)}</p>
                    <p className="truncate text-[11px] text-ink-muted">{t(th.blurb)}</p>
                  </div>
                  {selected ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-pal text-white">
                      <FiCheck className="size-3.5" />
                    </span>
                  ) : (
                    !th.free && (
                      <FiStar className="mt-0.5 size-4 shrink-0 text-pal" />
                    )
                  )}
                </div>
                {locked && (
                  <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    <FiLock className="size-3" /> {t("贊助")}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {lockedHint && !entitled && (
          <p className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            <FiLock className="size-4 shrink-0" />
            {t("帶星號的主題為贊助者專屬,請在下方輸入贊助者識別碼解鎖。")}
          </p>
        )}
      </div>
    </Overlay>
  );
}
