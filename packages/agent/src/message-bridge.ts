import fs from "node:fs";
import https from "node:https";
import type { Agent as HttpAgent } from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { localizePalName } from "@palserver/shared";
import type { MessageBridgeConfig, MessageBridgeLanguage, MessageBridgePatch, MessageBridgePlatform, MessageBridgeRules, MessageBridgeStatus } from "@palserver/shared";
import type { ServerDriver } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import type { PresenceTracker } from "./presence.js";
import { getLiveStatus, rest } from "./restapi.js";
import { getPlayerDetail } from "./paldefender-rest.js";
import { rconExec } from "./rcon.js";

const API_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 5_000;

interface StoredBridgeConfig {
  onebot: MessageBridgeRules & { added: boolean; enabled: boolean; wsUrl: string; groupId: string; adminIds: string[]; language: MessageBridgeLanguage; accessToken: string };
  discord: MessageBridgeRules & { added: boolean; enabled: boolean; channelId: string; adminIds: string[]; language: MessageBridgeLanguage; proxyEnabled: boolean; proxyUrl: string; token: string };
  telegram: MessageBridgeRules & { added: boolean; enabled: boolean; chatId: string; adminIds: string[]; language: MessageBridgeLanguage; token: string };
  webhook: MessageBridgeRules & { added: boolean; enabled: boolean; url: string; adminIds: string[]; language: MessageBridgeLanguage; secret: string };
}

type LegacyBridgeConfig = Partial<StoredBridgeConfig> & Partial<MessageBridgeRules> & { enabled?: boolean };

interface IncomingMessage { platform: MessageBridgePlatform; userId: string; author: string; text: string }
interface Adapter {
  platform: MessageBridgePlatform;
  language: MessageBridgeLanguage;
  start(): void;
  stop(): void;
  send(text: string): Promise<void>;
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
  commandPrefix: "/",
});

const defaults = (): StoredBridgeConfig => ({
  onebot: { ...defaultRules(), added: false, enabled: false, wsUrl: "ws://127.0.0.1:3001", groupId: "", adminIds: [], language: "zh-CN", accessToken: "" },
  discord: { ...defaultRules(), added: false, enabled: false, channelId: "", adminIds: [], language: "zh-CN", proxyEnabled: false, proxyUrl: "", token: "" },
  telegram: { ...defaultRules(), added: false, enabled: false, chatId: "", adminIds: [], language: "zh-CN", token: "" },
  webhook: { ...defaultRules(), added: false, enabled: false, url: "", adminIds: [], language: "zh-CN", secret: "" },
});

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
    commandPrefix: cleanText(channel?.commandPrefix ?? legacy?.commandPrefix ?? fallback.commandPrefix, 3) || "/",
  };
}

function mergeStored(raw: LegacyBridgeConfig | null): StoredBridgeConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const legacyDisabled = raw.enabled === false;
  return {
    onebot: {
      ...d.onebot, ...raw.onebot, ...resolveMessageBridgeRules(raw.onebot, raw),
      added: raw.onebot?.added ?? !!(raw.onebot?.enabled || raw.onebot?.groupId || raw.onebot?.accessToken),
      enabled: legacyDisabled ? false : raw.onebot?.enabled ?? d.onebot.enabled,
      adminIds: cleanAdminIds(raw.onebot?.adminIds),
      language: cleanLanguage(raw.onebot?.language),
    },
    discord: {
      ...d.discord, ...raw.discord, ...resolveMessageBridgeRules(raw.discord, raw),
      added: raw.discord?.added ?? !!(raw.discord?.enabled || raw.discord?.channelId || raw.discord?.token),
      enabled: legacyDisabled ? false : raw.discord?.enabled ?? d.discord.enabled,
      adminIds: cleanAdminIds(raw.discord?.adminIds),
      language: cleanLanguage(raw.discord?.language),
      proxyEnabled: raw.discord?.proxyEnabled === true,
      proxyUrl: raw.discord?.proxyEnabled === true ? normalizeDiscordProxyUrl(raw.discord?.proxyUrl ?? "") : cleanText(raw.discord?.proxyUrl, 1000),
    },
    telegram: {
      ...d.telegram, ...raw.telegram, ...resolveMessageBridgeRules(raw.telegram, raw),
      added: raw.telegram?.added ?? !!(raw.telegram?.enabled || raw.telegram?.chatId || raw.telegram?.token),
      enabled: legacyDisabled ? false : raw.telegram?.enabled ?? d.telegram.enabled,
      adminIds: cleanAdminIds(raw.telegram?.adminIds),
      language: cleanLanguage(raw.telegram?.language),
    },
    webhook: {
      ...d.webhook, ...raw.webhook, ...resolveMessageBridgeRules(raw.webhook, raw),
      added: raw.webhook?.added ?? !!(raw.webhook?.enabled || raw.webhook?.url || raw.webhook?.secret),
      enabled: legacyDisabled ? false : raw.webhook?.enabled ?? d.webhook.enabled,
      adminIds: cleanAdminIds(raw.webhook?.adminIds),
      language: cleanLanguage(raw.webhook?.language),
    },
  };
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

const WORDS = {
  "zh-TW": { game: "遊戲", killed: "被野生 {pal} 擊殺", died: "死亡", captured: "捕捉了 {pal}", joined: "加入伺服器", left: "離開伺服器" },
  "zh-CN": { game: "游戏", killed: "被野生 {pal} 击杀", died: "死亡", captured: "捕捉了 {pal}", joined: "加入服务器", left: "离开服务器" },
  en: { game: "Game", killed: "was killed by a wild {pal}", died: "died", captured: "captured {pal}", joined: "joined the server", left: "left the server" },
  ja: { game: "ゲーム", killed: "野生の{pal}に倒されました", died: "死亡しました", captured: "{pal}を捕まえました", joined: "サーバーに参加しました", left: "サーバーから退出しました" },
} satisfies Record<MessageBridgeLanguage, Record<string, string>>;

const COMMAND_WORDS = {
  "zh-TW": {
    failed: "指令執行失敗", userId: "玩家 UserId", itemId: "道具 ID", palId: "帕魯 ID", amount: "數量", level: "等級",
    whoami: "身分資訊", idUnavailable: "無法取得", commands: "可用指令", adminCommands: "管理員指令", denied: "權限不足",
    deniedHint: "傳送 {prefix}whoami 取得使用者 ID，並請服主將其加入此渠道的管理員名單。", unknown: "未知指令: {command}\n傳送 {prefix}help 查看可用指令。",
    offline: "{name} 目前離線，或 REST API 無法使用。", server: "伺服器狀態", name: "名稱", players: "玩家", fps: "FPS", uptime: "運行時間", minutes: "{value} 分鐘",
    onlinePlayers: "線上玩家", noPlayers: "目前沒有玩家在線。", inventory: "背包", itemTypes: "道具種類", emptyInventory: "背包為空。", unavailableInventory: "無法查詢背包", offlineInventory: "背包目前無法查詢（玩家可能離線）。", moreTypes: "另有 {value} 種未顯示",
    pals: "帕魯", team: "隊伍", palbox: "帕魯盒", noPals: "目前沒有可查詢的帕魯。", unavailablePals: "無法查詢帕魯", offlinePals: "帕魯目前無法查詢（玩家可能離線）。", basecamp: "據點", morePals: "另有 {value} 隻未顯示",
    grantedItem: "已發送道具", grantedPal: "已發送帕魯", target: "玩家", item: "道具", pal: "帕魯",
  },
  "zh-CN": {
    failed: "指令执行失败", userId: "玩家 UserId", itemId: "道具 ID", palId: "帕鲁 ID", amount: "数量", level: "等级",
    whoami: "身份信息", idUnavailable: "无法获取", commands: "可用指令", adminCommands: "管理员指令", denied: "权限不足",
    deniedHint: "发送 {prefix}whoami 获取用户 ID，并请服主将其加入此渠道的管理员名单。", unknown: "未知指令: {command}\n发送 {prefix}help 查看可用指令。",
    offline: "{name} 当前离线，或 REST API 不可用。", server: "服务器状态", name: "名称", players: "玩家", fps: "FPS", uptime: "运行时间", minutes: "{value} 分钟",
    onlinePlayers: "在线玩家", noPlayers: "当前没有玩家在线。", inventory: "背包", itemTypes: "道具种类", emptyInventory: "背包为空。", unavailableInventory: "无法查询背包", offlineInventory: "背包当前无法查询（玩家可能离线）。", moreTypes: "另有 {value} 种未显示",
    pals: "帕鲁", team: "队伍", palbox: "帕鲁盒", noPals: "当前没有可查询的帕鲁。", unavailablePals: "无法查询帕鲁", offlinePals: "帕鲁当前无法查询（玩家可能离线）。", basecamp: "据点", morePals: "另有 {value} 只未显示",
    grantedItem: "已发送道具", grantedPal: "已发送帕鲁", target: "玩家", item: "道具", pal: "帕鲁",
  },
  en: {
    failed: "Command failed", userId: "player UserId", itemId: "item ID", palId: "Pal ID", amount: "amount", level: "level",
    whoami: "Identity", idUnavailable: "unavailable", commands: "Available Commands", adminCommands: "Admin Commands", denied: "Permission Denied",
    deniedHint: "Send {prefix}whoami to get your user ID, then ask the server owner to add it as an admin for this channel.", unknown: "Unknown command: {command}\nSend {prefix}help to list available commands.",
    offline: "{name} is offline, or the REST API is unavailable.", server: "Server Status", name: "Name", players: "Players", fps: "FPS", uptime: "Uptime", minutes: "{value} min",
    onlinePlayers: "Online Players", noPlayers: "No players are online.", inventory: "Inventory", itemTypes: "Item types", emptyInventory: "The inventory is empty.", unavailableInventory: "Inventory unavailable", offlineInventory: "The inventory cannot be queried right now (the player may be offline).", moreTypes: "+{value} more item types",
    pals: "Pals", team: "Team", palbox: "Palbox", noPals: "No Pals are available to query.", unavailablePals: "Pals unavailable", offlinePals: "Pals cannot be queried right now (the player may be offline).", basecamp: "Base", morePals: "+{value} more Pals",
    grantedItem: "Item Granted", grantedPal: "Pal Granted", target: "Player", item: "Item", pal: "Pal",
  },
  ja: {
    failed: "コマンドの実行に失敗しました", userId: "プレイヤー UserId", itemId: "アイテム ID", palId: "パル ID", amount: "数量", level: "レベル",
    whoami: "ユーザー情報", idUnavailable: "取得できません", commands: "利用可能なコマンド", adminCommands: "管理者コマンド", denied: "権限がありません",
    deniedHint: "{prefix}whoami でユーザー ID を取得し、サーバー管理者にこのチャンネルの管理者として追加を依頼してください。", unknown: "不明なコマンド: {command}\n{prefix}help で利用可能なコマンドを確認できます。",
    offline: "{name} はオフライン、または REST API を利用できません。", server: "サーバー状態", name: "名前", players: "プレイヤー", fps: "FPS", uptime: "稼働時間", minutes: "{value} 分",
    onlinePlayers: "オンラインプレイヤー", noPlayers: "オンラインのプレイヤーはいません。", inventory: "インベントリ", itemTypes: "アイテム種類", emptyInventory: "インベントリは空です。", unavailableInventory: "インベントリを取得できません", offlineInventory: "現在インベントリを取得できません（プレイヤーがオフラインの可能性があります）。", moreTypes: "ほか {value} 種類",
    pals: "パル", team: "手持ち", palbox: "パルボックス", noPals: "取得できるパルはいません。", unavailablePals: "パルを取得できません", offlinePals: "現在パルを取得できません（プレイヤーがオフラインの可能性があります）。", basecamp: "拠点", morePals: "ほか {value} 体",
    grantedItem: "アイテムを付与しました", grantedPal: "パルを付与しました", target: "プレイヤー", item: "アイテム", pal: "パル",
  },
} satisfies Record<MessageBridgeLanguage, Record<string, string>>;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function formatGameEvent(event: NonNullable<ParsedGameEvent>, language: MessageBridgeLanguage): string {
  const words = WORDS[language];
  if (event.type === "chat") return `[${words.game}/${event.channel}] ${event.author}: ${event.text}`;
  if (event.type === "capture") return `● ${event.player} ${fill(words.captured, { pal: localizePalName(event.pal, language) })}`;
  if (event.killerPal) return `☠ ${event.player} ${fill(words.killed, { pal: localizePalName(event.killerPal, language) })}`;
  return `☠ ${event.player} ${words.died}${event.cause ? `: ${event.cause}` : ""}`;
}

export function parseBridgeCommand(text: string, prefix: string): { name: string; args: string[] } | null {
  if (!text.startsWith(prefix)) return null;
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  return parts[0] ? { name: parts[0].toLowerCase(), args: parts.slice(1) } : null;
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

export function buildAdminGrantCommand(command: "give" | "givepal", args: string[], language: MessageBridgeLanguage = "zh-CN"): { rcon: string; confirmation: string } {
  const words = COMMAND_WORDS[language];
  const userId = commandId(args[0], words.userId, 128, language);
  const entityId = commandId(args[1], command === "give" ? words.itemId : words.palId, 64, language);
  const amount = commandNumber(args[2], command === "give" ? words.amount : words.level, 1, command === "give" ? 99_999 : 255, 1, language);
  return command === "give"
    ? { rcon: `give ${userId} ${entityId} ${amount}`, confirmation: `${words.grantedItem}\n${words.target}: ${userId}\n${words.item}: ${entityId} ×${amount}` }
    : { rcon: `givepal ${userId} ${entityId} ${amount}`, confirmation: `${words.grantedPal}\n${words.target}: ${userId}\n${words.pal}: ${localizePalName(entityId, language)} (${entityId}) · Lv.${amount}` };
}

function platformLabel(platform: MessageBridgePlatform): string {
  return platform === "onebot" ? "QQ" : platform[0].toUpperCase() + platform.slice(1);
}

abstract class ReconnectingAdapter implements Adapter {
  abstract platform: MessageBridgePlatform;
  abstract language: MessageBridgeLanguage;
  protected stopped = true;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  constructor(protected onMessage: (message: IncomingMessage) => void, protected onState: (connected: boolean, error?: string) => void) {}
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
}

class OneBotAdapter extends ReconnectingAdapter {
  platform = "onebot" as const;
  get language(): MessageBridgeLanguage { return this.config.language; }
  private socket: WebSocket | null = null;
  constructor(private config: StoredBridgeConfig["onebot"], onMessage: (m: IncomingMessage) => void, onState: (c: boolean, e?: string) => void) { super(onMessage, onState); }
  protected async connect(): Promise<void> {
    try {
      const headers = this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : undefined;
      const socket = new WebSocket(this.config.wsUrl, { headers });
      this.socket = socket;
      socket.on("open", () => this.onState(true));
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
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
  protected close(): void { this.socket?.close(); this.socket = null; }
  async send(text: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("OneBot 未连接");
    this.socket.send(JSON.stringify({ action: "send_group_msg", params: { group_id: this.config.groupId, message: text } }));
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

class DiscordAdapter extends ReconnectingAdapter {
  platform = "discord" as const;
  get language(): MessageBridgeLanguage { return this.config.language; }
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private botId = "";
  private readonly networkAgent: HttpAgent | undefined;
  constructor(private config: StoredBridgeConfig["discord"], onMessage: (m: IncomingMessage) => void, onState: (c: boolean, e?: string) => void) {
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
  async send(text: string): Promise<void> {
    const body = JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } });
    const status = await new Promise<number>((resolve, reject) => {
      const request = https.request(`https://discord.com/api/v10/channels/${encodeURIComponent(this.config.channelId)}/messages`, {
        method: "POST",
        agent: this.networkAgent,
        headers: { Authorization: `Bot ${this.config.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
}

class TelegramAdapter extends ReconnectingAdapter {
  platform = "telegram" as const;
  get language(): MessageBridgeLanguage { return this.config.language; }
  private abort: AbortController | null = null;
  private offset = 0;
  private initialized = false;
  constructor(private config: StoredBridgeConfig["telegram"], onMessage: (m: IncomingMessage) => void, onState: (c: boolean, e?: string) => void) { super(onMessage, onState); }
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
}

class WebhookAdapter implements Adapter {
  platform = "webhook" as const;
  get language(): MessageBridgeLanguage { return this.config.language; }
  constructor(private config: StoredBridgeConfig["webhook"], private onState: (c: boolean, e?: string) => void) {}
  start(): void { this.onState(true); }
  stop(): void { this.onState(false); }
  async send(text: string): Promise<void> {
    const response = await fetch(this.config.url, {
      method: "POST", headers: { "Content-Type": "application/json", ...(this.config.secret ? { "X-Palserver-Secret": this.config.secret } : {}) },
      body: JSON.stringify({ text, source: "palserver-gui", at: new Date().toISOString() }), signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
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
    try { return mergeStored(JSON.parse(fs.readFileSync(this.file(id), "utf8"))); } catch { return defaults(); }
  }
  getConfig(id: string): MessageBridgeConfig {
    const c = this.read(id);
    return {
      onebot: { ...this.publicRules(c.onebot), added: c.onebot.added, enabled: c.onebot.enabled, wsUrl: c.onebot.wsUrl, groupId: c.onebot.groupId, adminIds: c.onebot.adminIds, language: c.onebot.language, accessTokenSet: !!c.onebot.accessToken },
      discord: { ...this.publicRules(c.discord), added: c.discord.added, enabled: c.discord.enabled, channelId: c.discord.channelId, adminIds: c.discord.adminIds, language: c.discord.language, proxyEnabled: c.discord.proxyEnabled, proxyUrlSet: !!c.discord.proxyUrl, tokenSet: !!c.discord.token },
      telegram: { ...this.publicRules(c.telegram), added: c.telegram.added, enabled: c.telegram.enabled, chatId: c.telegram.chatId, adminIds: c.telegram.adminIds, language: c.telegram.language, tokenSet: !!c.telegram.token },
      webhook: { ...this.publicRules(c.webhook), added: c.webhook.added, enabled: c.webhook.enabled, url: c.webhook.url, adminIds: c.webhook.adminIds, language: c.webhook.language, secretSet: !!c.webhook.secret },
    };
  }
  private publicRules(channel: MessageBridgeRules): MessageBridgeRules {
    return {
      relayGroupToGame: channel.relayGroupToGame,
      relayGameToGroup: channel.relayGameToGroup,
      notifyJoinLeave: channel.notifyJoinLeave,
      notifyCapture: channel.notifyCapture,
      notifyDeath: channel.notifyDeath,
      commandPrefix: channel.commandPrefix,
    };
  }
  async updateConfig(id: string, patch: MessageBridgePatch): Promise<MessageBridgeConfig> {
    const current = this.read(id);
    const secret = (next: string | undefined, old: string) => cleanText(next, 2000) || old;
    const next = mergeStored({
      ...current, ...patch,
      onebot: { ...current.onebot, ...(patch.onebot ?? {}), accessToken: secret(patch.onebot?.accessToken, current.onebot.accessToken) },
      discord: { ...current.discord, ...(patch.discord ?? {}), proxyUrl: secret(patch.discord?.proxyUrl, current.discord.proxyUrl), token: secret(patch.discord?.token, current.discord.token) },
      telegram: { ...current.telegram, ...(patch.telegram ?? {}), token: secret(patch.telegram?.token, current.telegram.token) },
      webhook: { ...current.webhook, ...(patch.webhook ?? {}), secret: secret(patch.webhook?.secret, current.webhook.secret) },
    });
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(next, null, 2), { mode: 0o600 });
    await this.restart(id);
    return this.getConfig(id);
  }
  getStatus(id: string): MessageBridgeStatus { return this.states.get(id) ?? this.emptyStatus(false); }
  async receiveWebhook(id: string, suppliedSecret: string, userId: string, author: string, text: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime?.config.webhook.added || !runtime.config.webhook.enabled) throw new Error("Webhook 未启用");
    if (!runtime.config.webhook.secret || suppliedSecret !== runtime.config.webhook.secret) throw new Error("Webhook 密钥错误");
    await this.handleIncoming(id, { platform: "webhook", userId: cleanText(userId, 128), author: cleanText(author, 80) || "Webhook", text: cleanText(text) });
  }
  private emptyStatus(running: boolean): MessageBridgeStatus {
    return { running, platforms: { onebot: { connected: false, error: null }, discord: { connected: false, error: null }, telegram: { connected: false, error: null }, webhook: { connected: false, error: null } } };
  }
  private setState(id: string, platform: MessageBridgePlatform, connected: boolean, error?: string): void {
    const status = this.states.get(id) ?? this.emptyStatus(true);
    status.platforms[platform] = { connected, error: error ?? null };
    this.states.set(id, status);
  }
  private async restart(id: string): Promise<void> {
    this.stopRuntime(id);
    const rec = this.store.get(id);
    if (!rec) return;
    const config = this.read(id);
    const running = (["onebot", "discord", "telegram", "webhook"] as const).some((platform) => config[platform].added && config[platform].enabled);
    this.states.set(id, this.emptyStatus(running));
    if (!running) return;
    const onMessage = (message: IncomingMessage) => void this.handleIncoming(id, message);
    const state = (platform: MessageBridgePlatform) => (connected: boolean, error?: string) => this.setState(id, platform, connected, error);
    const adapters: Adapter[] = [];
    if (config.onebot.added && config.onebot.enabled && config.onebot.wsUrl && config.onebot.groupId) adapters.push(new OneBotAdapter(config.onebot, onMessage, state("onebot")));
    if (config.discord.added && config.discord.enabled && config.discord.token && config.discord.channelId) adapters.push(new DiscordAdapter(config.discord, onMessage, state("discord")));
    if (config.telegram.added && config.telegram.enabled && config.telegram.token && config.telegram.chatId) adapters.push(new TelegramAdapter(config.telegram, onMessage, state("telegram")));
    if (config.webhook.added && config.webhook.enabled && config.webhook.url) adapters.push(new WebhookAdapter(config.webhook, state("webhook")));
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
        await this.broadcast(id, (language) => `${event.type === "join" ? "→" : "←"} ${event.name} ${WORDS[language][event.type === "join" ? "joined" : "left"]}`, undefined, "notifyJoinLeave");
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
    const channel = runtime.config[message.platform];
    const command = parseBridgeCommand(message.text, channel.commandPrefix);
    if (command) {
      const isAdmin = runtime.config[message.platform].adminIds.includes(message.userId);
      const language = runtime.config[message.platform].language;
      let reply: string;
      try {
        reply = await this.commandReply(rec, message, command.name, command.args, channel.commandPrefix, isAdmin, language);
        if (isAdmin && this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, true);
      } catch (err) {
        reply = `${COMMAND_WORDS[language].failed}\n${err instanceof Error ? err.message : String(err)}`;
        if (this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, false, reply);
      }
      await this.reply(id, message.platform, reply);
      return;
    }
    const relayed = `[${platformLabel(message.platform)}] ${message.author}: ${message.text}`;
    if (channel.relayGroupToGame) await rest.announce(rec, relayed.slice(0, 500)).catch(() => {});
    await this.broadcast(id, relayed, message.platform);
  }
  private isAdminCommand(command: string): boolean {
    return ["inventory", "bag", "背包", "pals", "pal", "帕鲁", "帕魯", "give", "给", "給", "givepal", "给帕鲁", "給帕魯", "adminhelp"].includes(command);
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
    const words = COMMAND_WORDS[language];
    if (["whoami", "我的id", "id"].includes(command)) {
      return `${words.whoami}\n${platformLabel(message.platform)} User ID: ${message.userId || words.idUnavailable}`;
    }
    if (["help", "帮助", "指令"].includes(command)) {
      const normal = `${words.commands}\n${prefix}server · ${prefix}players · ${prefix}whoami · ${prefix}help`;
      return isAdmin ? `${normal}\n\n${words.adminCommands}\n${prefix}inventory · ${prefix}pals · ${prefix}give · ${prefix}givepal · ${prefix}adminhelp` : normal;
    }
    if (this.isAdminCommand(command)) {
      if (!isAdmin) return `${words.denied}\n${fill(words.deniedHint, { prefix })}`;
      if (command === "adminhelp") {
        return [
          words.adminCommands,
          `${prefix}inventory <UserId>`,
          `${prefix}pals <UserId>`,
          `${prefix}give <UserId> <ItemID> [${words.amount}]`,
          `${prefix}givepal <UserId> <PalID> [${words.level}]`,
        ].join("\n");
      }
      const userId = this.safeId(args[0], words.userId, language);
      if (["inventory", "bag", "背包"].includes(command)) return this.inventoryReply(rec, userId, language);
      if (["pals", "pal", "帕鲁", "帕魯"].includes(command)) return this.palsReply(rec, userId, language);
      if (["give", "给", "給"].includes(command)) {
        const grant = buildAdminGrantCommand("give", args, language);
        await rconExec(rec, grant.rcon);
        return grant.confirmation;
      }
      const grant = buildAdminGrantCommand("givepal", args, language);
      await rconExec(rec, grant.rcon);
      return grant.confirmation;
    }
    if (!["server", "status", "players", "服务器", "玩家"].includes(command)) return fill(words.unknown, { command, prefix });
    const live = await getLiveStatus(rec);
    if (!live.available || !live.metrics || !live.info) return fill(words.offline, { name: rec.name });
    const names = live.players.map((p) => p.name).filter(Boolean);
    if (command === "players" || command === "玩家") {
      return names.length ? `${words.onlinePlayers} · ${names.length}\n${names.map((name, index) => `${index + 1}. ${name}`).join("\n")}` : `${words.onlinePlayers}\n${words.noPlayers}`;
    }
    return [
      words.server,
      `${words.name}: ${live.info.servername || rec.name}`,
      `${words.players}: ${live.metrics.currentplayernum} / ${live.metrics.maxplayernum}`,
      `${words.fps}: ${live.metrics.serverfps.toFixed(1)}`,
      `${words.uptime}: ${fill(words.minutes, { value: Math.floor(live.metrics.uptime / 60) })}`,
    ].join("\n");
  }
  private safeId(value: string | undefined, label: string, language: MessageBridgeLanguage): string {
    const clean = cleanText(value, 128);
    if (!/^[A-Za-z0-9_:\-]+$/.test(clean)) return commandId(value, label, 128, language);
    return clean;
  }
  private async inventoryReply(rec: InstanceRecord, identifier: string, language: MessageBridgeLanguage): Promise<string> {
    const words = COMMAND_WORDS[language];
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    if (!detail.available) return `${words.unavailableInventory}\n${fill(words.offline, { name: identifier })}`;
    if (detail.itemsUnavailable) return `${words.inventory} · ${detail.name || identifier}\n${words.offlineInventory}`;
    const totals = new Map<string, number>();
    for (const item of detail.items) totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.count);
    const items = [...totals].sort((a, b) => b[1] - a[1]);
    if (!items.length) return `${words.inventory} · ${detail.name || identifier}\n${words.emptyInventory}`;
    const shown = items.slice(0, 20).map(([item, count], index) => `${index + 1}. ${item} ×${count}`).join("\n");
    return `${words.inventory} · ${detail.name || identifier}\n${words.itemTypes}: ${items.length}\n\n${shown}${items.length > 20 ? `\n${fill(words.moreTypes, { value: items.length - 20 })}` : ""}`;
  }
  private async palsReply(rec: InstanceRecord, identifier: string, language: MessageBridgeLanguage): Promise<string> {
    const words = COMMAND_WORDS[language];
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    if (!detail.available) return `${words.unavailablePals}\n${fill(words.offline, { name: identifier })}`;
    if (detail.palsUnavailable) return `${words.pals} · ${detail.name || identifier}\n${words.offlinePals}`;
    if (!detail.pals.length) return `${words.pals} · ${detail.name || identifier}\n${words.noPals}`;
    const shown = detail.pals.slice(0, 20).map((pal, index) => {
      const where = pal.location === "team" ? words.team : pal.location === "basecamp" ? words.basecamp : words.palbox;
      const species = localizePalName(pal.palId, language);
      const display = pal.nickname && pal.nickname !== pal.palId ? `${pal.nickname} · ${species}` : species;
      return `${index + 1}. ${display} · Lv.${pal.level} · ${where}`;
    }).join("\n");
    return `${words.pals} · ${detail.name || identifier}\n${words.team}: ${detail.teamCount} · ${words.palbox}: ${detail.palboxCount}\n\n${shown}${detail.pals.length > 20 ? `\n${fill(words.morePals, { value: detail.pals.length - 20 })}` : ""}`;
  }
  private auditAdminCommand(id: string, message: IncomingMessage, command: string, ok: boolean, detail = ""): void {
    const record = { at: new Date().toISOString(), platform: message.platform, userId: message.userId, author: message.author, command, ok, detail: cleanText(detail, 300) };
    try {
      fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
      fs.appendFileSync(path.join(this.store.instanceDir(id), "message-bridge-admin-audit.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch { /* audit failure must not break command replies */ }
  }
  private async reply(id: string, platform: MessageBridgePlatform, text: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    const adapter = runtime?.adapters.find((candidate) => candidate.platform === platform);
    if (!adapter) return;
    try { await adapter.send(text); this.setState(id, platform, true); }
    catch (err) { this.setState(id, platform, false, err instanceof Error ? err.message : String(err)); }
  }
  private async broadcast(
    id: string,
    content: string | ((language: MessageBridgeLanguage) => string),
    exclude?: MessageBridgePlatform,
    rule?: keyof MessageBridgeRules,
  ): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    await Promise.allSettled(runtime.adapters.filter((adapter) => adapter.platform !== exclude && (!rule || runtime.config[adapter.platform][rule] === true)).map(async (adapter) => {
      try { await adapter.send(typeof content === "function" ? content(adapter.language) : content); this.setState(id, adapter.platform, true); }
      catch (err) { this.setState(id, adapter.platform, false, err instanceof Error ? err.message : String(err)); }
    }));
  }
}
