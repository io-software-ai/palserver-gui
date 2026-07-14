#!/usr/bin/env node
/**
 * 抓地圖「礦物節點」資料,給線上地圖的礦物圖層用(贊助者功能)。
 *
 * 資料來源(維護者為貢獻者,已獲同意;見 public/game-data/CREDITS.md):
 *  - paldb.cc/js/map_data_en.js 的 `fixedDungeon` 陣列 —— 與 landmarks.json/bosses.json
 *    同一來源;`ipos` 就是遊戲內地圖座標(＝我們地圖的 x/y,不需換算)。
 *  - 名稱(en/zh/ja/zhCN)與圖示:對接既有 items.json(map_data 的 type → item id 對照
 *    寫死在下方 TYPES;「Cluster」大型礦脈共用同款 item,名稱加「(大型)」後綴)。
 *  - Ancient Lava/Bone/Bark(各 10 點)刻意不收:items.json 無對應條目,無可靠翻譯。
 *
 * 產出:packages/web/public/game-data/ores.json
 *   { types: { key: {name:{en,zh,ja,zhCN}, icon, color, big?} },
 *     spots: [{t, x, y}] }  // t = types 的 key;約 3,868 點,前端用 canvas 圓點畫
 *
 * 用法:node scripts/fetch-map-ores.mjs
 */
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "packages/web/public/game-data");
const UA = "palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)";

// map_data 的 type → 輸出 key / items.json id / 圓點顏色(白邊圓點,深淺對比即可)
const TYPES = {
  "Ore": { key: "ore", item: "CopperOre", color: "#b87333" },
  "Ore Cluster": { key: "oreL", item: "CopperOre", color: "#b87333", big: true },
  "Coal": { key: "coal", item: "Coal", color: "#4b4b4b" },
  "Coal Cluster": { key: "coalL", item: "Coal", color: "#4b4b4b", big: true },
  "Sulfur": { key: "sulfur", item: "Sulfur", color: "#e6c229" },
  "Sulfur Cluster": { key: "sulfurL", item: "Sulfur", color: "#e6c229", big: true },
  "Pure Quartz": { key: "quartz", item: "Quartz", color: "#9ad7f0" },
  "Pure Quartz Cluster": { key: "quartzL", item: "Quartz", color: "#9ad7f0", big: true },
  "Chromite": { key: "chromite", item: "Chromium", color: "#a26bd4" },
  "Hexolite Quartz": { key: "hexolite", item: "RainbowCrystal", color: "#e05aa0" },
  "Soralite": { key: "soralite", item: "SkyIslandOre", color: "#ff8c42" },
  "Crude Oil": { key: "oil", item: "CrudeOil", color: "#2f2f6e" },
};
const BIG_SUFFIX = { en: " (Cluster)", zh: "(大型)", ja: "(大型)", zhCN: "(大型)" };

// map_data_en.js 是 JS 檔不是 JSON:用括號平衡掃描把 `var <name> = [...]` 抓成 JSON。
function grabVar(src, name) {
  const at = src.indexOf(`var ${name} = `);
  if (at < 0) throw new Error(`map_data 裡找不到 var ${name}`);
  let j = src.indexOf("=", at) + 1;
  while (src[j] === " " || src[j] === "\n") j++;
  const open = src[j];
  const close = { "{": "}", "[": "]" }[open];
  let depth = 0, k = j, inStr = false, esc = false;
  for (;;) {
    const c = src[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    k++;
  }
  return JSON.parse(src.slice(j, k + 1));
}

const res = await fetch("https://paldb.cc/js/map_data_en.js", { headers: { "User-Agent": UA } });
if (!res.ok) throw new Error(`map_data_en.js -> HTTP ${res.status}`);
const markers = grabVar(await res.text(), "fixedDungeon");

const items = JSON.parse(await readFile(path.join(DATA_DIR, "items.json"), "utf8"));
const byId = new Map(items.map((i) => [i.id, i]));

const types = {};
for (const [, def] of Object.entries(TYPES)) {
  const it = byId.get(def.item);
  if (!it) throw new Error(`items.json 裡找不到 ${def.item}`);
  const name = { en: it.name, zh: it.zh, ja: it.ja, zhCN: it.zhCN };
  if (def.big) for (const l of Object.keys(name)) name[l] = (name[l] ?? it.name) + BIG_SUFFIX[l];
  types[def.key] = { name, icon: it.icon, color: def.color, ...(def.big ? { big: true } : {}) };
}

const spots = markers
  .filter((m) => TYPES[m.type] && m.ipos)
  .map((m) => ({ t: TYPES[m.type].key, x: Math.round(m.ipos.X), y: Math.round(m.ipos.Y) }));
if (spots.length < 3000) throw new Error(`礦點只剩 ${spots.length} 筆,來源格式可能變了`);

const out = path.join(DATA_DIR, "ores.json");
await writeFile(out, JSON.stringify({ types, spots }));
const perType = spots.reduce((a, s) => ((a[s.t] = (a[s.t] ?? 0) + 1), a), {});
console.log(`ores.json 已更新:${spots.length} 點`, perType);
