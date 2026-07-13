import { useEffect, useState } from "react";
import { t, getLang, type Lang } from "./i18n";

/**
 * 日誌重點標記 + 格式化(贊助者功能 log-tools)。
 *
 * 規則的 regex 全部對照「真實的 PalDefender log」(格式 `[時:分:秒][等級] 訊息`)整理:
 *   加入   'Name' (UserId=…, IP=…) has logged in.  /  steam_xxx ('IP') connected to the server.
 *   離開   'Name' (…) has logged out.
 *   聊天   [Chat::Global]['Name' (UserId=…)]: 訊息
 *   死亡   'Name' (…) died to …  /  was attacked by a wild '…' and died.
 *   捕捉   'Name' (…) has captured Pal '…' at x y z.
 *   建造   'Name' (…) has build a …
 *   警告/錯誤  [warning] … / [error] … / LowLevelFatalError
 * classifyLine 依「陣列順序」由上而下取第一個命中(聊天/加入等 info 事件排在 warn/error 前)。
 */
export interface LogCategory {
  id: string;
  label: string;
  color: string;
  test: RegExp;
}

export const LOG_CATEGORIES: LogCategory[] = [
  { id: "chat", label: "聊天", color: "#5fb0ff", test: /\[Chat::/i },
  { id: "join", label: "玩家加入", color: "#57d38c", test: /connected to the server|has logged in\b/i },
  { id: "leave", label: "玩家離開", color: "#9aa4b2", test: /has logged out\b|disconnected from the server/i },
  { id: "death", label: "死亡", color: "#ff6b6b", test: /\bdied to\b|and died\.|was killed\b/i },
  { id: "capture", label: "捕捉帕魯", color: "#c792ea", test: /has captured Pal|picked up Pal/i },
  { id: "warn", label: "警告", color: "#ffcf5f", test: /\[warning\]|(?:^|\s)Warning:/i },
  { id: "error", label: "錯誤", color: "#ff5c7a", test: /\[error\]|LowLevelFatalError|(?:^|\s)Error:/i },
];

const COLOR_BY_ID: Record<string, string> = Object.fromEntries(LOG_CATEGORIES.map((c) => [c.id, c.color]));

/** 依上到下的優先序回傳第一個命中的分類 id;都沒中回 null。 */
export function classifyLine(line: string): string | null {
  for (const c of LOG_CATEGORIES) if (c.test.test(line)) return c.id;
  return null;
}

export function categoryColor(id: string | null): string {
  return (id && COLOR_BY_ID[id]) || "#cfd6df";
}

/**
 * 把一行 raw log 套版成管理者好讀的句子(依目前介面語言)。認得的事件才轉,認不得回 null
 * (由呼叫端顯示原文)。時間取到分。
 */
const TIME_RE = /^\[(\d\d:\d\d):\d\d\]/;
export function formatLine(raw: string): string | null {
  const line = raw.replace(/[\s﻿]+$/, ""); // 去尾端空白/CR,讓 $ 錨點正常匹配
  const tm = line.match(TIME_RE);
  const pre = tm ? `${tm[1]}  ` : "";
  let m: RegExpMatchArray | null;
  if ((m = line.match(/\[Chat::(\w+)\]\['([^']+)'[^\]]*\]:\s?(.*)$/)))
    return pre + t("{name}〔{ch}〕{msg}", { name: m[2], ch: m[1], msg: m[3] });
  if ((m = line.match(/'([^']+)'[^)]*\) has logged in/)))
    return pre + t("{name} 加入伺服器", { name: m[1] });
  if ((m = line.match(/'([^']+)'[^)]*\) has logged out/)))
    return pre + t("{name} 離開伺服器", { name: m[1] });
  if ((m = line.match(/(steam_\w+) \('[^']*'\) connected to the server/)))
    return pre + t("{id} 連線中…", { id: m[1] });
  if ((m = line.match(/'([^']+)'[^)]*\) was attacked by a wild '([^']+)'.*died/)))
    return pre + t("{name} 被野生 {pal} 擊殺", { name: m[1], pal: m[2] });
  if ((m = line.match(/'([^']+)'[^)]*\) died to (.+?)\.?$/)))
    return pre + t("{name} 死亡:{cause}", { name: m[1], cause: m[2] });
  if ((m = line.match(/'([^']+)'[^)]*\) has captured Pal '([^']+)'/)))
    return pre + t("{name} 捕捉了 {pal}", { name: m[1], pal: m[2] });
  if ((m = line.match(/'([^']+)'[^)]*\) has build a (.+?)\.?$/)))
    return pre + t("{name} 建造了 {what}", { name: m[1], what: m[2] });
  return null;
}

/**
 * 套不了版的一般行:拆出 `[時間][等級] 訊息` 的「時間 + 英文訊息」,訊息交給 Google 翻譯。
 * 認不得前綴的(如無前綴的崩潰行)回 null,由呼叫端顯示原文。
 */
export function genericLine(raw: string): { time: string; message: string } | null {
  const line = raw.replace(/[\s﻿]+$/, "");
  const m = line.match(/^\[(\d\d:\d\d):\d\d\]\[[a-z]+\]\s?(.*)$/);
  return m ? { time: m[1], message: m[2] } : null;
}

/** 目前介面語言 → Google Translate 的目標語碼。 */
export function translateTarget(lang: Lang = getLang()): string {
  return lang === "zh" ? "zh-TW" : lang === "ja" ? "ja" : "en";
}

const HL_KEY = "palserver.logHighlight";
const FMT_KEY = "palserver.logFormat";
const EVENT = "palserver:logprefs";

const readBool = (k: string, def: boolean) => {
  const v = localStorage.getItem(k);
  return v === null ? def : v === "1";
};
const writeBool = (k: string, on: boolean) => {
  localStorage.setItem(k, on ? "1" : "0");
  window.dispatchEvent(new Event(EVENT));
};

/** 訂閱「重點標記 / 格式化」兩個開關(預設都開)。 */
export function useLogPrefs(): {
  highlight: boolean;
  format: boolean;
  setHighlight: (on: boolean) => void;
  setFormat: (on: boolean) => void;
} {
  const [, bump] = useState(0);
  useEffect(() => {
    const h = () => bump((n) => n + 1);
    window.addEventListener(EVENT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVENT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return {
    highlight: readBool(HL_KEY, true),
    format: readBool(FMT_KEY, true),
    setHighlight: (on) => writeBool(HL_KEY, on),
    setFormat: (on) => writeBool(FMT_KEY, on),
  };
}
