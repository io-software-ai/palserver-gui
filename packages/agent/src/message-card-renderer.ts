import fs from "node:fs";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { MessageBridgeLanguage } from "@palserver/shared";

const BG = "#232030";
const CARD = "#2d2a3b";
const CARD_SOFT = "#363347";
const INK = "#eceaf2";
const MUTED = "#a9a5bb";
const PAL = "#5bb8ec";
const PAL_STRONG = "#7ec8f0";
const LINE = "#403c52";
const BERRY = "#ef6a6a";
const SUN = "#f2b64f";
const GRASS = "#58ba64";

const MAX_DIMENSION = 8000;
const MAX_DIMENSION_SUM = 9400;
const GENERIC_WIDTH = 1080;
const CARD_WIDTH = 420;
const PAL_CARD_HEIGHT = 174;
const ITEM_CARD_HEIGHT = 132;
const GRID_GAP = 16;
const OUTER_PADDING = 36;
const FONT_FAMILY = "Palserver Bridge Rounded";

interface CatalogRecord {
  id?: string;
  name?: string;
  icon?: string;
  zh?: string;
  "zh-CN"?: string;
  zhCN?: string;
  ja?: string;
}

interface PalRow {
  name: string;
  level: number;
  gender: string;
  rank: number;
  boss: boolean;
  ivs: Array<[string, string]>;
  passives: string[];
  section: string;
  icon?: string;
}

interface ItemRow {
  name: string;
  count: number;
  section: string;
  icon?: string;
}

type CardIcon = "box" | "crown" | "gear" | "grid" | "heart" | "shield" | "sparkle" | "sword";

let wasmInitialization: Promise<void> | null = null;
const fontCache = new Map<string, Uint8Array[]>();
const dataUriCache = new Map<string, string>();

function gameDataDir(): string | undefined {
  const installDir = path.dirname(process.execPath);
  const candidates = [
    process.env.PALSERVER_WEB_DIR ? path.join(process.env.PALSERVER_WEB_DIR, "game-data") : "",
    path.join(installDir, "web", "game-data"),
    path.resolve(process.cwd(), "packages", "web", "dist", "game-data"),
    path.resolve(process.cwd(), "packages", "web", "public", "game-data"),
    path.resolve(process.cwd(), "..", "web", "public", "game-data"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "pals.json")));
}

function rendererDir(gameData: string): string {
  const candidates = [
    path.join(path.dirname(gameData), ".bridge-card-renderer"),
    process.env.PALSERVER_WEB_DIR ? path.join(process.env.PALSERVER_WEB_DIR, ".bridge-card-renderer") : "",
    path.join(path.dirname(process.execPath), "web", ".bridge-card-renderer"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "resvg.wasm")));
  if (!found) throw new Error("找不到群服互通图片渲染资源，请重新构建 Web 资源");
  return found;
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeName(value: string): string {
  return value.replace(/[\s·・'’\-_.]+/gu, "").toLocaleLowerCase();
}

function approximateTextWidth(value: string, size: number): number {
  let units = 0;
  for (const character of value) {
    if (/\s/u.test(character)) units += 0.32;
    else if (/^[\x00-\x7F]$/u.test(character)) units += 0.58;
    else units += 1;
  }
  return units * size;
}

function fitText(value: string, size: number, maxWidth: number): string {
  if (approximateTextWidth(value, size) <= maxWidth) return value;
  let result = "";
  for (const character of value) {
    if (approximateTextWidth(`${result}${character}…`, size) > maxWidth) break;
    result += character;
  }
  return `${result}…`;
}

function text(
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  options: { bold?: boolean; maxWidth?: number; anchor?: "start" | "middle" } = {},
): string {
  const content = options.maxWidth ? fitText(value, size, options.maxWidth) : value;
  const bold = options.bold ? ` font-weight="600"` : "";
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${options.anchor ?? "start"}" dominant-baseline="hanging"${bold}>${escapeXml(content)}</text>`;
}

function dataUri(file: string | undefined): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  const cached = dataUriCache.get(file);
  if (cached) return cached;
  const extension = path.extname(file).toLowerCase();
  const type = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  const value = `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
  dataUriCache.set(file, value);
  return value;
}

function imageTile(file: string | undefined, x: number, y: number, size: number, id: string): string {
  const href = dataUri(file);
  return [
    `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="14"/></clipPath></defs>`,
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="14" fill="${CARD_SOFT}"/>`,
    href ? `<image href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${id})"/>` : "",
  ].join("");
}

function cardIcon(name: CardIcon, x: number, y: number, size: number, color: string): string {
  const scale = size / 24;
  const transform = `translate(${x} ${y}) scale(${scale})`;
  const common = `fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
  const shapes: Record<CardIcon, string> = {
    box: `<path d="M4 8l8-4 8 4-8 4-8-4zm0 0v9l8 4 8-4V8M12 12v9" ${common}/>`,
    crown: `<path d="M3 7l4.5 5L12 5l4.5 7L21 7l-2 11H5L3 7zm3 15h12" ${common}/>`,
    gear: `<circle cx="12" cy="12" r="3.2" ${common}/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9L7 7m10 10 2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" ${common}/>`,
    grid: `<rect x="3" y="3" width="18" height="18" rx="3" ${common}/><path d="M9 3v18m6-18v18M3 9h18M3 15h18" ${common}/>`,
    heart: `<path d="M20.8 5.8c-2.1-2.2-5.5-2-7.4.3L12 7.7l-1.4-1.6C8.7 3.8 5.3 3.6 3.2 5.8 1 8.1 1.2 11.7 3.6 14L12 22l8.4-8c2.4-2.3 2.6-5.9.4-8.2z" fill="${color}"/>`,
    shield: `<path d="M12 2l8 3v6c0 5.2-3.4 9.1-8 11-4.6-1.9-8-5.8-8-11V5l8-3z" ${common}/>`,
    sparkle: `<path d="M12 2c.7 5.7 4.3 9.3 10 10-5.7.7-9.3 4.3-10 10-.7-5.7-4.3-9.3-10-10 5.7-.7 9.3-4.3 10-10z" fill="${color}"/>`,
    sword: `<path d="M5 20l4-4m-2 6-5-5m7-1L20 5l-1-3-3-1L5 12l4 4z" ${common}/>`,
  };
  return `<g transform="${transform}">${shapes[name]}</g>`;
}

function iconBadge(icon: CardIcon, label: string, x: number, y: number, size: number, color: string, background = CARD_SOFT): { svg: string; width: number } {
  const iconSize = size + 2;
  const width = Math.ceil(approximateTextWidth(label, size) + iconSize + 27);
  const height = Math.max(28, size + 10);
  return {
    width,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${background}"/>${cardIcon(icon, x + 9, y + (height - iconSize) / 2, iconSize, color)}${text(label, x + iconSize + 15, y + 4, size, color, { bold: true })}`,
  };
}

function loadCatalog(gameData: string, file: "pals" | "items"): Map<string, string | undefined> {
  let records: CatalogRecord[] = [];
  try { records = JSON.parse(fs.readFileSync(path.join(gameData, `${file}.json`), "utf8")) as CatalogRecord[]; }
  catch { return new Map(); }
  const result = new Map<string, string | undefined>();
  for (const record of records) {
    const icon = record.icon ? path.join(rendererDir(gameData), "icons", file, `${path.parse(record.icon).name}.png`) : undefined;
    for (const key of ["id", "name", "zh", "zh-CN", "zhCN", "ja"] as const) {
      const value = record[key];
      if (value && value !== "-") result.set(normalizeName(value), icon && fs.existsSync(icon) ? icon : undefined);
    }
  }
  return result;
}

function parsePassives(value: string): string[] {
  const content = value.match(/\[([^\]]*)\]/u)?.[1]?.trim();
  if (!content || ["无词条", "無詞條", "No passives", "パッシブなし"].includes(content)) return [];
  return content.split("|").map((part) => part.trim()).filter(Boolean);
}

function parseIvs(value: string): Array<[string, string]> {
  const content = value.match(/IVs\(([^)]*)\)/u)?.[1];
  if (!content) return [];
  return content.split("|").flatMap((part) => {
    const match = part.trim().match(/^(.+?)(\d+)$/u);
    return match ? [[match[1], match[2]] as [string, string]] : [];
  });
}

function parsePalReply(source: string, catalog: Map<string, string | undefined>): { title: string; rows: PalRow[] } | undefined {
  const lines = source.replaceAll("\r", "").split("\n");
  const title = lines.find((line) => line.trim())?.trim() || "Pal Collection";
  const rows: PalRow[] = [];
  let section = "";
  const pattern = /^-\s+(.+?)\s+Lv\.(\d+)(?:\s+\(([♂♀])\))?(?:\s+-\s+(.*))?$/u;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    if (current.startsWith("【") && current.endsWith("】")) { section = current; continue; }
    const match = current.match(pattern);
    if (!match) continue;
    const [, rawName, level, gender = "", details = ""] = match;
    const rank = rawName.match(/^★*/u)?.[0].length ?? 0;
    const boss = /\(BOSS\)/iu.test(rawName);
    const name = rawName.replace(/^★+/u, "").replace(/\(BOSS\)/giu, "").trim();
    let passives = parsePassives(details);
    if (lines[index + 1] && /\[[^\]]*\]/u.test(lines[index + 1])) {
      const nextPassives = parsePassives(lines[index + 1]);
      if (nextPassives.length) passives = nextPassives;
      index += 1;
    }
    const species = name.split("·").at(-1)?.trim() || name;
    rows.push({ name, level: Number(level), gender, rank, boss, ivs: parseIvs(details), passives, section, icon: catalog.get(normalizeName(species)) });
  }
  return rows.length ? { title, rows } : undefined;
}

function parseInventoryReply(source: string, catalog: Map<string, string | undefined>): { title: string; rows: ItemRow[] } | undefined {
  const lines = source.replaceAll("\r", "").split("\n");
  const title = lines.find((line) => line.trim())?.trim() || "Inventory";
  const rows: ItemRow[] = [];
  let section = "";
  for (const line of lines) {
    const current = line.trim();
    if (current.startsWith("【") && current.endsWith("】")) { section = current; continue; }
    const match = current.match(/^-\s+(.+?)\s+[×xX]\s*(\d+)$/u);
    if (!match) continue;
    rows.push({ name: match[1], count: Number(match[2]), section, icon: catalog.get(normalizeName(match[1])) });
  }
  return rows.length ? { title, rows } : undefined;
}

function columnsFor(count: number): number {
  return Math.max(3, Math.min(9, Math.ceil(count / 65)));
}

function grouped<T extends { section: string }>(rows: T[]): Array<[string, T[]]> {
  const groups: Array<[string, T[]]> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.[0] === row.section) last[1].push(row);
    else groups.push([row.section, [row]]);
  }
  return groups;
}

function sectionLabel(value: string): string {
  return value.replace(/^[【\s]+|[】\s]+$/gu, "");
}

function header(width: number, title: string, logo: string | undefined): string {
  return [
    `<rect x="${OUTER_PADDING}" y="${OUTER_PADDING}" width="${width - OUTER_PADDING * 2}" height="82" rx="18" fill="${CARD}" stroke="${LINE}" stroke-width="3"/>`,
    imageTile(logo, OUTER_PADDING + 22, OUTER_PADDING + 21, 40, "brand-logo"),
    text("palserver GUI", OUTER_PADDING + 78, OUTER_PADDING + 19, 29, INK, { bold: true }),
    text(title.replace(/^\[\s*|\s*\]$/gu, ""), OUTER_PADDING, OUTER_PADDING + 122, 34, INK, { bold: true, maxWidth: width - OUTER_PADDING * 2 }),
  ].join("");
}

function palCard(row: PalRow, x: number, y: number, id: number): string {
  const parts = [`<rect x="${x}" y="${y}" width="${CARD_WIDTH}" height="${PAL_CARD_HEIGHT}" rx="18" fill="${CARD}" stroke="${LINE}" stroke-width="3"/>`];
  parts.push(imageTile(row.icon, x + 16, y + 18, 104, `pal-${id}`));
  const textX = x + 136;
  parts.push(text(row.name, textX, y + 14, 25, INK, { bold: true, maxWidth: CARD_WIDTH - 152 }));
  parts.push(text(`Lv.${row.level}`, textX, y + 52, 21, MUTED, { bold: true }));
  let cursor = textX + approximateTextWidth(`Lv.${row.level}`, 21) + 10;
  if (row.gender) {
    parts.push(text(row.gender, cursor, y + 50, 24, row.gender === "♂" ? PAL : BERRY, { bold: true }));
    cursor += 30;
  }
  if (row.rank) parts.push(text("★".repeat(row.rank), cursor, y + 52, 20, SUN, { bold: true }));

  cursor = textX;
  const badgeY = y + 84;
  if (row.boss) {
    const boss = iconBadge("crown", "BOSS", cursor, badgeY, 15, BERRY, "#4b303d");
    parts.push(boss.svg);
    cursor += boss.width + 7;
  }
  const icons: Array<[string, CardIcon, string]> = [["心", "heart", BERRY], ["HP", "heart", BERRY], ["攻", "sword", SUN], ["ATK", "sword", SUN], ["防", "shield", PAL], ["DEF", "shield", PAL], ["工速", "gear", GRASS], ["Work", "gear", GRASS]];
  for (const [stat, value] of row.ivs) {
    const found = icons.find(([prefix]) => stat.startsWith(prefix));
    const item = iconBadge(found?.[1] ?? "shield", value, cursor, badgeY, 14, found?.[2] ?? MUTED);
    if (cursor + item.width > x + CARD_WIDTH - 12) break;
    parts.push(item.svg);
    cursor += item.width + 6;
  }
  if (row.passives.length) {
    parts.push(cardIcon("sparkle", textX, y + 126, 16, PAL_STRONG));
    parts.push(text(row.passives.join(" · "), textX + 22, y + 126, 15, PAL_STRONG, { maxWidth: CARD_WIDTH - 174 }));
  }
  return parts.join("");
}

function itemCard(row: ItemRow, x: number, y: number, id: number): string {
  const count = iconBadge("box", `×${row.count}`, x + 124, y + 70, 17, PAL_STRONG);
  return [
    `<rect x="${x}" y="${y}" width="${CARD_WIDTH}" height="${ITEM_CARD_HEIGHT}" rx="18" fill="${CARD}" stroke="${LINE}" stroke-width="3"/>`,
    imageTile(row.icon, x + 16, y + 20, 92, `item-${id}`),
    text(row.name, x + 124, y + 20, 24, INK, { bold: true, maxWidth: CARD_WIDTH - 144 }),
    count.svg,
  ].join("");
}

function svgDocument(width: number, height: number, content: string): string {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height), MAX_DIMENSION_SUM / (width + height));
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}" text-rendering="optimizeLegibility"><rect width="${width}" height="${height}" fill="${BG}"/>${content}</svg>`;
}

function collectionSvg<T extends { section: string }>(
  titleValue: string,
  rows: T[],
  logo: string | undefined,
  cardHeight: number,
  fallbackSection: string,
  renderCard: (row: T, x: number, y: number, id: number) => string,
): string {
  const columns = columnsFor(rows.length);
  const width = OUTER_PADDING * 2 + columns * CARD_WIDTH + (columns - 1) * GRID_GAP;
  const groups = grouped(rows);
  let height = OUTER_PADDING + 122 + 72 + OUTER_PADDING;
  for (const [, entries] of groups) height += 54 + Math.ceil(entries.length / columns) * (cardHeight + GRID_GAP);
  const parts = [header(width, titleValue, logo)];
  let y = OUTER_PADDING + 122 + 72;
  let id = 0;
  for (const [section, entries] of groups) {
    const label = sectionLabel(section) || fallbackSection;
    parts.push(`<rect x="${OUTER_PADDING}" y="${y}" width="${width - OUTER_PADDING * 2}" height="38" rx="12" fill="${CARD_SOFT}"/>`);
    parts.push(cardIcon("grid", OUTER_PADDING + 16, y + 7, 24, PAL_STRONG));
    parts.push(text(label, OUTER_PADDING + 50, y + 4, 22, PAL_STRONG, { bold: true }));
    y += 54;
    entries.forEach((row, index) => {
      const column = index % columns;
      const rowIndex = Math.floor(index / columns);
      parts.push(renderCard(row, OUTER_PADDING + column * (CARD_WIDTH + GRID_GAP), y + rowIndex * (cardHeight + GRID_GAP), id++));
    });
    y += Math.ceil(entries.length / columns) * (cardHeight + GRID_GAP);
  }
  return svgDocument(width, height, parts.join(""));
}

function wrapText(value: string, size: number, maxWidth: number): string[] {
  const result: string[] = [];
  let line = "";
  for (const character of value) {
    if (line && approximateTextWidth(`${line}${character}`, size) > maxWidth) {
      result.push(line);
      line = character.trimStart();
    } else line += character;
  }
  if (line || !result.length) result.push(line);
  return result;
}

function genericSvg(source: string, logo: string | undefined): string {
  const contentWidth = GENERIC_WIDTH - 156;
  const rendered: Array<{ value?: string; size: number; color: string; bold: boolean; gap: number }> = [];
  let first = true;
  for (const raw of source.replaceAll("\r", "").split("\n")) {
    if (!raw.trim()) { rendered.push({ size: 0, color: INK, bold: false, gap: 18 }); continue; }
    const bracketHeader = (raw.trim().startsWith("【") && raw.trim().endsWith("】")) || (raw.trim().startsWith("[") && raw.trim().endsWith("]") && !raw.trim().startsWith("[-]"));
    const size = first ? 34 : bracketHeader ? 28 : 25;
    const color = first || bracketHeader ? PAL_STRONG : INK;
    const bold = first || bracketHeader;
    const gap = first ? 18 : bracketHeader ? 14 : 8;
    for (const line of wrapText(raw, size, contentWidth)) rendered.push({ value: line, size, color, bold, gap });
    first = false;
  }
  const contentHeight = rendered.reduce((total, line) => total + (line.value ? line.size + 8 + line.gap : line.gap), 0);
  const height = 136 + contentHeight + 118;
  const parts = [
    `<rect x="30" y="30" width="${GENERIC_WIDTH - 60}" height="${height - 60}" rx="18" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>`,
    `<line x1="30" y1="118" x2="${GENERIC_WIDTH - 30}" y2="118" stroke="${LINE}" stroke-width="2"/>`,
    imageTile(logo, 78, 57, 36, "brand-logo"),
    text("palserver GUI", 128, 54, 27, INK, { bold: true }),
  ];
  let y = 152;
  for (const line of rendered) {
    if (!line.value) { y += line.gap; continue; }
    parts.push(text(line.value, 78, y, line.size, line.color, { bold: line.bold }));
    y += line.size + 8 + line.gap;
  }
  return svgDocument(GENERIC_WIDTH, height, parts.join(""));
}

async function renderPng(svg: string, resources: string): Promise<Buffer> {
  if (!wasmInitialization) {
    wasmInitialization = initWasm(fs.readFileSync(path.join(resources, "resvg.wasm"))).catch((error) => {
      wasmInitialization = null;
      throw error;
    });
  }
  await wasmInitialization;
  let fonts = fontCache.get(resources);
  if (!fonts) {
    const fontDir = path.join(resources, "fonts");
    fonts = fs.readdirSync(fontDir).filter((name) => name.endsWith(".woff2")).map((name) => fs.readFileSync(path.join(fontDir, name)));
    fontCache.set(resources, fonts);
  }
  const renderer = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: FONT_FAMILY }, textRendering: 1, imageRendering: 0 });
  try { return Buffer.from(renderer.render().asPng()); }
  finally { renderer.free(); }
}

export async function renderMessageBridgeCards(pages: readonly string[], _language: MessageBridgeLanguage): Promise<Buffer[]> {
  if (!pages.length) throw new Error("没有可渲染的群消息内容");
  const gameData = gameDataDir();
  if (!gameData) throw new Error("找不到群服互通游戏资源");
  const resources = rendererDir(gameData);
  const source = pages.join("\n\n");
  const logo = path.join(path.dirname(gameData), "logo.png");
  const pals = parsePalReply(source, loadCatalog(gameData, "pals"));
  const inventory = pals ? undefined : parseInventoryReply(source, loadCatalog(gameData, "items"));
  const svg = pals
    ? collectionSvg(pals.title, pals.rows, logo, PAL_CARD_HEIGHT, "Pals", palCard)
    : inventory
      ? collectionSvg(inventory.title, inventory.rows, logo, ITEM_CARD_HEIGHT, "Items", itemCard)
      : genericSvg(source, logo);
  return [await renderPng(svg, resources)];
}
