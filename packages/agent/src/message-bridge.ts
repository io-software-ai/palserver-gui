import fs from "node:fs";
import https from "node:https";
import type { Agent as HttpAgent } from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { localizePalName } from "@palserver/shared";
import type { KnownPlayer, MessageBridgeChannelConfig, MessageBridgeChannelPatch, MessageBridgeConfig, MessageBridgeLanguage, MessageBridgePatch, MessageBridgePlatform, MessageBridgeRules, MessageBridgeStatus, PdItemSlot, PdPal, PdPalIvs, SavePalRow, SavePlayerInventory, SavePlayerProfile } from "@palserver/shared";
import type { ServerDriver } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import type { PresenceTracker } from "./presence.js";
import { getLiveStatus, rest } from "./restapi.js";
import { getPlayerDetail } from "./paldefender-rest.js";
import { rconExec } from "./rcon.js";
import { localizeItem, localizePassive, t } from "./i18n.js";
import { activeWorldGuidAsync } from "./saves.js";
import { getPlayerProfile, getPlayersSummary } from "./save-tools.js";
import { renderMessageBridgeCards } from "./message-card-renderer.js";

const API_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 5_000;

type StoredChannelBase = MessageBridgeRules & { id: string; platform: MessageBridgePlatform; enabled: boolean; adminIds: string[]; language: MessageBridgeLanguage };
type StoredOneBotChannel = StoredChannelBase & { platform: "onebot"; wsUrl: string; groupId: string; accessToken: string };
type StoredDiscordChannel = StoredChannelBase & { platform: "discord"; channelId: string; proxyEnabled: boolean; proxyUrl: string; token: string };
type StoredTelegramChannel = StoredChannelBase & { platform: "telegram"; chatId: string; token: string };
type StoredWebhookChannel = StoredChannelBase & { platform: "webhook"; url: string; secret: string };
type StoredBridgeChannel = StoredOneBotChannel | StoredDiscordChannel | StoredTelegramChannel | StoredWebhookChannel;
interface StoredBridgeConfig { channels: StoredBridgeChannel[] }

type LegacyChannel = Partial<MessageBridgeRules> & {
  added?: boolean; enabled?: boolean; wsUrl?: string; groupId?: string; accessToken?: string;
  channelId?: string; proxyEnabled?: boolean; proxyUrl?: string; token?: string;
  chatId?: string; url?: string; secret?: string; adminIds?: string[]; language?: MessageBridgeLanguage;
};
type LegacyBridgeConfig = Partial<Record<MessageBridgePlatform, LegacyChannel>> & Partial<MessageBridgeRules> & { enabled?: boolean; channels?: unknown };

interface IncomingMessage { channelId: string; platform: MessageBridgePlatform; userId: string; author: string; text: string }
type AdapterIncomingMessage = Omit<IncomingMessage, "channelId">;
interface QueryReplyOptions { nextCommand: string; requestedPage: number }
interface Adapter {
  id: string;
  platform: MessageBridgePlatform;
  language: MessageBridgeLanguage;
  start(): void;
  stop(): void;
  send(text: string): Promise<void>;
  sendCommandReply(text: string, options?: QueryReplyOptions): Promise<void>;
}
interface Runtime {
  config: StoredBridgeConfig;
  adapters: Adapter[];
  stopLog: (() => void) | null;
  logRetry: NodeJS.Timeout | null;
  attachingLog: boolean;
  seenLines: Set<string>;
  lastPresenceKey: string;
}

const defaultRules = (): MessageBridgeRules => ({
  relayGroupToGame: true,
  relayGameToGroup: true,
  notifyJoinLeave: true,
  notifyCapture: true,
  notifyDeath: true,
  relayPrefix: "",
  commandPrefix: "/",
});

const defaults = (): StoredBridgeConfig => ({ channels: [] });

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, max);
}

function cleanAdminIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => cleanText(id, 128)).filter(Boolean))].slice(0, 50);
}

function cleanLanguage(value: unknown): MessageBridgeLanguage {
  return value === "zh-TW" || value === "en" || value === "ja" ? value : "zh-CN";
}

export function resolveMessageBridgeRules(channel: Partial<MessageBridgeRules> | undefined, legacy: Partial<MessageBridgeRules> | undefined): MessageBridgeRules {
  const fallback = defaultRules();
  return {
    relayGroupToGame: channel?.relayGroupToGame ?? legacy?.relayGroupToGame ?? fallback.relayGroupToGame,
    relayGameToGroup: channel?.relayGameToGroup ?? legacy?.relayGameToGroup ?? fallback.relayGameToGroup,
    notifyJoinLeave: channel?.notifyJoinLeave ?? legacy?.notifyJoinLeave ?? fallback.notifyJoinLeave,
    notifyCapture: channel?.notifyCapture ?? legacy?.notifyCapture ?? fallback.notifyCapture,
    notifyDeath: channel?.notifyDeath ?? legacy?.notifyDeath ?? fallback.notifyDeath,
    relayPrefix: cleanText(channel?.relayPrefix ?? legacy?.relayPrefix ?? fallback.relayPrefix, 20),
    commandPrefix: cleanText(channel?.commandPrefix ?? legacy?.commandPrefix ?? fallback.commandPrefix, 3) || "/",
  };
}

function cleanChannelId(value: unknown, fallback: string): string {
  const id = cleanText(value, 64);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : fallback;
}

function normalizeStoredChannel(raw: LegacyChannel & { id?: string; platform?: MessageBridgePlatform }, platform: MessageBridgePlatform, fallbackId: string, legacy?: Partial<MessageBridgeRules>): StoredBridgeChannel {
  const common = {
    ...resolveMessageBridgeRules(raw, legacy),
    id: cleanChannelId(raw.id, fallbackId),
    platform,
    enabled: raw.enabled !== false,
    adminIds: cleanAdminIds(raw.adminIds),
    language: cleanLanguage(raw.language),
  };
  if (platform === "onebot") return { ...common, platform, wsUrl: cleanText(raw.wsUrl || "ws://127.0.0.1:3001", 500), groupId: cleanText(raw.groupId, 100), accessToken: cleanText(raw.accessToken, 2000) };
  if (platform === "discord") {
    const proxyEnabled = raw.proxyEnabled === true;
    return { ...common, platform, channelId: cleanText(raw.channelId, 100), proxyEnabled, proxyUrl: proxyEnabled && raw.proxyUrl ? normalizeDiscordProxyUrl(raw.proxyUrl) : cleanText(raw.proxyUrl, 1000), token: cleanText(raw.token, 2000) };
  }
  if (platform === "telegram") return { ...common, platform, chatId: cleanText(raw.chatId, 100), token: cleanText(raw.token, 2000) };
  return { ...common, platform, url: cleanText(raw.url, 1000), secret: cleanText(raw.secret, 2000) };
}

export function mergeStoredBridgeConfig(raw: LegacyBridgeConfig | null): StoredBridgeConfig {
  if (!raw || typeof raw !== "object") return defaults();
  const channels: StoredBridgeChannel[] = [];
  if (Array.isArray(raw.channels)) {
    for (const [index, value] of raw.channels.slice(0, 32).entries()) {
      if (!value || typeof value !== "object") continue;
      const channel = value as LegacyChannel & { id?: string; platform?: MessageBridgePlatform };
      if (!["onebot", "discord", "telegram", "webhook"].includes(channel.platform ?? "")) continue;
      channels.push(normalizeStoredChannel(channel, channel.platform!, `${channel.platform}-${index + 1}`));
    }
  } else {
    for (const platform of ["onebot", "discord", "telegram", "webhook"] as const) {
      const channel = raw[platform];
      if (!channel) continue;
      const added = channel.added ?? !!(channel.enabled || channel.groupId || channel.channelId || channel.chatId || channel.url || channel.accessToken || channel.token || channel.secret);
      if (!added) continue;
      channels.push(normalizeStoredChannel({ ...channel, enabled: raw.enabled === false ? false : channel.enabled }, platform, platform, raw));
    }
  }
  const seen = new Set<string>();
  return { channels: channels.filter((channel) => !seen.has(channel.id) && !!seen.add(channel.id)) };
}

export type ParsedGameEvent =
  | { type: "chat"; channel: string; author: string; text: string }
  | { type: "death"; player: string; cause?: string; killerPal?: string }
  | { type: "capture"; player: string; pal: string }
  | null;

export function parseGameLogLine(raw: string): ParsedGameEvent {
  const line = raw.replace(/[\r\n]+$/, "");
  let m: RegExpMatchArray | null;
  if ((m = line.match(/\[Chat::(\w+)\]\['([^']+)'[^\]]*\]:\s?(.*)$/)))
    return { type: "chat", channel: m[1], author: m[2], text: cleanText(m[3]) };
  if ((m = line.match(/'([^']+)'[^)]*\) was attacked by a wild '([^']+)'.*died/i)))
    return { type: "death", player: m[1], killerPal: m[2] };
  if ((m = line.match(/'([^']+)'[^)]*\) died to (.+?)\.?$/i)))
    return { type: "death", player: m[1], cause: cleanText(m[2]) };
  if ((m = line.match(/'([^']+)'[^)]*\) (?:was killed|and died\.)/i)))
    return { type: "death", player: m[1] };
  if ((m = line.match(/'([^']+)'[^)]*\) (?:has captured Pal|picked up Pal) '([^']+)'/i)))
    return { type: "capture", player: m[1], pal: m[2] };
  return null;
}

/** 所有 4 语言文案统一走 web/public/i18n/{lang}.json —— 单一来源,
 *  通过 ./i18n.ts 提供的 t(lang, key, vars?) 查询。key 一律是繁中(zh-TW)原文。 */

export function formatGameEvent(event: NonNullable<ParsedGameEvent>, language: MessageBridgeLanguage): string {
  if (event.type === "chat") return `[${t(language, "遊戲")}/${event.channel}] ${event.author}: ${event.text}`;
  if (event.type === "capture") return `● ${event.player} ${t(language, "捕捉了 {pal}", { pal: localizePalName(event.pal, language) })}`;
  if (event.killerPal) return `☠ ${event.player} ${t(language, "被野生 {pal} 擊殺", { pal: localizePalName(event.killerPal, language) })}`;
  return `☠ ${event.player} ${t(language, "死亡")}${event.cause ? `: ${event.cause}` : ""}`;
}

export function parseBridgeCommand(text: string, prefix: string): { name: string; args: string[] } | null {
  if (!text.startsWith(prefix)) return null;
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  return parts[0] ? { name: parts[0].toLowerCase(), args: parts.slice(1) } : null;
}

export function parseRelayMessage(text: string, prefix: string): string | null {
  if (!prefix) return text;
  if (!text.startsWith(prefix)) return null;
  return text.slice(prefix.length).trimStart() || null;
}

export function resolvePlayerIdentifier(identifier: string, players: readonly KnownPlayer[]): string {
  const normalized = identifier.trim().toLocaleLowerCase();
  const idMatch = players.find((player) => player.userId.toLocaleLowerCase() === normalized);
  if (idMatch) return idMatch.userId;
  const namesOf = (player: KnownPlayer) => [player.name, player.accountName].map((value) => value.toLocaleLowerCase()).filter(Boolean);
  for (const matches of [
    players.filter((player) => namesOf(player).some((value) => value === normalized)),
    players.filter((player) => namesOf(player).some((value) => value.startsWith(normalized))),
    players.filter((player) => namesOf(player).some((value) => value.includes(normalized))),
  ]) {
    if (matches.length === 1) return matches[0].userId;
  }
  return identifier;
}

type SavePlayerIdentity = Pick<SavePlayerProfile, "uid" | "name">;

/** Match a save player by UID or name. Fuzzy matches are accepted only when unique. */
export function resolveSavePlayer(identifiers: string | readonly string[], players: readonly SavePlayerIdentity[]): SavePlayerIdentity | null {
  const values = (typeof identifiers === "string" ? [identifiers] : identifiers)
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  const normalizedUid = (value: string) => value.replace(/-/g, "").toLocaleLowerCase();
  for (const value of values) {
    const uid = normalizedUid(value);
    const exact = players.filter((player) => normalizedUid(player.uid) === uid || player.name.toLocaleLowerCase() === value);
    if (exact.length === 1) return exact[0];
  }
  for (const value of values) {
    for (const matches of [
      players.filter((player) => player.name.toLocaleLowerCase().startsWith(value)),
      players.filter((player) => player.name.toLocaleLowerCase().includes(value)),
    ]) {
      if (matches.length === 1) return matches[0];
    }
  }
  return null;
}

export function savePalToPdPal(pal: SavePalRow): PdPal {
  return {
    instanceId: pal.instanceId,
    palId: pal.characterId,
    nickname: pal.nickname ?? "",
    gender: pal.gender === "male" ? "Male" : pal.gender === "female" ? "Female" : "",
    level: pal.level ?? 0,
    shiny: pal.isLucky,
    location: pal.location === "party" ? "team" : pal.location === "palbox" ? "palbox" : "basecamp",
    ivs: {
      hp: pal.talentHp ?? undefined,
      attack: pal.talentShot ?? undefined,
      defense: pal.talentDefense ?? undefined,
    },
    passives: pal.passives,
    rank: Math.max(0, pal.rank - 1),
    isBoss: pal.isBoss,
  };
}

export function saveInventoryToPdItems(inventory: SavePlayerInventory): PdItemSlot[] {
  const containers: ReadonlyArray<[keyof Omit<SavePlayerInventory, "money">, string]> = [
    ["common", "Items"],
    ["essential", "KeyItems"],
    ["weapons", "Weapons"],
    ["armor", "Armor"],
    ["food", "Food"],
  ];
  const items = containers.flatMap(([key, container]) => inventory[key].map((item) => ({ ...item, container })));
  if (inventory.money > 0) items.push({ itemId: "Money", count: inventory.money, container: "Items" });
  return items;
}

export function paginateBridgeReply(text: string, maxLength: number): string[] {
  if (maxLength < 1) throw new Error("maxLength must be positive");
  if (text.length <= maxLength) return [text];
  const pages: string[] = [];
  let current = "";
  const flush = () => {
    if (current) pages.push(current);
    current = "";
  };
  const append = (value: string, separator: string) => {
    const addition = current ? `${separator}${value}` : value;
    if (current && current.length + addition.length > maxLength) flush();
    if (value.length <= maxLength) {
      current = current ? `${current}${separator}${value}` : value;
      return;
    }
    flush();
    const characters = Array.from(value);
    while (characters.length > maxLength) pages.push(characters.splice(0, maxLength).join(""));
    current = characters.join("");
  };
  for (const block of text.split("\n\n")) append(block, "\n\n");
  flush();
  return pages.length ? pages : [""];
}

export function formatPagedBridgeReply(
  text: string,
  maxLength: number,
  options: QueryReplyOptions,
  language: MessageBridgeLanguage,
): string {
  const pageLength = Math.max(200, maxLength - options.nextCommand.length - 40);
  const pages = paginateBridgeReply(text, pageLength);
  if (pages.length === 1) return pages[0];
  const page = Math.min(Math.max(Math.trunc(options.requestedPage) || 1, 1), pages.length);
  const nextPage = page < pages.length ? page + 1 : 1;
  const nextCommand = `${options.nextCommand} ${nextPage}`;
  return `[${page}/${pages.length}]\n${pages[page - 1]}\n\n${t(language, "下一頁: {command}", { command: nextCommand })}`;
}

export function splitOneBotForwardContent(text: string, maxLength = 1800): string[] {
  const paragraphs = text.split("\n\n");
  if (paragraphs.length < 2) return paginateBridgeReply(text, maxLength);
  const sections: string[] = [paragraphs[0]];
  let current = "";
  for (const paragraph of paragraphs.slice(1)) {
    if (paragraph.startsWith("【") && current) {
      sections.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) sections.push(current);
  return sections.flatMap((section) => {
    if (section.length <= maxLength) return [section];
    const pages: string[] = [];
    let page = "";
    for (const line of section.split("\n")) {
      const addition = page ? `\n${line}` : line;
      if (page && page.length + addition.length > maxLength) {
        pages.push(page);
        page = "";
      }
      if (line.length > maxLength) {
        if (page) pages.push(page);
        pages.push(...paginateBridgeReply(line, maxLength));
        page = "";
      } else {
        page = page ? `${page}\n${line}` : line;
      }
    }
    if (page) pages.push(page);
    return pages;
  });
}

export function buildOneBotForwardNodes(pages: readonly string[], selfId: string, nickname = "PalServer"): Array<Record<string, unknown>> {
  return pages.map((content) => ({
    type: "node",
    data: {
      user_id: selfId || "10000",
      nickname,
      content: [{ type: "text", data: { text: content } }],
    },
  }));
}

/** Keep large query replies in one QQ forward message by nesting node groups. */
export function buildOneBotForwardEnvelope(
  pages: readonly string[],
  selfId: string,
  nickname = "PalServer",
  maxDirectNodes = 6,
): Array<Record<string, unknown>> {
  if (!Number.isInteger(maxDirectNodes) || maxDirectNodes < 1) throw new Error("maxDirectNodes must be positive");
  const nodes = buildOneBotForwardNodes(pages, selfId, nickname);
  if (nodes.length <= maxDirectNodes) return nodes;
  const groups: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < nodes.length; offset += maxDirectNodes) {
    groups.push({
      type: "node",
      data: {
        user_id: selfId || "10000",
        nickname,
        content: nodes.slice(offset, offset + maxDirectNodes),
      },
    });
  }
  return groups;
}

function commandId(value: string | undefined, label: string, max: number, language: MessageBridgeLanguage): string {
  const clean = cleanText(value, max);
  if (!/^[A-Za-z0-9_:\-]+$/.test(clean)) {
    if (language === "en") throw new Error(`A valid ${label} is required.`);
    if (language === "ja") throw new Error(`有効な${label}が必要です。`);
    throw new Error(`需要有效的${label}`);
  }
  return clean;
}

export function playerQueryIdentifier(value: string | undefined, label: string, language: MessageBridgeLanguage): string {
  const clean = cleanText(value, 128);
  if (!clean || !/^[\p{L}\p{M}\p{N}_:\-.]+$/u.test(clean)) {
    if (language === "en") throw new Error(`A valid ${label} is required.`);
    if (language === "ja") throw new Error(`有効な${label}が必要です。`);
    throw new Error(`需要有效的${label}`);
  }
  return clean;
}

function commandNumber(value: string | undefined, label: string, min: number, max: number, fallback: number, language: MessageBridgeLanguage): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    if (language === "en") throw new Error(`${label} must be an integer from ${min} to ${max}.`);
    if (language === "ja") throw new Error(`${label}は ${min}〜${max} の整数で指定してください。`);
    throw new Error(`${label}必须是 ${min}-${max} 的整数`);
  }
  return n;
}

// ── 群服互通对外可见的纯渲染函数(给单测直接调用)──────────────────────────

/** 玩家进出服播报:[+] 玩家 [Alice] 加入了服务器 / [-] 玩家 [Alice] 离开了服务器。
 *  前缀 [+]/[-] 故意不本地化(参考 SSH / Discord 习惯),4 语言用户都能秒懂。 */
export function formatJoinLeave(isJoin: boolean, name: string, language: MessageBridgeLanguage): string {
  const sign = isJoin ? "[+]" : "[-]";
  const key = isJoin ? "玩家 [{name}] 加入了伺服器" : "玩家 [{name}] 離開了伺服器";
  return `${sign} ${t(language, key, { name })}`;
}

/** /players 列表的单行:`1. Alice - Lv.30 - 42.00ms`。4 语言共用同一模板。 */
export function formatPlayerItem(index: number, name: string, level: number, ping: number, language: MessageBridgeLanguage): string {
  return t(language, "{n}. {name} - Lv.{level} - {ping}ms", { n: index, name, level, ping: ping.toFixed(2) });
}

type InventoryCategory = "common" | "essential" | "weapons" | "armor" | "food" | "drop";

function inventoryCategory(container: string): InventoryCategory {
  const value = container.toLowerCase().replace(/[^a-z]/g, "");
  if (value.includes("keyitem") || value.includes("essential")) return "essential";
  if (value.includes("weapon")) return "weapons";
  if (value.includes("armor") || value.includes("armour")) return "armor";
  if (value.includes("food")) return "food";
  if (value.includes("dropslot") || value === "drop") return "drop";
  return "common";
}

/** 将 PalDefender 背包按游戏容器分区，QQ 会把每个【分区】作为一个合并转发节点。 */
export function formatInventoryReply(playerName: string, slots: readonly PdItemSlot[], language: MessageBridgeLanguage): string {
  const grouped = new Map<InventoryCategory, Map<string, number>>();
  for (const slot of slots) {
    if (!slot.itemId || !Number.isFinite(slot.count) || slot.count <= 0) continue;
    const category = inventoryCategory(slot.container);
    const totals = grouped.get(category) ?? new Map<string, number>();
    totals.set(slot.itemId, (totals.get(slot.itemId) ?? 0) + slot.count);
    grouped.set(category, totals);
  }
  const labels: ReadonlyArray<[InventoryCategory, string]> = [
    ["common", "普通物品"],
    ["essential", "重要物品"],
    ["weapons", "武器欄"],
    ["armor", "防具欄"],
    ["food", "食物欄"],
    ["drop", "掉落欄"],
  ];
  const blocks = labels.flatMap(([category, label]) => {
    const items = grouped.get(category);
    if (!items?.size) return [];
    const lines = [...items].map(([itemId, count]) => `- ${localizeItem(itemId, language)} ×${count}`);
    return [`【${t(language, label)}】\n${lines.join("\n")}`];
  });
  return [t(language, "[ 玩家 {name} 的背包 ]", { name: playerName }), ...blocks].join("\n\n");
}

/** /pal 单只帕鲁的多行(可能带 IVs 那行缩进 2 格的词条行)。 */
export function formatPalLine(pal: PdPal, language: MessageBridgeLanguage): string {
  const species = localizePalName(pal.palId, language);
  const hasNick = !!pal.nickname && pal.nickname.trim() !== "" && pal.nickname !== pal.palId;
  const star = pal.rank && pal.rank > 0 ? "★".repeat(pal.rank) : "";
  const isBoss = pal.isBoss === true || /^BOSS_/i.test(pal.palId);
  const bossTag = isBoss ? "(BOSS)" : "";
  const nameCore = hasNick ? `${pal.nickname} · ${species}` : species;
  const name = `${star}${nameCore}${bossTag}`;

  const gender = pal.gender === "Male" ? "♂" : pal.gender === "Female" ? "♀" : "";
  const head = `- ${name} Lv.${pal.level}${gender ? ` (${gender})` : ""}`;

  const ivsText = formatIvs(pal.ivs, language);
  const traitHeader = t(language, "詞條");
  const noPassives = t(language, "無詞條");
  const passivesText = pal.passives?.length
    ? t(language, "[{passives}]", { passives: pal.passives.map((id) => localizePassive(id, language)).join(t(language, " | ")) })
    : `[${noPassives}]`;

  if (ivsText) return `${head} - ${ivsText}\n  ${traitHeader}:${passivesText}`;
  return `${head} - ${passivesText}`;
}

/** IVs 段:`IVs(心67|攻0|防90)`。只展示 > 0 的维度,避免 0 噪音。空/全 0 返回空串(让调用方降级到无 IVs 行)。 */
export function formatIvs(ivs: PdPalIvs | undefined, language: MessageBridgeLanguage): string {
  if (!ivs) return "";
  const segs: string[] = [];
  if (ivs.hp != null && ivs.hp > 0) segs.push(`${t(language, "心")}${ivs.hp}`);
  if (ivs.attack != null && ivs.attack > 0) segs.push(`${t(language, "攻")}${ivs.attack}`);
  if (ivs.defense != null && ivs.defense > 0) segs.push(`${t(language, "防")}${ivs.defense}`);
  if (ivs.workSpeed != null && ivs.workSpeed > 0) segs.push(`${t(language, "工速")}${ivs.workSpeed}`);
  if (segs.length === 0) return "";
  return `IVs(${segs.join("|")})`;
}

export function buildAdminGrantCommand(command: "give" | "givepal", args: string[], language: MessageBridgeLanguage = "zh-CN"): { rcon: string; confirmation: string } {
  const userId = commandId(args[0], t(language, "玩家 UserId"), 128, language);
  const entityId = commandId(args[1], t(language, command === "give" ? "道具 ID" : "帕魯 ID"), 64, language);
  const amount = commandNumber(args[2], t(language, command === "give" ? "數量" : "等級"), 1, command === "give" ? 99_999 : 255, 1, language);
  return command === "give"
    ? { rcon: `give ${userId} ${entityId} ${amount}`, confirmation: t(language, "已發送道具", { user: userId, item: entityId, amount }) }
    : { rcon: `givepal ${userId} ${entityId} ${amount}`, confirmation: t(language, "已發送帕魯", { user: userId, name: localizePalName(entityId, language), id: entityId, level: amount }) };
}

function platformLabel(platform: MessageBridgePlatform): string {
  return platform === "onebot" ? "QQ" : platform[0].toUpperCase() + platform.slice(1);
}

abstract class ReconnectingAdapter implements Adapter {
  abstract id: string;
  abstract platform: MessageBridgePlatform;
  abstract language: MessageBridgeLanguage;
  protected stopped = true;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  constructor(protected onMessage: (message: AdapterIncomingMessage) => void, protected onState: (connected: boolean, error?: string) => void) {}
  start(): void { this.stopped = false; void this.connect(); }
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.close();
  }
  protected retry(error: unknown): void {
    if (this.stopped || this.reconnectTimer) return;
    this.onState(false, error instanceof Error ? error.message : String(error));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, RECONNECT_MS);
    this.reconnectTimer.unref();
  }
  protected abstract connect(): Promise<void>;
  protected abstract close(): void;
  abstract send(text: string): Promise<void>;
  async sendCommandReply(text: string, _options?: QueryReplyOptions): Promise<void> {
    const images = await renderMessageBridgeCards([text], this.language);
    await this.sendImages(images);
  }
  protected abstract sendImages(images: readonly Buffer[]): Promise<void>;
}

class OneBotAdapter extends ReconnectingAdapter {
  platform = "onebot" as const;
  get id(): string { return this.config.id; }
  get language(): MessageBridgeLanguage { return this.config.language; }
  private socket: WebSocket | null = null;
  private actionSequence = 0;
  private pendingActions = new Map<string, { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private config: StoredOneBotChannel, onMessage: (m: AdapterIncomingMessage) => void, onState: (c: boolean, e?: string) => void) { super(onMessage, onState); }
  protected async connect(): Promise<void> {
    try {
      const headers = this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : undefined;
      const socket = new WebSocket(this.config.wsUrl, { headers });
      this.socket = socket;
      socket.on("open", () => {
        this.onState(true);
      });
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          const echo = typeof event.echo === "string" ? event.echo : "";
          const pending = echo ? this.pendingActions.get(echo) : undefined;
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingActions.delete(echo);
            if (event.status === "ok" && Number(event.retcode ?? 0) === 0) pending.resolve((event.data ?? {}) as Record<string, unknown>);
            else pending.reject(new Error(cleanText(event.message || event.wording, 300) || `OneBot retcode ${event.retcode ?? "unknown"}`));
            return;
          }
          if (event.post_type !== "message" || event.message_type !== "group") return;
          if (String(event.group_id) !== this.config.groupId || event.self_id === event.user_id) return;
          const sender = (event.sender ?? {}) as Record<string, unknown>;
          this.onMessage({ platform: this.platform, userId: cleanText(event.user_id, 128), author: cleanText(sender.card || sender.nickname || event.user_id, 80), text: cleanText(event.raw_message ?? event.message) });
        } catch { /* ignore non-event frames */ }
      });
      socket.on("close", () => this.retry("OneBot WebSocket 已断开"));
      socket.on("error", (err) => this.retry(err));
    } catch (err) { this.retry(err); }
  }
  protected close(): void {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OneBot WebSocket 已断开"));
    }
    this.pendingActions.clear();
    this.socket?.close();
    this.socket = null;
  }
  private sendAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OneBot 未连接"));
    const socket = this.socket;
    const echo = `palserver-${Date.now()}-${++this.actionSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OneBot ${action} 响应超时`));
      }, 15_000);
      timer.unref();
      this.pendingActions.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingActions.delete(echo);
        reject(error);
      });
    });
  }
  async send(text: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("OneBot 未连接");
    this.socket.send(JSON.stringify({ action: "send_group_msg", params: { group_id: this.config.groupId, message: text } }));
  }
  protected async sendImages(images: readonly Buffer[]): Promise<void> {
    for (const image of images) {
      await this.sendAction("send_group_msg", {
        group_id: this.config.groupId,
        message: [{ type: "image", data: { file: `base64://${image.toString("base64")}` } }],
      });
    }
  }
  async sendCommandReply(text: string, options?: QueryReplyOptions): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("OneBot 未连接");
    void options;
    await this.sendImages(await renderMessageBridgeCards([text], this.language));
  }
}

export function normalizeDiscordProxyUrl(value: string): string {
  const raw = cleanText(value, 1000);
  if (!raw) throw new Error("请填写 Discord 代理地址");
  let url: URL;
  try { url = new URL(raw.includes("://") ? raw : `http://${raw}`); }
  catch { throw new Error("Discord 代理地址格式无效"); }
  if (!["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || !url.port) {
    throw new Error("Discord 代理需使用 HTTP、HTTPS、SOCKS4 或 SOCKS5 地址并包含端口");
  }
  return url.toString();
}

function discordProxyAgent(proxyUrl: string): HttpAgent {
  const normalized = normalizeDiscordProxyUrl(proxyUrl);
  return normalized.startsWith("socks") ? new SocksProxyAgent(normalized) : new HttpsProxyAgent(normalized);
}

export function buildDiscordImageMultipart(images: readonly Buffer[], boundary = `palserver-${Date.now().toString(36)}`): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => chunks.push(typeof value === "string" ? Buffer.from(value) : value);
  const attachments = images.map((_, index) => ({ id: index, filename: `palserver-${index + 1}.png` }));
  append(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n`);
  append(JSON.stringify({ attachments, allowed_mentions: { parse: [] } }));
  append("\r\n");
  images.forEach((image, index) => {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="files[${index}]"; filename="palserver-${index + 1}.png"\r\nContent-Type: image/png\r\n\r\n`);
    append(image);
    append("\r\n");
  });
  append(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

class DiscordAdapter extends ReconnectingAdapter {
  platform = "discord" as const;
  get id(): string { return this.config.id; }
  get language(): MessageBridgeLanguage { return this.config.language; }
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private botId = "";
  private readonly networkAgent: HttpAgent | undefined;
  constructor(private config: StoredDiscordChannel, onMessage: (m: AdapterIncomingMessage) => void, onState: (c: boolean, e?: string) => void) {
    super(onMessage, onState);
    this.networkAgent = config.proxyEnabled ? discordProxyAgent(config.proxyUrl) : undefined;
  }
  protected async connect(): Promise<void> {
    try {
      const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json", { agent: this.networkAgent });
      this.socket = socket;
      socket.on("message", (data) => this.handleFrame(data.toString()));
      socket.on("close", () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (this.socket === socket) this.socket = null;
        this.retry("Discord Gateway 已断开");
      });
      socket.on("error", (err) => this.retry(err));
    } catch (err) { this.retry(err); }
  }
  private handleFrame(raw: string): void {
    const frame = JSON.parse(raw) as { op: number; s?: number; t?: string; d?: any };
    if (typeof frame.s === "number") this.sequence = frame.s;
    if (frame.op === 10) {
      this.sendGateway(2, { token: this.config.token, intents: (1 << 9) | (1 << 15), properties: { os: process.platform, browser: "palserver-gui", device: "palserver-gui" } });
      this.heartbeat = setInterval(() => this.sendGateway(1, this.sequence), Number(frame.d.heartbeat_interval));
      this.heartbeat.unref();
    } else if (frame.op === 1) this.sendGateway(1, this.sequence);
    else if (frame.op === 7 || frame.op === 9) { this.close(); this.retry("Discord 请求重新连接"); }
    else if (frame.op === 0 && frame.t === "READY") { this.botId = String(frame.d.user.id); this.onState(true); }
    else if (frame.op === 0 && frame.t === "MESSAGE_CREATE") {
      const msg = frame.d as { channel_id: string; content: string; author: { id: string; username: string; bot?: boolean }; member?: { nick?: string } };
      if (msg.channel_id !== this.config.channelId || msg.author.bot || msg.author.id === this.botId) return;
      this.onMessage({ platform: this.platform, userId: cleanText(msg.author.id, 128), author: cleanText(msg.member?.nick || msg.author.username, 80), text: cleanText(msg.content) });
    }
  }
  private sendGateway(op: number, d: unknown): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ op, d })); }
  protected close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket?.close();
    this.socket = null;
  }
  private async request(body: string | Buffer, contentType: string): Promise<void> {
    const status = await new Promise<number>((resolve, reject) => {
      const request = https.request(`https://discord.com/api/v10/channels/${encodeURIComponent(this.config.channelId)}/messages`, {
        method: "POST",
        agent: this.networkAgent,
        headers: { Authorization: `Bot ${this.config.token}`, "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end(body);
    });
    if (status < 200 || status >= 300) throw new Error(`Discord HTTP ${status}`);
  }
  async send(text: string): Promise<void> {
    await this.request(JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }), "application/json");
  }
  protected async sendImages(images: readonly Buffer[]): Promise<void> {
    for (let offset = 0; offset < images.length; offset += 10) {
      const multipart = buildDiscordImageMultipart(images.slice(offset, offset + 10));
      await this.request(multipart.body, multipart.contentType);
    }
  }
  async sendCommandReply(text: string, options?: QueryReplyOptions): Promise<void> {
    void options;
    await this.sendImages(await renderMessageBridgeCards([text], this.language));
  }
}

class TelegramAdapter extends ReconnectingAdapter {
  platform = "telegram" as const;
  get id(): string { return this.config.id; }
  get language(): MessageBridgeLanguage { return this.config.language; }
  private abort: AbortController | null = null;
  private offset = 0;
  private initialized = false;
  constructor(private config: StoredTelegramChannel, onMessage: (m: AdapterIncomingMessage) => void, onState: (c: boolean, e?: string) => void) { super(onMessage, onState); }
  protected async connect(): Promise<void> {
    this.abort = new AbortController();
    while (!this.stopped && !this.abort.signal.aborted) {
      try {
        const url = new URL(`https://api.telegram.org/bot${this.config.token}/getUpdates`);
        // A negative offset discards old queued updates. A bridge coming online
        // must not replay hours of group chat into the game.
        url.searchParams.set("offset", this.initialized ? String(this.offset) : "-1");
        url.searchParams.set("timeout", "30");
        url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
        const response = await fetch(url, { signal: this.abort.signal });
        const body = await response.json() as { ok: boolean; description?: string; result?: any[] };
        if (!response.ok || !body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
        this.onState(true);
        for (const update of body.result ?? []) {
          this.offset = Math.max(this.offset, Number(update.update_id) + 1);
          if (!this.initialized) continue;
          const msg = update.message;
          if (!msg || String(msg.chat?.id) !== this.config.chatId || msg.from?.is_bot) continue;
          this.onMessage({ platform: this.platform, userId: cleanText(msg.from?.id, 128), author: cleanText([msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username, 80), text: cleanText(msg.text ?? msg.caption) });
        }
        this.initialized = true;
      } catch (err) {
        if (!this.stopped && !this.abort.signal.aborted) {
          this.onState(false, err instanceof Error ? err.message : String(err));
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
        }
      }
    }
  }
  protected close(): void { this.abort?.abort(); this.abort = null; }
  async send(text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.chatId, text: text.slice(0, 4096) }), signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  }
  protected async sendImages(images: readonly Buffer[]): Promise<void> {
    for (const image of images) {
      const form = new FormData();
      form.set("chat_id", this.config.chatId);
      form.set("photo", new Blob([new Uint8Array(image)], { type: "image/png" }), "palserver.png");
      const response = await fetch(`https://api.telegram.org/bot${this.config.token}/sendPhoto`, {
        method: "POST", body: form, signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    }
  }
  async sendCommandReply(text: string, options?: QueryReplyOptions): Promise<void> {
    void options;
    await this.sendImages(await renderMessageBridgeCards([text], this.language));
  }
}

class WebhookAdapter implements Adapter {
  platform = "webhook" as const;
  get id(): string { return this.config.id; }
  get language(): MessageBridgeLanguage { return this.config.language; }
  constructor(private config: StoredWebhookChannel, private onState: (c: boolean, e?: string) => void) {}
  start(): void { this.onState(true); }
  stop(): void { this.onState(false); }
  async send(text: string): Promise<void> {
    const response = await fetch(this.config.url, {
      method: "POST", headers: { "Content-Type": "application/json", ...(this.config.secret ? { "X-Palserver-Secret": this.config.secret } : {}) },
      body: JSON.stringify({ text, source: "palserver-gui", at: new Date().toISOString() }), signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  }
  private async sendImages(images: readonly Buffer[]): Promise<void> {
    for (const [index, image] of images.entries()) {
      const response = await fetch(this.config.url, {
        method: "POST", headers: { "Content-Type": "application/json", ...(this.config.secret ? { "X-Palserver-Secret": this.config.secret } : {}) },
        body: JSON.stringify({
          image: { contentType: "image/png", filename: `palserver-${index + 1}.png`, base64: image.toString("base64") },
          source: "palserver-gui",
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
    }
  }
  async sendCommandReply(text: string, options?: QueryReplyOptions): Promise<void> {
    void options;
    await this.sendImages(await renderMessageBridgeCards([text], this.language));
  }
}

export class MessageBridgeService {
  private runtimes = new Map<string, Runtime>();
  private states = new Map<string, MessageBridgeStatus>();
  private presenceTimer: NodeJS.Timeout | null = null;
  constructor(private store: InstanceStore, private presence: PresenceTracker, private driverOf: (rec: InstanceRecord) => ServerDriver) {}

  start(): void {
    for (const rec of this.store.list()) void this.restart(rec.id);
    this.presenceTimer = setInterval(() => void this.pollPresence(), 5_000);
    this.presenceTimer.unref();
  }
  stop(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    for (const id of [...this.runtimes.keys()]) this.stopRuntime(id);
  }
  private file(id: string): string { return path.join(this.store.instanceDir(id), "message-bridge.json"); }
  private read(id: string): StoredBridgeConfig {
    try { return mergeStoredBridgeConfig(JSON.parse(fs.readFileSync(this.file(id), "utf8"))); } catch { return defaults(); }
  }
  getConfig(id: string): MessageBridgeConfig {
    return { channels: this.read(id).channels.map((channel) => this.publicChannel(channel)) };
  }
  private publicChannel(channel: StoredBridgeChannel): MessageBridgeChannelConfig {
    const common = { ...this.publicRules(channel), id: channel.id, platform: channel.platform, enabled: channel.enabled, adminIds: channel.adminIds, language: channel.language };
    if (channel.platform === "onebot") return { ...common, platform: channel.platform, wsUrl: channel.wsUrl, groupId: channel.groupId, accessTokenSet: !!channel.accessToken };
    if (channel.platform === "discord") return { ...common, platform: channel.platform, channelId: channel.channelId, proxyEnabled: channel.proxyEnabled, proxyUrlSet: !!channel.proxyUrl, tokenSet: !!channel.token };
    if (channel.platform === "telegram") return { ...common, platform: channel.platform, chatId: channel.chatId, tokenSet: !!channel.token };
    return { ...common, platform: channel.platform, url: channel.url, secretSet: !!channel.secret };
  }
  private publicRules(channel: MessageBridgeRules): MessageBridgeRules {
    return {
      relayGroupToGame: channel.relayGroupToGame,
      relayGameToGroup: channel.relayGameToGroup,
      notifyJoinLeave: channel.notifyJoinLeave,
      notifyCapture: channel.notifyCapture,
      notifyDeath: channel.notifyDeath,
      relayPrefix: channel.relayPrefix,
      commandPrefix: channel.commandPrefix,
    };
  }
  async updateConfig(id: string, patch: MessageBridgePatch): Promise<MessageBridgeConfig> {
    const current = this.read(id);
    const secret = (next: string | undefined, old: string) => cleanText(next, 2000) || old;
    const channels = patch.channels.map((channel, index) => {
      const previous = current.channels.find((candidate) => candidate.id === channel.id && candidate.platform === channel.platform);
      let merged: MessageBridgeChannelPatch & Record<string, unknown> = { ...channel };
      if (channel.platform === "onebot") merged = { ...channel, accessToken: secret(channel.accessToken, previous?.platform === "onebot" ? previous.accessToken : "") };
      if (channel.platform === "discord") merged = { ...channel, proxyUrl: secret(channel.proxyUrl, previous?.platform === "discord" ? previous.proxyUrl : ""), token: secret(channel.token, previous?.platform === "discord" ? previous.token : "") };
      if (channel.platform === "telegram") merged = { ...channel, token: secret(channel.token, previous?.platform === "telegram" ? previous.token : "") };
      if (channel.platform === "webhook") merged = { ...channel, secret: secret(channel.secret, previous?.platform === "webhook" ? previous.secret : "") };
      return normalizeStoredChannel(merged, channel.platform, `${channel.platform}-${index + 1}`);
    });
    const next = mergeStoredBridgeConfig({ channels });
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(next, null, 2), { mode: 0o600 });
    await this.restart(id);
    return this.getConfig(id);
  }
  getStatus(id: string): MessageBridgeStatus { return this.states.get(id) ?? this.emptyStatus(false); }
  async receiveWebhook(id: string, channelId: string | undefined, suppliedSecret: string, userId: string, author: string, text: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    const channel = runtime?.config.channels.find((candidate): candidate is StoredWebhookChannel => candidate.platform === "webhook" && candidate.enabled && (channelId ? candidate.id === channelId : candidate.secret === suppliedSecret));
    if (!channel) throw new Error("Webhook 未启用");
    if (!channel.secret || suppliedSecret !== channel.secret) throw new Error("Webhook 密钥错误");
    await this.handleIncoming(id, { channelId: channel.id, platform: "webhook", userId: cleanText(userId, 128), author: cleanText(author, 80) || "Webhook", text: cleanText(text) });
  }
  private emptyStatus(running: boolean): MessageBridgeStatus {
    return { running, channels: {} };
  }
  private setState(id: string, channelId: string, connected: boolean, error?: string): void {
    const status = this.states.get(id) ?? this.emptyStatus(true);
    status.channels[channelId] = { connected, error: error ?? null };
    this.states.set(id, status);
  }
  private async restart(id: string): Promise<void> {
    this.stopRuntime(id);
    const rec = this.store.get(id);
    if (!rec) return;
    const config = this.read(id);
    const running = config.channels.some((channel) => channel.enabled);
    this.states.set(id, { running, channels: Object.fromEntries(config.channels.map((channel) => [channel.id, { connected: false, error: null }])) });
    if (!running) return;
    const adapters: Adapter[] = [];
    for (const channel of config.channels) {
      if (!channel.enabled) continue;
      const onMessage = (message: AdapterIncomingMessage) => {
        void this.handleIncoming(id, { ...message, channelId: channel.id }).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          this.setState(id, channel.id, false, `消息处理失败: ${detail}`);
          console.error(`[message-bridge/${channel.platform}/${channel.id}] ${detail}`);
        });
      };
      const state = (connected: boolean, error?: string) => this.setState(id, channel.id, connected, error);
      if (channel.platform === "onebot" && channel.wsUrl && channel.groupId) adapters.push(new OneBotAdapter(channel, onMessage, state));
      if (channel.platform === "discord" && channel.token && channel.channelId) adapters.push(new DiscordAdapter(channel, onMessage, state));
      if (channel.platform === "telegram" && channel.token && channel.chatId) adapters.push(new TelegramAdapter(channel, onMessage, state));
      if (channel.platform === "webhook" && channel.url) adapters.push(new WebhookAdapter(channel, state));
    }
    const latestPresence = this.presence.events(id, 1)[0];
    const runtime: Runtime = {
      config,
      adapters,
      stopLog: null,
      logRetry: null,
      attachingLog: false,
      seenLines: new Set(),
      lastPresenceKey: latestPresence ? this.presenceKey(latestPresence) : "",
    };
    this.runtimes.set(id, runtime);
    for (const adapter of adapters) adapter.start();
    await this.attachLogs(rec, runtime);
  }
  private stopRuntime(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (runtime.logRetry) clearTimeout(runtime.logRetry);
    runtime.stopLog?.();
    for (const adapter of runtime.adapters) adapter.stop();
    this.runtimes.delete(id);
  }
  private async attachLogs(rec: InstanceRecord, runtime: Runtime): Promise<void> {
    if (runtime.attachingLog || this.runtimes.get(rec.id) !== runtime) return;
    runtime.attachingLog = true;
    const driver = this.driverOf(rec);
    const ctx = { instanceDir: this.store.instanceDir(rec.id) };
    try {
      const sources = driver.logSources(rec, ctx);
      const source = sources.find((s) => s.id === "paldefender" && s.available)?.id ?? sources.find((s) => s.available)?.id;
      if (!source) { this.scheduleLogRetry(rec.id, runtime); return; }
      const ignoreUntil = Date.now() + 2_000;
      runtime.stopLog = await driver.streamLogs(rec, ctx, (line) => {
        if (Date.now() < ignoreUntil || runtime.seenLines.has(line)) return;
        runtime.seenLines.add(line);
        if (runtime.seenLines.size > 500) runtime.seenLines.delete(runtime.seenLines.values().next().value!);
        const event = parseGameLogLine(line);
        if (!event) return;
        if (event.type === "chat") void this.broadcast(rec.id, (language) => formatGameEvent(event, language), undefined, "relayGameToGroup");
        if (event.type === "death") void this.broadcast(rec.id, (language) => formatGameEvent(event, language), undefined, "notifyDeath");
        if (event.type === "capture") void this.broadcast(rec.id, (language) => formatGameEvent(event, language), undefined, "notifyCapture");
      }, () => this.scheduleLogRetry(rec.id, runtime), source);
    } catch {
      this.scheduleLogRetry(rec.id, runtime);
    } finally {
      runtime.attachingLog = false;
    }
  }
  private scheduleLogRetry(id: string, runtime: Runtime): void {
    if (runtime.logRetry || this.runtimes.get(id) !== runtime) return;
    runtime.stopLog?.();
    runtime.stopLog = null;
    runtime.logRetry = setTimeout(() => {
      runtime.logRetry = null;
      const rec = this.store.get(id);
      if (rec) void this.attachLogs(rec, runtime);
    }, RECONNECT_MS);
    runtime.logRetry.unref();
  }
  private async pollPresence(): Promise<void> {
    for (const [id, runtime] of this.runtimes) {
      const newestFirst = this.presence.events(id, 50);
      const previousIndex = newestFirst.findIndex((event) => this.presenceKey(event) === runtime.lastPresenceKey);
      const pending = !runtime.lastPresenceKey
        ? [...newestFirst].reverse()
        : previousIndex < 0 ? [] : newestFirst.slice(0, previousIndex).reverse();
      for (const event of pending) {
        runtime.lastPresenceKey = this.presenceKey(event);
        await this.broadcast(id, (language) => formatJoinLeave(event.type === "join", event.name, language), undefined, "notifyJoinLeave");
      }
      if (!runtime.lastPresenceKey && newestFirst[0]) runtime.lastPresenceKey = this.presenceKey(newestFirst[0]);
    }
  }
  private presenceKey(event: { at: string; type: string; userId: string }): string {
    return `${event.at}\0${event.type}\0${event.userId}`;
  }
  private async handleIncoming(id: string, message: IncomingMessage): Promise<void> {
    const runtime = this.runtimes.get(id);
    const rec = this.store.get(id);
    if (!runtime || !rec || !message.text) return;
    const channel = runtime.config.channels.find((candidate) => candidate.id === message.channelId);
    if (!channel) return;
    const command = parseBridgeCommand(message.text, channel.commandPrefix);
    if (command) {
      const isAdmin = channel.adminIds.includes(message.userId);
      const language = channel.language;
      let reply: string;
      try {
        reply = await this.commandReply(rec, message, command.name, command.args, channel.commandPrefix, isAdmin, language);
        if (isAdmin && this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, true);
      } catch (err) {
        reply = `${t(language, "指令執行失敗")}\n${err instanceof Error ? err.message : String(err)}`;
        if (this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, false, reply);
      }
      const queryReply = this.isQueryCommand(command.name)
        ? {
            nextCommand: [`${channel.commandPrefix}${command.name}`, command.args[0]].filter(Boolean).join(" "),
            requestedPage: Number(command.args[1]) || 1,
          }
        : undefined;
      await this.reply(id, message.channelId, reply, queryReply);
      return;
    }
    const relayText = parseRelayMessage(message.text, channel.relayPrefix);
    if (!relayText) return;
    const relayed = `[${platformLabel(message.platform)}] ${message.author}: ${relayText}`;
    if (channel.relayGroupToGame) await rest.announce(rec, relayed.slice(0, 500)).catch(() => {});
    await this.broadcast(id, relayed, message.channelId);
  }
  private isAdminCommand(command: string): boolean {
    return ["items", "inventory", "bag", "背包", "pals", "pal", "帕鲁", "帕魯", "give", "给", "給", "givepal", "给帕鲁", "給帕魯", "adminhelp"].includes(command);
  }
  private isQueryCommand(command: string): boolean {
    return ["items", "inventory", "bag", "背包", "pals", "pal", "帕鲁", "帕魯"].includes(command);
  }
  private async commandReply(
    rec: InstanceRecord,
    message: IncomingMessage,
    command: string,
    args: string[],
    prefix: string,
    isAdmin: boolean,
    language: MessageBridgeLanguage,
  ): Promise<string> {
    if (["whoami", "我的id", "id"].includes(command)) {
      return `${t(language, "身分資訊")}\n${platformLabel(message.platform)} User ID: ${message.userId || t(language, "無法取得")}`;
    }
    if (["help", "帮助", "指令"].includes(command)) {
      const normal = `${t(language, "可用指令")}\n${prefix}server · ${prefix}players · ${prefix}whoami · ${prefix}help`;
      return isAdmin ? `${normal}\n\n${t(language, "管理員指令")}\n${prefix}items · ${prefix}pals · ${prefix}give · ${prefix}givepal · ${prefix}adminhelp` : normal;
    }
    if (this.isAdminCommand(command)) {
      if (!isAdmin) return `${t(language, "權限不足")}\n${t(language, "傳送 {prefix}whoami 取得使用者 ID，並請服主將其加入此渠道的管理員名單。", { prefix })}`;
      if (command === "adminhelp") {
        return [
          t(language, "管理員指令"),
          `${prefix}items <UserId/${t(language, "玩家名")}> [${t(language, "頁碼")}]`,
          `${prefix}pals <UserId/${t(language, "玩家名")}> [${t(language, "頁碼")}]`,
          `${prefix}give <UserId> <ItemID> [${t(language, "數量")}]`,
          `${prefix}givepal <UserId> <PalID> [${t(language, "等級")}]`,
        ].join("\n");
      }
      const suppliedIdentifier = playerQueryIdentifier(args[0], t(language, "玩家 UserId"), language);
      const userId = resolvePlayerIdentifier(suppliedIdentifier, this.presence.knownPlayers(rec.id));
      if (["items", "inventory", "bag", "背包"].includes(command)) return this.inventoryReply(rec, userId, suppliedIdentifier, language);
      if (["pals", "pal", "帕鲁", "帕魯"].includes(command)) return this.palsReply(rec, userId, suppliedIdentifier, language);
      if (["give", "给", "給"].includes(command)) {
        const grant = buildAdminGrantCommand("give", args, language);
        await rconExec(rec, grant.rcon);
        return grant.confirmation;
      }
      const grant = buildAdminGrantCommand("givepal", args, language);
      await rconExec(rec, grant.rcon);
      return grant.confirmation;
    }
    if (!["server", "status", "players", "服务器", "玩家"].includes(command))
      return t(language, "未知指令: {command}\n傳送 {prefix}help 查看可用指令。", { command, prefix });
    const live = await getLiveStatus(rec);
    if (!live.available || !live.metrics || !live.info) return t(language, "{name} 目前離線，或 REST API 無法使用。", { name: rec.name });
    if (command === "players" || command === "玩家") {
      const online = live.players.filter((p) => p.name);
      const title = t(language, "[ 線上玩家 ({n}人) ]", { n: online.length });
      if (!online.length) return `${title}\n\n${t(language, "目前沒有玩家在線。")}`;
      // [ 在线玩家 (3人) ]\n\n1. xxx - Lv.x - xms\n\n2. ...
      const lines = online.map((p, i) => formatPlayerItem(i + 1, p.name, p.level, p.ping, language));
      return [title, "", ...lines].join("\n");
    }
    return [
      t(language, "伺服器狀態"),
      `${t(language, "名稱")}: ${live.info.servername || rec.name}`,
      `${t(language, "玩家")}: ${live.metrics.currentplayernum} / ${live.metrics.maxplayernum}`,
      `FPS: ${live.metrics.serverfps.toFixed(1)}`,
      `${t(language, "運行時間")}: ${t(language, "{value} 分鐘", { value: Math.floor(live.metrics.uptime / 60) })}`,
    ].join("\n");
  }
  private async savedPlayer(rec: InstanceRecord, identifiers: readonly string[]): Promise<{ profile: SavePlayerProfile | null; hasSnapshot: boolean }> {
    const ctx = { instanceDir: this.store.instanceDir(rec.id) };
    const worldGuid = await activeWorldGuidAsync(rec, ctx).catch(() => null);
    if (!worldGuid) return { profile: null, hasSnapshot: false };
    const summary = getPlayersSummary(ctx, worldGuid);
    if (!summary.generatedAt) return { profile: null, hasSnapshot: false };
    const player = resolveSavePlayer(identifiers, summary.players);
    return { profile: player ? getPlayerProfile(ctx, worldGuid, player.uid) : null, hasSnapshot: true };
  }

  private snapshotUnavailable(language: MessageBridgeLanguage, hasSnapshot: boolean): string {
    return t(language, hasSnapshot
      ? "快照裡找不到這位玩家(名稱或 UID 對不上)。掃描一次最新存檔試試。"
      : "尚未掃描過存檔。點「從存檔刷新」建立快照。");
  }

  private async inventoryReply(rec: InstanceRecord, identifier: string, suppliedIdentifier: string, language: MessageBridgeLanguage): Promise<string> {
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    if (detail.available && !detail.itemsUnavailable) {
      if (!detail.items.some((item) => item.itemId && item.count > 0)) return `${t(language, "背包")} · ${detail.name || suppliedIdentifier}\n${t(language, "背包為空。")}`;
      return formatInventoryReply(detail.name || suppliedIdentifier, detail.items, language);
    }
    const saved = await this.savedPlayer(rec, [detail.playerUid, detail.name, suppliedIdentifier, identifier]);
    if (!saved.profile) return `${t(language, "無法查詢背包")}\n${this.snapshotUnavailable(language, saved.hasSnapshot)}`;
    if (!saved.profile.inventory) return `${t(language, "背包")} · ${saved.profile.name}\n${t(language, "存檔快照沒有背包資料。請到玩家頁面按「從存檔刷新」重新掃描。")}`;
    const items = saveInventoryToPdItems(saved.profile.inventory);
    if (!items.some((item) => item.itemId && item.count > 0)) return `${t(language, "背包")} · ${saved.profile.name}\n${t(language, "背包為空。")}`;
    return formatInventoryReply(saved.profile.name, items, language);
  }

  private async palsReply(rec: InstanceRecord, identifier: string, suppliedIdentifier: string, language: MessageBridgeLanguage): Promise<string> {
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    let playerName = detail.name || suppliedIdentifier;
    let pals = detail.pals;
    if (!detail.available || detail.palsUnavailable) {
      const saved = await this.savedPlayer(rec, [detail.playerUid, detail.name, suppliedIdentifier, identifier]);
      if (!saved.profile) return `${t(language, "無法查詢帕魯")}\n${this.snapshotUnavailable(language, saved.hasSnapshot)}`;
      playerName = saved.profile.name;
      pals = saved.profile.pals.map(savePalToPdPal);
    }

    const title = t(language, "[ 玩家 {name} 的帕魯陣容 ]", { name: playerName });
    const teamPals = pals.filter((p) => p.location === "team");
    // 终端 (palbox) + 据点 (basecamp) 都算"非队伍"——一并展示,符合用户预期。
    const boxPals = pals.filter((p) => p.location === "palbox" || p.location === "basecamp");

    const teamBlock = teamPals.length === 0
      ? `${t(language, "【 隊伍帕魯 】")}\n${t(language, "此玩家暫無帕魯資料。")}`
      : `${t(language, "【 隊伍帕魯 】")}\n${teamPals.map((p) => formatPalLine(p, language)).join("\n")}`;
    const boxBlock = boxPals.length === 0
      ? `${t(language, "【 終端帕魯 (共 {n} 隻) 】", { n: 0 })}\n${t(language, "終端目前沒有存放任何帕魯。")}`
      : `${t(language, "【 終端帕魯 (共 {n} 隻) 】", { n: boxPals.length })}\n${boxPals.map((p) => formatPalLine(p, language)).join("\n")}`;

    return [title, teamBlock, boxBlock].join("\n\n");
  }

  private auditAdminCommand(id: string, message: IncomingMessage, command: string, ok: boolean, detail = ""): void {
    const record = { at: new Date().toISOString(), platform: message.platform, userId: message.userId, author: message.author, command, ok, detail: cleanText(detail, 300) };
    try {
      fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
      fs.appendFileSync(path.join(this.store.instanceDir(id), "message-bridge-admin-audit.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch { /* audit failure must not break command replies */ }
  }
  private async reply(id: string, channelId: string, text: string, query?: QueryReplyOptions): Promise<void> {
    const runtime = this.runtimes.get(id);
    const adapter = runtime?.adapters.find((candidate) => candidate.id === channelId);
    if (!adapter) return;
    try { await adapter.sendCommandReply(text, query); this.setState(id, channelId, true); }
    catch (err) { this.setState(id, channelId, false, err instanceof Error ? err.message : String(err)); }
  }
  private async broadcast(
    id: string,
    content: string | ((language: MessageBridgeLanguage) => string),
    excludeChannelId?: string,
    rule?: keyof MessageBridgeRules,
  ): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    await Promise.allSettled(runtime.adapters.filter((adapter) => {
      const channel = runtime.config.channels.find((candidate) => candidate.id === adapter.id);
      return adapter.id !== excludeChannelId && !!channel && (!rule || channel[rule] === true);
    }).map(async (adapter) => {
      try { await adapter.send(typeof content === "function" ? content(adapter.language) : content); this.setState(id, adapter.id, true); }
      catch (err) { this.setState(id, adapter.id, false, err instanceof Error ? err.message : String(err)); }
    }));
  }
}
