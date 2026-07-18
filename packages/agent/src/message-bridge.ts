import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { MessageBridgeConfig, MessageBridgePatch, MessageBridgePlatform, MessageBridgeStatus } from "@palserver/shared";
import type { ServerDriver } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import type { PresenceTracker } from "./presence.js";
import { getLiveStatus, rest } from "./restapi.js";
import { getPlayerDetail } from "./paldefender-rest.js";
import { rconExec } from "./rcon.js";

const API_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 5_000;

interface StoredBridgeConfig {
  enabled: boolean;
  relayGroupToGame: boolean;
  relayGameToGroup: boolean;
  notifyJoinLeave: boolean;
  notifyCapture: boolean;
  notifyDeath: boolean;
  commandPrefix: string;
  onebot: { added: boolean; enabled: boolean; wsUrl: string; groupId: string; adminIds: string[]; accessToken: string };
  discord: { added: boolean; enabled: boolean; channelId: string; adminIds: string[]; token: string };
  telegram: { added: boolean; enabled: boolean; chatId: string; adminIds: string[]; token: string };
  webhook: { added: boolean; enabled: boolean; url: string; adminIds: string[]; secret: string };
}

interface IncomingMessage { platform: MessageBridgePlatform; userId: string; author: string; text: string }
interface Adapter {
  platform: MessageBridgePlatform;
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

const defaults = (): StoredBridgeConfig => ({
  enabled: false,
  relayGroupToGame: true,
  relayGameToGroup: true,
  notifyJoinLeave: true,
  notifyCapture: true,
  notifyDeath: true,
  commandPrefix: "/",
  onebot: { added: false, enabled: false, wsUrl: "ws://127.0.0.1:3001", groupId: "", adminIds: [], accessToken: "" },
  discord: { added: false, enabled: false, channelId: "", adminIds: [], token: "" },
  telegram: { added: false, enabled: false, chatId: "", adminIds: [], token: "" },
  webhook: { added: false, enabled: false, url: "", adminIds: [], secret: "" },
});

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, max);
}

function cleanAdminIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => cleanText(id, 128)).filter(Boolean))].slice(0, 50);
}

function mergeStored(raw: Partial<StoredBridgeConfig> | null): StoredBridgeConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  return {
    ...d,
    ...raw,
    commandPrefix: cleanText(raw.commandPrefix ?? d.commandPrefix, 3) || "/",
    onebot: {
      ...d.onebot, ...(raw.onebot ?? {}),
      added: raw.onebot?.added ?? !!(raw.onebot?.enabled || raw.onebot?.groupId || raw.onebot?.accessToken),
      adminIds: cleanAdminIds(raw.onebot?.adminIds),
    },
    discord: {
      ...d.discord, ...(raw.discord ?? {}),
      added: raw.discord?.added ?? !!(raw.discord?.enabled || raw.discord?.channelId || raw.discord?.token),
      adminIds: cleanAdminIds(raw.discord?.adminIds),
    },
    telegram: {
      ...d.telegram, ...(raw.telegram ?? {}),
      added: raw.telegram?.added ?? !!(raw.telegram?.enabled || raw.telegram?.chatId || raw.telegram?.token),
      adminIds: cleanAdminIds(raw.telegram?.adminIds),
    },
    webhook: {
      ...d.webhook, ...(raw.webhook ?? {}),
      added: raw.webhook?.added ?? !!(raw.webhook?.enabled || raw.webhook?.url || raw.webhook?.secret),
      adminIds: cleanAdminIds(raw.webhook?.adminIds),
    },
  };
}

export type ParsedGameEvent =
  | { type: "chat"; text: string }
  | { type: "death"; text: string }
  | { type: "capture"; text: string }
  | null;

export function parseGameLogLine(raw: string): ParsedGameEvent {
  const line = raw.replace(/[\r\n]+$/, "");
  let m: RegExpMatchArray | null;
  if ((m = line.match(/\[Chat::(\w+)\]\['([^']+)'[^\]]*\]:\s?(.*)$/)))
    return { type: "chat", text: `[游戏/${m[1]}] ${m[2]}: ${cleanText(m[3])}` };
  if ((m = line.match(/'([^']+)'[^)]*\) was attacked by a wild '([^']+)'.*died/i)))
    return { type: "death", text: `☠ ${m[1]} 被野生 ${m[2]} 击杀` };
  if ((m = line.match(/'([^']+)'[^)]*\) died to (.+?)\.?$/i)))
    return { type: "death", text: `☠ ${m[1]} 死亡: ${cleanText(m[2])}` };
  if ((m = line.match(/'([^']+)'[^)]*\) (?:was killed|and died\.)/i)))
    return { type: "death", text: `☠ ${m[1]} 死亡` };
  if ((m = line.match(/'([^']+)'[^)]*\) (?:has captured Pal|picked up Pal) '([^']+)'/i)))
    return { type: "capture", text: `● ${m[1]} 捕捉了 ${m[2]}` };
  return null;
}

export function parseBridgeCommand(text: string, prefix: string): { name: string; args: string[] } | null {
  if (!text.startsWith(prefix)) return null;
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  return parts[0] ? { name: parts[0].toLowerCase(), args: parts.slice(1) } : null;
}

function commandId(value: string | undefined, label: string, max: number): string {
  const clean = cleanText(value, max);
  if (!/^[A-Za-z0-9_:\-]+$/.test(clean)) throw new Error(`需要有效的${label}`);
  return clean;
}

function commandNumber(value: string | undefined, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}必须是 ${min}-${max} 的整数`);
  return n;
}

export function buildAdminGrantCommand(command: "give" | "givepal", args: string[]): { rcon: string; confirmation: string } {
  const userId = commandId(args[0], "玩家 UserId", 128);
  const entityId = commandId(args[1], command === "give" ? "道具 ID" : "帕鲁 ID", 64);
  const amount = commandNumber(args[2], command === "give" ? "数量" : "等级", 1, command === "give" ? 99_999 : 255, 1);
  return command === "give"
    ? { rcon: `give ${userId} ${entityId} ${amount}`, confirmation: `已给 ${userId}: ${entityId} ×${amount}` }
    : { rcon: `givepal ${userId} ${entityId} ${amount}`, confirmation: `已给 ${userId}: ${entityId} Lv.${amount}` };
}

function platformLabel(platform: MessageBridgePlatform): string {
  return platform === "onebot" ? "QQ" : platform[0].toUpperCase() + platform.slice(1);
}

abstract class ReconnectingAdapter implements Adapter {
  abstract platform: MessageBridgePlatform;
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

class DiscordAdapter extends ReconnectingAdapter {
  platform = "discord" as const;
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private botId = "";
  constructor(private config: StoredBridgeConfig["discord"], onMessage: (m: IncomingMessage) => void, onState: (c: boolean, e?: string) => void) { super(onMessage, onState); }
  protected async connect(): Promise<void> {
    try {
      const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
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
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(this.config.channelId)}/messages`, {
      method: "POST", headers: { Authorization: `Bot ${this.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
  }
}

class TelegramAdapter extends ReconnectingAdapter {
  platform = "telegram" as const;
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
      enabled: c.enabled, relayGroupToGame: c.relayGroupToGame, relayGameToGroup: c.relayGameToGroup,
      notifyJoinLeave: c.notifyJoinLeave, notifyCapture: c.notifyCapture, notifyDeath: c.notifyDeath, commandPrefix: c.commandPrefix,
      onebot: { added: c.onebot.added, enabled: c.onebot.enabled, wsUrl: c.onebot.wsUrl, groupId: c.onebot.groupId, adminIds: c.onebot.adminIds, accessTokenSet: !!c.onebot.accessToken },
      discord: { added: c.discord.added, enabled: c.discord.enabled, channelId: c.discord.channelId, adminIds: c.discord.adminIds, tokenSet: !!c.discord.token },
      telegram: { added: c.telegram.added, enabled: c.telegram.enabled, chatId: c.telegram.chatId, adminIds: c.telegram.adminIds, tokenSet: !!c.telegram.token },
      webhook: { added: c.webhook.added, enabled: c.webhook.enabled, url: c.webhook.url, adminIds: c.webhook.adminIds, secretSet: !!c.webhook.secret },
    };
  }
  async updateConfig(id: string, patch: MessageBridgePatch): Promise<MessageBridgeConfig> {
    const current = this.read(id);
    const secret = (next: string | undefined, old: string) => cleanText(next, 2000) || old;
    const next = mergeStored({
      ...current, ...patch,
      onebot: { ...current.onebot, ...(patch.onebot ?? {}), accessToken: secret(patch.onebot?.accessToken, current.onebot.accessToken) },
      discord: { ...current.discord, ...(patch.discord ?? {}), token: secret(patch.discord?.token, current.discord.token) },
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
    this.states.set(id, this.emptyStatus(config.enabled));
    if (!config.enabled) return;
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
        if (event.type === "chat" && runtime.config.relayGameToGroup) void this.broadcast(rec.id, event.text);
        if (event.type === "death" && runtime.config.notifyDeath) void this.broadcast(rec.id, event.text);
        if (event.type === "capture" && runtime.config.notifyCapture) void this.broadcast(rec.id, event.text);
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
      if (!runtime.config.notifyJoinLeave) continue;
      const newestFirst = this.presence.events(id, 50);
      const previousIndex = newestFirst.findIndex((event) => this.presenceKey(event) === runtime.lastPresenceKey);
      const pending = !runtime.lastPresenceKey
        ? [...newestFirst].reverse()
        : previousIndex < 0 ? [] : newestFirst.slice(0, previousIndex).reverse();
      for (const event of pending) {
        runtime.lastPresenceKey = this.presenceKey(event);
        await this.broadcast(id, event.type === "join" ? `→ ${event.name} 加入服务器` : `← ${event.name} 离开服务器`);
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
    const command = parseBridgeCommand(message.text, runtime.config.commandPrefix);
    if (command) {
      const isAdmin = runtime.config[message.platform].adminIds.includes(message.userId);
      let reply: string;
      try {
        reply = await this.commandReply(rec, message, command.name, command.args, runtime.config.commandPrefix, isAdmin);
        if (isAdmin && this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, true);
      } catch (err) {
        reply = `指令失败: ${err instanceof Error ? err.message : String(err)}`;
        if (this.isAdminCommand(command.name)) this.auditAdminCommand(id, message, command.name, false, reply);
      }
      await this.reply(id, message.platform, reply);
      return;
    }
    const relayed = `[${platformLabel(message.platform)}] ${message.author}: ${message.text}`;
    if (runtime.config.relayGroupToGame) await rest.announce(rec, relayed.slice(0, 500)).catch(() => {});
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
  ): Promise<string> {
    if (["whoami", "我的id", "id"].includes(command)) {
      return `你的 ${platformLabel(message.platform)} 用户 ID: ${message.userId || "无法获取"}`;
    }
    if (["help", "帮助", "指令"].includes(command)) {
      const normal = `可用指令: ${prefix}server ${prefix}players ${prefix}whoami ${prefix}help`;
      return isAdmin ? `${normal}\n管理员: ${prefix}inventory ${prefix}pals ${prefix}give ${prefix}givepal ${prefix}adminhelp` : normal;
    }
    if (this.isAdminCommand(command)) {
      if (!isAdmin) return `权限不足。发送 ${prefix}whoami 获取用户 ID，请服主将其加入渠道管理员。`;
      if (command === "adminhelp") {
        return [
          "管理员指令:",
          `${prefix}inventory <UserId>`,
          `${prefix}pals <UserId>`,
          `${prefix}give <UserId> <ItemID> [数量]`,
          `${prefix}givepal <UserId> <PalID> [等级]`,
        ].join("\n");
      }
      const userId = this.safeId(args[0], "玩家 UserId");
      if (["inventory", "bag", "背包"].includes(command)) return this.inventoryReply(rec, userId);
      if (["pals", "pal", "帕鲁", "帕魯"].includes(command)) return this.palsReply(rec, userId);
      if (["give", "给", "給"].includes(command)) {
        const grant = buildAdminGrantCommand("give", args);
        await rconExec(rec, grant.rcon);
        return grant.confirmation;
      }
      const grant = buildAdminGrantCommand("givepal", args);
      await rconExec(rec, grant.rcon);
      return grant.confirmation;
    }
    if (!["server", "status", "players", "服务器", "玩家"].includes(command)) return `未知指令: ${command}（发送 ${prefix}help 查看）`;
    const live = await getLiveStatus(rec);
    if (!live.available || !live.metrics || !live.info) return `${rec.name}: 当前离线或 REST API 不可用`;
    const names = live.players.map((p) => p.name).filter(Boolean);
    if (command === "players" || command === "玩家") return names.length ? `在线玩家 (${names.length}): ${names.join("、")}` : "当前没有玩家在线";
    return `${live.info.servername || rec.name} | 在线 ${live.metrics.currentplayernum}/${live.metrics.maxplayernum} | FPS ${live.metrics.serverfps.toFixed(1)} | 运行 ${Math.floor(live.metrics.uptime / 60)} 分钟`;
  }
  private safeId(value: string | undefined, label: string): string {
    const clean = cleanText(value, 128);
    if (!/^[A-Za-z0-9_:\-]+$/.test(clean)) throw new Error(`需要有效的${label}`);
    return clean;
  }
  private async inventoryReply(rec: InstanceRecord, identifier: string): Promise<string> {
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    if (!detail.available) return `无法查询背包: ${detail.reason ?? "玩家不存在或 PalDefender REST 不可用"}`;
    if (detail.itemsUnavailable) return `${detail.name || identifier} 的背包当前不可查询（玩家可能离线）`;
    const totals = new Map<string, number>();
    for (const item of detail.items) totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.count);
    const items = [...totals].sort((a, b) => b[1] - a[1]);
    if (!items.length) return `${detail.name || identifier} 的背包为空`;
    const shown = items.slice(0, 20).map(([item, count]) => `${item} ×${count}`).join("、");
    return `背包 ${detail.name || identifier}（${items.length} 种）:\n${shown}${items.length > 20 ? `\n另有 ${items.length - 20} 种未显示` : ""}`;
  }
  private async palsReply(rec: InstanceRecord, identifier: string): Promise<string> {
    const detail = await getPlayerDetail(rec, { instanceDir: this.store.instanceDir(rec.id) }, identifier);
    if (!detail.available) return `无法查询帕鲁: ${detail.reason ?? "玩家不存在或 PalDefender REST 不可用"}`;
    if (detail.palsUnavailable) return `${detail.name || identifier} 的帕鲁当前不可查询（玩家可能离线）`;
    if (!detail.pals.length) return `${detail.name || identifier} 当前没有可查询的帕鲁`;
    const shown = detail.pals.slice(0, 20).map((pal) => {
      const where = pal.location === "team" ? "队伍" : pal.location === "basecamp" ? "据点" : "盒子";
      return `${pal.nickname || pal.palId}(${pal.palId}) Lv.${pal.level} [${where}]`;
    }).join("、");
    return `帕鲁 ${detail.name || identifier}（队伍 ${detail.teamCount} / 盒子 ${detail.palboxCount}）:\n${shown}${detail.pals.length > 20 ? `\n另有 ${detail.pals.length - 20} 只未显示` : ""}`;
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
  private async broadcast(id: string, text: string, exclude?: MessageBridgePlatform): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    await Promise.allSettled(runtime.adapters.filter((a) => a.platform !== exclude).map(async (adapter) => {
      try { await adapter.send(text); this.setState(id, adapter.platform, true); }
      catch (err) { this.setState(id, adapter.platform, false, err instanceof Error ? err.message : String(err)); }
    }));
  }
}
