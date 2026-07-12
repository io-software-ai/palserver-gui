import { useEffect, useState } from "react";

/** 實例詳情頁的分頁定義與「要顯示哪些分頁」的使用者偏好(存 localStorage,全實例共用)。 */
export type Tab =
  | "overview"
  | "performance"
  | "players"
  | "map"
  | "settings"
  | "engine"
  | "mods"
  | "paldefender"
  | "palstats"
  | "saves"
  | "restart"
  | "instance"
  | "logs";

/** 分頁顯示順序與標籤(label 會過 i18n)。「設定」刻意排在「日誌」右邊。 */
export const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "performance", label: "效能分析" },
  { id: "players", label: "玩家" },
  { id: "map", label: "線上地圖" },
  { id: "settings", label: "世界設定" },
  { id: "engine", label: "引擎微調" },
  { id: "mods", label: "模組" },
  { id: "paldefender", label: "PalDefender" },
  { id: "palstats", label: "帕魯數值" },
  { id: "saves", label: "存檔備份" },
  { id: "restart", label: "伺服器重啟" },
  { id: "logs", label: "日誌" },
  { id: "instance", label: "設定" },
];

/** 不可隱藏的分頁:總覽是預設落點,「設定」是調整分頁顯示的入口 —— 兩者都藏起來會沒有回頭路。 */
export const LOCKED_TABS: Tab[] = ["overview", "instance"];

const KEY = "palserver.hiddenTabs";
const EVENT = "palserver:tabprefs";

export function getHiddenTabs(): Tab[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v.filter((x) => !LOCKED_TABS.includes(x)) as Tab[]) : [];
  } catch {
    return [];
  }
}

export function setHiddenTabs(ids: Tab[]): void {
  const clean = ids.filter((id) => !LOCKED_TABS.includes(id));
  localStorage.setItem(KEY, JSON.stringify(clean));
  window.dispatchEvent(new Event(EVENT));
}

/** 訂閱隱藏分頁偏好(跨分頁/跨元件同步)。回傳目前值與更新函式。 */
export function useHiddenTabs(): [Tab[], (ids: Tab[]) => void] {
  const [hidden, setHidden] = useState<Tab[]>(getHiddenTabs);
  useEffect(() => {
    const onChange = () => setHidden(getHiddenTabs());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [hidden, (ids) => setHiddenTabs(ids)];
}

/** 總覽頁上可隱藏的卡片(可在設定裡恢復)。 */
export type OverviewCard = "migration" | "invite";
export const OVERVIEW_CARDS: { id: OverviewCard; label: string }[] = [
  { id: "migration", label: "存檔遷移" },
  { id: "invite", label: "邀請朋友加入" },
];

const CARD_KEY = "palserver.hiddenCards";
const CARD_EVENT = "palserver:cardprefs";

export function getHiddenCards(): OverviewCard[] {
  try {
    const v = JSON.parse(localStorage.getItem(CARD_KEY) ?? "[]");
    return Array.isArray(v) ? (v as OverviewCard[]) : [];
  } catch {
    return [];
  }
}

export function setHiddenCards(ids: OverviewCard[]): void {
  localStorage.setItem(CARD_KEY, JSON.stringify(ids));
  window.dispatchEvent(new Event(CARD_EVENT));
}

/** 訂閱隱藏卡片偏好。回傳目前值與更新函式。 */
export function useHiddenCards(): [OverviewCard[], (ids: OverviewCard[]) => void] {
  const [hidden, setHidden] = useState<OverviewCard[]>(getHiddenCards);
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
