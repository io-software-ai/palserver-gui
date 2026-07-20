import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { MessageBridgeLanguage } from "@palserver/shared";

/**
 * Agent 端的多语言字典加载与渲染(参考 packages/web/src/i18n.tsx 的约定):
 *  - 通用 i18n 字典单一来源:`packages/web/public/i18n/{zh-CN,en,ja}.json` —— 跟
 *    web 端共享同一份人工校对文件,不重复维护。
 *  - 词条/被动技能字典:`packages/web/public/game-data/passives.json` —— 跟
 *    web 端 breeding solver 共用,数据 shape = `[{id, name, zh, "zh-CN", rank}]`。
 *  - key 一律使用繁中(zh-TW)原文;zh-TW 模式直接返回 key,其他语言查表,
 *    查不到 fallback 到原文(漏翻不会坏版面)。
 *  - 插值用 `{name}` 形式。
 *
 * 加载策略:首次按需同步读取并缓存;启动时不需要 IO,延迟到第一次调用。
 * 字典都很小(<2k 条),JSON 整体读进内存,查找 O(1)。
 */

const SUPPORTED: ReadonlyArray<MessageBridgeLanguage> = ["zh-TW", "zh-CN", "en", "ja"];

const cache: Partial<Record<MessageBridgeLanguage, Record<string, string>>> = {};

/**
 * 開發時資源在 packages/web/public；SEA 發行版則在執行檔旁的 web/。
 * esbuild 的 CJS bundle 沒有 import.meta.url，因此該候選必須容錯。
 */
let resolvedWebPublicDir: string | null | undefined;
export function webPublic(): string | null {
  if (resolvedWebPublicDir !== undefined) return resolvedWebPublicDir;
  const candidates: string[] = [];
  if (process.env.PALSERVER_WEB_DIR) candidates.push(process.env.PALSERVER_WEB_DIR);
  candidates.push(path.join(path.dirname(process.execPath), "web"));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public"));
  } catch {
    // import.meta.url is unavailable in the SEA CommonJS bundle.
  }
  resolvedWebPublicDir = candidates.find((candidate) =>
    existsSync(path.join(candidate, "i18n")) && existsSync(path.join(candidate, "game-data")),
  ) ?? null;
  return resolvedWebPublicDir;
}

function loadDict(lang: MessageBridgeLanguage): Record<string, string> {
  const cached = cache[lang];
  if (cached) return cached;
  if (lang === "zh-TW") {
    // zh-TW 的 key = value,字典为空
    cache[lang] = {};
    return cache[lang]!;
  }
  const root = webPublic();
  if (!root) {
    cache[lang] = {};
    return cache[lang]!;
  }
  const file = path.join(root, "i18n", `${lang}.json`);
  if (!existsSync(file)) {
    cache[lang] = {};
    return cache[lang]!;
  }
  try {
    cache[lang] = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch (err) {
    console.warn(`[i18n] failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
    cache[lang] = {};
  }
  return cache[lang]!;
}

/** 用繁中原文作 key 查字典,缺译 fallback 到原文;带 {name} 等占位符的模板可一并替换。 */
export function t(lang: MessageBridgeLanguage, key: string, vars?: Record<string, string | number>): string {
  const dict = loadDict(lang);
  const text = dict[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

/** 测试 / 调试用:把字典强制重读(改 JSON 后无需重启 agent 即可生效)。 */
export function clearI18nCache(): void {
  for (const lang of SUPPORTED) delete cache[lang];
  passiveCache = null;
  itemCache = null;
  resolvedWebPublicDir = undefined;
}

// ── 词条 / 被动技能本地化 ──────────────────────────────────────────────────

interface PassiveRow {
  id: string;
  name: string;
  zh?: string;
  "zh-CN"?: string;
  rank?: number;
}

let passiveCache: Map<string, PassiveRow> | null = null;

function loadPassives(): Map<string, PassiveRow> {
  if (passiveCache) return passiveCache;
  const root = webPublic();
  if (!root) {
    passiveCache = new Map();
    return passiveCache;
  }
  const file = path.join(root, "game-data", "passives.json");
  if (!existsSync(file)) {
    passiveCache = new Map();
    return passiveCache;
  }
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as PassiveRow[];
    passiveCache = new Map();
    for (const row of rows) {
      if (row.id) passiveCache.set(row.id, row);
    }
  } catch (err) {
    console.warn(`[i18n] failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
    passiveCache = new Map();
  }
  return passiveCache;
}

/** PalDefender / RCON 给出的词条 ID → 4 语言译名。
 *  优先级:zh-TW 用 `zh` (繁中),zh-CN 用 `zh-CN`,en 用 `name`,ja 暂 fallback 到 `name`。
 *  查不到整行 ID 直接返回原文,避免坏版面。 */
export function localizePassive(value: string, language: MessageBridgeLanguage): string {
  const row = loadPassives().get(value);
  if (!row) return value;
  switch (language) {
    case "zh-TW": return row.zh ?? row["zh-CN"] ?? row.name ?? value;
    case "zh-CN": return row["zh-CN"] ?? row.zh ?? row.name ?? value;
    case "en": return row.name ?? value;
    case "ja": return row.name ?? value; // passives.json 暂无 ja,先 fallback 到 en
  }
}

// ── 物品本地化 ──────────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  name: string;
  zh?: string;
  "zh-CN"?: string;
  zhCN?: string;
  ja?: string;
}

let itemCache: Map<string, ItemRow> | null = null;

function loadItems(): Map<string, ItemRow> {
  if (itemCache) return itemCache;
  const root = webPublic();
  if (!root) return (itemCache = new Map());
  const file = path.join(root, "game-data", "items.json");
  if (!existsSync(file)) return (itemCache = new Map());
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as ItemRow[];
    itemCache = new Map(rows.filter((row) => row.id).map((row) => [row.id.toLowerCase(), row]));
  } catch (err) {
    console.warn(`[i18n] failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
    itemCache = new Map();
  }
  return itemCache;
}

function usableItemName(value: string | undefined): string | undefined {
  const name = value?.trim();
  return name && name !== "-" ? name : undefined;
}

/** PalDefender ItemID → items.json 中的四语言名称。 */
export function localizeItem(value: string, language: MessageBridgeLanguage): string {
  const row = loadItems().get(value.toLowerCase());
  if (!row) return value;
  switch (language) {
    case "zh-TW": return usableItemName(row.zh) ?? usableItemName(row["zh-CN"]) ?? usableItemName(row.name) ?? value;
    case "zh-CN": return usableItemName(row["zh-CN"]) ?? usableItemName(row.zhCN) ?? usableItemName(row.zh) ?? usableItemName(row.name) ?? value;
    case "en": return usableItemName(row.name) ?? value;
    case "ja": return usableItemName(row.ja) ?? usableItemName(row.name) ?? value;
  }
}
