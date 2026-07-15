import { useEffect, useState } from "react";
import { getLang } from "./i18n";

/** Catalogs of Palworld entities, for labelling IDs and picking icons.
 * Served as static JSON from /game-data (see public/game-data/CREDITS.md).
 * 載入後會在背景比對 GitHub raw 上的最新版,名稱翻譯改了不用重新出版。 */
export interface GameEntity {
  id: string;
  /** English name (always present) */
  name: string;
  /** Traditional-Chinese name where known; extend the catalogs to add more */
  zh?: string;
  /** Simplified-Chinese name where known(scripts/fetch-zh-cn.mjs 由 paldb.cc /cn/ 抓) */
  zhCN?: string;
  /** Japanese name where known(scripts/fetch-game-data-i18n.mjs 由 paldb.cc 抓) */
  ja?: string;
  /** icon filename within the category folder, if we have artwork for it */
  icon?: string;
  /** passive-skill rank (詞條 catalog only): 1–5 good, negative = 惡性 */
  rank?: number;
  /** element for active skills (主動技 catalog only), e.g. "Fire" */
  element?: string;
}

/** Preferred display name for the current UI language (fallback: English). */
export const displayName = (e: GameEntity) => {
  const lang = getLang();
  if (lang === "zh-CN") return e.zhCN ?? e.zh ?? e.name;
  if (lang === "zh") return e.zh ?? e.name;
  if (lang === "ja") return e.ja ?? e.name;
  return e.name;
};

export interface GameData {
  pals: GameEntity[];
  items: GameEntity[];
  /** 帕魯蛋子集(items 中 id 以 PalEgg 開頭者),給「給予帕魯蛋」選單用,
   *  避免混入 Egg / FriedEggs 等食材。 */
  eggs: GameEntity[];
  /** 詞條(被動技)目錄,自訂帕魯用;id 為 PalDefender 內部 id */
  passives: GameEntity[];
  /** 主動技目錄,自訂帕魯用;id 為 EPalWazaID 去掉前綴 */
  activeSkills: GameEntity[];
  /** 人類 NPC 目錄(用帕魯球抓到的獵人/入侵者等,存檔的 CharacterID 也會指到這裡) */
  humans: GameEntity[];
  palById: Map<string, GameEntity>;
  itemById: Map<string, GameEntity>;
  passiveById: Map<string, GameEntity>;
  skillById: Map<string, GameEntity>;
  /** palById 的小寫鍵版本 —— 存檔的 CharacterID 大小寫不一定與圖鑑一致
   *  (實例:存檔 "Sheepball" vs 圖鑑 "SheepBall"),寬鬆查找用。 */
  palByIdLower: Map<string, GameEntity>;
  humanByIdLower: Map<string, GameEntity>;
}

export interface CharacterHit {
  entity: GameEntity;
  /** 完整圖示 URL(帕魯與人類 NPC 的圖檔在不同資料夾) */
  iconUrl?: string;
}

/** 依存檔/REST 的 CharacterID 查「帕魯或人類 NPC」:
 *  大小寫寬鬆、BOSS_ 前綴自動剝除;帕魯圖鑑優先,再查人類 NPC 目錄。 */
export function findCharacter(d: GameData | null, id: string): CharacterHit | undefined {
  if (!d || !id) return undefined;
  const bare = id.replace(/^BOSS_/i, "");
  const pal =
    d.palById.get(id) ??
    d.palById.get(bare) ??
    d.palByIdLower.get(id.toLowerCase()) ??
    d.palByIdLower.get(bare.toLowerCase());
  if (pal) return { entity: pal, iconUrl: pal.icon ? palIconUrl(pal.icon) : undefined };
  const human = d.humanByIdLower.get(id.toLowerCase()) ?? d.humanByIdLower.get(bare.toLowerCase());
  if (human) return { entity: human, iconUrl: human.icon ? humanIconUrl(human.icon) : undefined };
  return undefined;
}

const REMOTE_BASE =
  "https://raw.githubusercontent.com/io-software-ai/palserver-gui/main/packages/web/public/game-data/";

let cache: GameData | null = null;
let inflight: Promise<GameData> | null = null;
const listeners = new Set<(d: GameData) => void>();

type Catalogs = [GameEntity[], GameEntity[], GameEntity[], GameEntity[], GameEntity[]];

function build([pals, items, passives, activeSkills, humans]: Catalogs): GameData {
  return {
    pals,
    items,
    eggs: items.filter((i) => i.id.startsWith("PalEgg")),
    passives,
    activeSkills,
    humans,
    palById: new Map(pals.map((p) => [p.id, p])),
    itemById: new Map(items.map((i) => [i.id, i])),
    passiveById: new Map(passives.map((p) => [p.id, p])),
    skillById: new Map(activeSkills.map((s) => [s.id, s])),
    palByIdLower: new Map(pals.map((p) => [p.id.toLowerCase(), p])),
    humanByIdLower: new Map(humans.map((h) => [h.id.toLowerCase(), h])),
  };
}

async function fetchCatalogs(base: string, opts?: RequestInit): Promise<Catalogs> {
  const one = (file: string) =>
    fetch(`${base}${file}`, opts).then((r) => r.json() as Promise<GameEntity[]>);
  return Promise.all([
    one("pals.json"),
    one("items.json"),
    one("passives.json"),
    one("activeSkills.json"),
    // humans.json 較晚加入:遠端(GitHub raw)或舊快取拿不到時退空陣列,不擋整包
    one("humans.json").catch(() => [] as GameEntity[]),
  ]);
}

async function load(): Promise<GameData> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      cache = build(await fetchCatalogs("/game-data/"));
      void refreshFromRemote();
      return cache;
    })();
  }
  return inflight;
}

/** 背景抓 GitHub 上的最新目錄,跟 bundled 版不同就換上(本 session 一次)。 */
let refreshed = false;
async function refreshFromRemote(): Promise<void> {
  if (refreshed) return;
  refreshed = true;
  try {
    const fresh = await fetchCatalogs(REMOTE_BASE, {
      cache: "no-cache",
      signal: AbortSignal.timeout(15000),
    });
    const [pals, items] = fresh;
    if (
      Array.isArray(pals) &&
      Array.isArray(items) &&
      pals.length > 0 &&
      items.length > 0 &&
      (JSON.stringify(pals) !== JSON.stringify(cache?.pals) ||
        JSON.stringify(items) !== JSON.stringify(cache?.items))
    ) {
      cache = build(fresh);
      listeners.forEach((l) => l(cache!));
    }
  } catch {
    /* 離線或 GitHub 擋掉:用 bundled 版就好 */
  }
}

export function useGameData(): GameData | null {
  const [data, setData] = useState<GameData | null>(cache);
  useEffect(() => {
    listeners.add(setData);
    if (!cache) void load().then(setData).catch(() => setData(null));
    return () => {
      listeners.delete(setData);
    };
  }, []);
  return data;
}

export const palIconUrl = (icon: string) => `/game-data/pals/${icon}`;
export const itemIconUrl = (icon: string) => `/game-data/items/${icon}`;
export const humanIconUrl = (icon: string) => `/game-data/humans/${icon}`;
