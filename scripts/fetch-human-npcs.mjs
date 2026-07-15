#!/usr/bin/env node
/**
 * 抓「人類 NPC 目錄」,給玩家詳情頁標示存檔裡用帕魯球抓到的人類角色(CharacterID 例:
 * Hunter_Bat、Male_People02、Female_Soldier01 等)用。含 zh(繁中)/ja(日文)/zhCN(簡中)名稱。
 *
 * 資料來源(維護者為貢獻者,已獲同意;見 public/game-data/CREDITS.md):
 *  - paldb.cc 把所有「非怕魯」角色(人類 NPC、競技場角色、部分測試/佔位資料)歸在
 *    `/{lang}/Humans` 這個索引頁,結構與 Items/Pals 索引頁相同:
 *    `<a class="itemname" data-hover="?s=Pals%2F<內部id>">顯示名稱</a>`
 *    (namespace 仍是 `Pals`,paldb 沒有另開 Humans namespace)。
 *    圖示:同一張卡片裡 `<a class="" data-hover="?s=Pals%2F<id>"><img src="<iconUrl>">`。
 *  - en/tw/ja/cn 四個語言版本用同一個內部 id 直接對接(可靠,不必位置對應)。
 *  - 部分條目(多為 Arena_*、Legend_*、測試用 id)paldb 沒有專屬圖示,共用一張
 *    `T_character_common_human_00.webp` 通用佔位圖——這種視同「沒有圖示」,icon 留空,
 *    交給前端的通用人形 fallback,不下載佔位圖(避免灌一堆同名假圖進 repo)。
 *
 * 產出:packages/web/public/game-data/humans.json  [{id,name,icon?,zh?,ja?,zhCN?}]
 *      圖示存 packages/web/public/game-data/humans/
 *
 * 用法:node scripts/fetch-human-npcs.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "packages/web/public/game-data");
const ICON_DIR = path.join(DATA_DIR, "humans");
const UA = "palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)";
const PLACEHOLDER_ICON = "T_character_common_human_00.webp";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function getSequential(urls) {
  const out = [];
  for (const url of urls) {
    if (out.length > 0) await sleep(400);
    out.push(await get(url));
  }
  return out;
}

/** 人類 NPC 名稱:paldb.cc/{lang}/Humans 索引頁,`?s=Pals%2F<id>` anchor -> 顯示名稱。 */
function parseNames(html) {
  const names = new Map();
  const re = /class="itemname" data-hover="\?s=Pals%2F([^"]+)"[^>]*>([^<]*)<\/a>/g;
  for (const [, rawId, rawName] of html.matchAll(re)) {
    const id = decodeURIComponent(rawId);
    const name = rawName.trim();
    if (name && !names.has(id)) names.set(id, name);
  }
  return names;
}

/** 人類 NPC 圖示:同索引頁,無 class 的卡片頭像 anchor -> icon URL。 */
function parseIcons(html) {
  const icons = new Map();
  const re = /<a class="" data-hover="\?s=Pals%2F([^"]+)"[^>]*><img loading="lazy" src="([^"]+)"/g;
  for (const [, rawId, url] of html.matchAll(re)) {
    const id = decodeURIComponent(rawId);
    if (!icons.has(id)) icons.set(id, url);
  }
  return icons;
}

async function downloadIcon(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return false;
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function main() {
  await mkdir(ICON_DIR, { recursive: true });

  const [enHtml, twHtml, jaHtml, cnHtml] = await getSequential([
    "https://paldb.cc/en/Humans",
    "https://paldb.cc/tw/Humans",
    "https://paldb.cc/ja/Humans",
    "https://paldb.cc/cn/Humans",
  ]);

  const namesEn = parseNames(enHtml);
  const namesZh = parseNames(twHtml);
  const namesJa = parseNames(jaHtml);
  const namesCn = parseNames(cnHtml);
  const icons = parseIcons(enHtml);

  const humans = [];
  for (const [id, name] of namesEn) {
    const zh = namesZh.get(id);
    const ja = namesJa.get(id);
    const zhCN = namesCn.get(id);
    const iconUrl = icons.get(id);
    const iconBasename =
      iconUrl && !iconUrl.endsWith(PLACEHOLDER_ICON) ? path.basename(iconUrl) : undefined;
    humans.push({
      id,
      name,
      ...(iconBasename ? { icon: iconBasename } : {}),
      ...(zh ? { zh } : {}),
      ...(ja ? { ja } : {}),
      ...(zhCN ? { zhCN } : {}),
      _iconUrl: iconBasename ? iconUrl : undefined,
    });
  }
  humans.sort((a, b) => a.id.localeCompare(b.id));

  // ── 下載圖示(同一張圖被多個 id 共用時只下載一次) ──
  const uniqueIconUrls = new Map(); // basename -> url
  for (const h of humans) {
    if (h.icon && !uniqueIconUrls.has(h.icon)) uniqueIconUrls.set(h.icon, h._iconUrl);
  }
  let downloaded = 0;
  const failedBasenames = new Set();
  let attempted = 0;
  for (const [basename, url] of uniqueIconUrls) {
    if (attempted > 0) await sleep(150);
    attempted++;
    const ok = await downloadIcon(url, path.join(ICON_DIR, basename)).catch(() => false);
    if (ok) downloaded++;
    else failedBasenames.add(basename);
  }

  // 下載失敗的圖示,拿掉該筆 icon 欄,避免破圖(比照 merge-new-catalog-entries.mjs 的作法)。
  // 重建物件維持固定欄位順序 id, name, icon, zh, ja, zhCN(方便 diff)。
  const finalHumans = humans.map(({ id, name, icon, zh, ja, zhCN }) => ({
    id,
    name,
    ...(icon && !failedBasenames.has(icon) ? { icon } : {}),
    ...(zh ? { zh } : {}),
    ...(ja ? { ja } : {}),
    ...(zhCN ? { zhCN } : {}),
  }));

  await writeFile(path.join(DATA_DIR, "humans.json"), JSON.stringify(finalHumans) + "\n");

  // ── 統計 ──
  const zhCount = finalHumans.filter((h) => h.zh).length;
  const jaCount = finalHumans.filter((h) => h.ja).length;
  const zhCNCount = finalHumans.filter((h) => h.zhCN).length;
  const iconCount = finalHumans.filter((h) => h.icon).length;
  console.log(
    `humans.json: ${finalHumans.length} 筆(icon ${iconCount};zh ${zhCount};ja ${jaCount};zhCN ${zhCNCount})`,
  );
  console.log(
    `圖示下載:${downloaded} 張成功、${failedBasenames.size} 張失敗(共 ${uniqueIconUrls.size} 張不重複圖)`,
  );
}

await main();
