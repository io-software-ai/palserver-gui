import { useEffect, useState } from "react";

/** 實例詳情頁的分頁定義與「要顯示哪些分頁」的使用者偏好(存 localStorage,全實例共用)。 */
export type Tab =
  | "overview"
  | "performance"
  | "players"
  | "guilds"
  | "leaderboard"
  | "map"
  | "settings"
  | "engine"
  | "mods"
  | "paldefender"
  | "palstats"
  | "saves"
  | "restart"
  | "instance";

/** 分頁顯示順序與標籤(label 會過 i18n)。「設定」刻意排在「日誌」右邊。 */
export const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "performance", label: "效能分析" },
  { id: "players", label: "玩家" },
  { id: "guilds", label: "公會" },
  { id: "leaderboard", label: "排行榜" },
  { id: "map", label: "線上地圖" },
  { id: "settings", label: "世界設定" },
  { id: "engine", label: "引擎微調" },
  { id: "mods", label: "模組" },
  { id: "paldefender", label: "PalDefender" },
  { id: "palstats", label: "帕魯數值" },
  { id: "saves", label: "存檔備份" },
  { id: "restart", label: "伺服器重啟" },
  { id: "instance", label: "設定" },
];

/** 不可隱藏的分頁:總覽是預設落點,「設定」是調整分頁顯示的入口 —— 兩者都藏起來會沒有回頭路。 */
export const LOCKED_TABS: Tab[] = ["overview", "instance"];

/** 依實例模式的預設可見分頁(新手體驗:先少後多,更多分頁到「設定」裡開):
 *  原味 = 開服最必要的五頁;強化(裝了模組)另外亮出吃 PalDefender/進階資料的五頁。 */
const VANILLA_VISIBLE: Tab[] = ["overview", "settings", "saves", "restart", "instance"];
// paldefender 不放進預設:一律由「模組」頁 PalDefender 卡的「設定」按鈕(或＋面板)開啟
const ENHANCED_VISIBLE: Tab[] = [...VANILLA_VISIBLE, "players", "guilds", "map", "palstats"];

/** 模式預設的「隱藏清單」(= 全部分頁 − 可見集合)。 */
export function defaultHiddenTabs(enhanced: boolean): Tab[] {
  const visible = new Set(enhanced ? ENHANCED_VISIBLE : VANILLA_VISIBLE);
  return TABS.map((t) => t.id).filter((id) => !visible.has(id) && !LOCKED_TABS.includes(id));
}

const KEY_PREFIX = "palserver.hiddenTabs."; // 每實例一份,完全獨立
const EVENT = "palserver:tabprefs";
// 注意:刻意「不」繼承舊版全域偏好(palserver.hiddenTabs)——否則升級後每台伺服器
// 都吃到同一份舊清單,原味 5 頁/強化 10 頁的模式預設永遠不會生效。
// 沒自訂過的實例一律用模式預設;要調整就到該實例的「設定 → 顯示的分頁」。

export function getHiddenTabs(instanceId: string, enhanced: boolean): Tab[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + instanceId);
    if (raw === null) return defaultHiddenTabs(enhanced);
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v.filter((x) => !LOCKED_TABS.includes(x)) as Tab[]) : defaultHiddenTabs(enhanced);
  } catch {
    return defaultHiddenTabs(enhanced);
  }
}

export function setHiddenTabs(instanceId: string, ids: Tab[]): void {
  const clean = ids.filter((id) => !LOCKED_TABS.includes(id));
  localStorage.setItem(KEY_PREFIX + instanceId, JSON.stringify(clean));
  window.dispatchEvent(new Event(EVENT));
}

/** 訂閱某實例的隱藏分頁偏好(跨分頁/跨元件同步)。
 *  enhanced(裝了模組/建立時選強化)只影響「還沒自訂過」時的預設集合。 */
export function useHiddenTabs(instanceId: string, enhanced: boolean): [Tab[], (ids: Tab[]) => void] {
  const [hidden, setHidden] = useState<Tab[]>(() => getHiddenTabs(instanceId, enhanced));
  useEffect(() => {
    setHidden(getHiddenTabs(instanceId, enhanced));
    const onChange = () => setHidden(getHiddenTabs(instanceId, enhanced));
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [instanceId, enhanced]);
  return [hidden, (ids) => setHiddenTabs(instanceId, ids)];
}

const ORDER_PREFIX = "palserver.tabOrder."; // 每實例一份的分頁順序
const ORDER_EVENT = "palserver:taborder";

/** 讀取分頁順序:儲存值剔除未知 id,新版新增的分頁依預設順序補在尾端。 */
export function getTabOrder(instanceId: string): Tab[] {
  const all = TABS.map((t) => t.id);
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_PREFIX + instanceId) ?? "null");
    const stored = Array.isArray(raw) ? (raw.filter((x: Tab) => all.includes(x)) as Tab[]) : [];
    return [...stored, ...all.filter((id) => !stored.includes(id))];
  } catch {
    return all;
  }
}

export function setTabOrder(instanceId: string, ids: Tab[]): void {
  localStorage.setItem(ORDER_PREFIX + instanceId, JSON.stringify(ids));
  window.dispatchEvent(new Event(ORDER_EVENT));
}

/** 訂閱某實例的分頁順序(拖曳排序用;跨元件同步)。 */
export function useTabOrder(instanceId: string): [Tab[], (ids: Tab[]) => void] {
  const [order, setOrder] = useState<Tab[]>(() => getTabOrder(instanceId));
  useEffect(() => {
    setOrder(getTabOrder(instanceId));
    const onChange = () => setOrder(getTabOrder(instanceId));
    window.addEventListener(ORDER_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(ORDER_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [instanceId]);
  return [order, (ids) => setTabOrder(instanceId, ids)];
}

/**
 * 可隱藏的卡片與警告(按叉叉收起,可在設定→「卡片隱藏」恢復)。
 * 兩類共用同一份 localStorage 清單,id 為任意字串;新增可關閉的警告時,
 * 在 DISMISSIBLE_WARNINGS 補一筆(id 以 "warn-" 開頭),設定頁就會自動列出可恢復。
 */
export type OverviewCard = string;
export const OVERVIEW_CARDS: { id: string; label: string }[] = [
  { id: "invite", label: "邀請朋友加入" },
];

/** 各分頁上「常駐資訊型」黃色警告 —— 包一層 <DismissibleWarning> 即可按叉叉收起。 */
export const DISMISSIBLE_WARNINGS: { id: string; label: string }[] = [
  { id: "warn-mods-compat", label: "模組:改版相容性提醒" },
  { id: "warn-palstats-risk", label: "帕魯數值:mod 風險提示" },
];

/** 推廣型卡片(代管維護等) —— 可按叉叉收起。 */
export const DISMISSIBLE_PROMOS: { id: string; label: string }[] = [
  { id: "promo-maintenance", label: "引擎微調:交給我們維護" },
];

/** 所有可隱藏項目的 id→label(設定頁用來列出目前已隱藏的項目)。 */
export const DISMISSIBLE_LABELS: Record<string, string> = Object.fromEntries(
  [...OVERVIEW_CARDS, ...DISMISSIBLE_WARNINGS, ...DISMISSIBLE_PROMOS].map((c) => [c.id, c.label]),
);

const CARD_KEY = "palserver.hiddenCards";
const CARD_EVENT = "palserver:cardprefs";

export function getHiddenCards(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CARD_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function setHiddenCards(ids: string[]): void {
  localStorage.setItem(CARD_KEY, JSON.stringify(ids));
  window.dispatchEvent(new Event(CARD_EVENT));
}

/** 訂閱隱藏卡片偏好。回傳目前值與更新函式。 */
export function useHiddenCards(): [string[], (ids: string[]) => void] {
  const [hidden, setHidden] = useState<string[]>(getHiddenCards);
  useEffect(() => {
    const onChange = () => setHidden(getHiddenCards());
    window.addEventListener(CARD_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CARD_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [hidden, (ids) => setHiddenCards(ids)];
}
