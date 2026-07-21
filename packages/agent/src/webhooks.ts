import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  WEBHOOK_SPEC_VERSION,
  WEBHOOK_HEADERS,
  eventMatches,
  toDiscordPayload,
  type WebhookConfig,
  type WebhookConfigPublic,
  type WebhookEnvelope,
  type WebhookEventType,
  type WebhookFormat,
  type WebhookDelivery,
} from "@palserver/shared";
import type { InstanceStore } from "./store.js";
import { onAgentEvent, type AgentEvent } from "./events.js";
import { featureEnabled } from "./license.js";

/**
 * Webhook dispatcher + 每實例持久化。
 *
 * 訂閱 events.ts 的事件匯流排,對每個 instance 的已啟用 webhook,把事件包成信封 → 依格式
 * (generic 帶 HMAC 簽章 / discord 轉 embed)POST 出去;失敗進重試佇列(指數退避)。
 * 設定與執行期狀態分兩檔存,寫入全部經過 per-instance promise chain 序列化,避免並行
 * read-modify-write 互相蓋掉(比照 public-map.ts 的 chains 作法)。
 *
 * 授權:整組功能贊助限定 —— featureEnabled("webhooks")。dispatcher / 佇列 / CRUD 都把關,
 * 即使有人繞過 UI 直接改 JSON,未授權也不會送出。
 */

const FETCH_TIMEOUT_MS = 15_000; // Discord/遠端經 Tailscale 偶有延遲,給多點餘裕(失敗仍有重試佇列)
const RETRY_TICK_MS = 30_000;
const MAX_ATTEMPTS = 6;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60_000;
const MAX_DELIVERIES = 100; // 每實例送出日誌環形上限

/** 第 n 次失敗後、下一次重試前要等多久(ms)。 */
function backoffMs(attempts: number): number {
  const schedule = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000];
  return schedule[Math.min(attempts, schedule.length) - 1] ?? 7_200_000;
}

// ── agent 端儲存型別(config 含 secret,不對外) ──

interface StoredWebhook extends WebhookConfig {
  secret: string;
}
interface StoredConfig {
  webhooks: StoredWebhook[];
}
interface QueuedDelivery {
  webhookId: string;
  envelope: WebhookEnvelope;
  attempts: number;
  nextAttemptAt: number;
  firstTriedAt: number;
}
interface Runtime {
  queue: QueuedDelivery[];
  deliveries: WebhookDelivery[];
}

// ── 檔案讀寫 ──

const configFile = (store: InstanceStore, id: string) =>
  path.join(store.instanceDir(id), "webhooks.json");
const runtimeFile = (store: InstanceStore, id: string) =>
  path.join(store.instanceDir(id), "webhook-runtime.json");

function readConfig(store: InstanceStore, id: string): StoredConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(store, id), "utf8")) as Partial<StoredConfig>;
    return { webhooks: Array.isArray(raw.webhooks) ? raw.webhooks : [] };
  } catch {
    return { webhooks: [] };
  }
}
function writeConfig(store: InstanceStore, id: string, cfg: StoredConfig): void {
  fs.mkdirSync(store.instanceDir(id), { recursive: true });
  fs.writeFileSync(configFile(store, id), JSON.stringify(cfg, null, 2));
}
function readRuntime(store: InstanceStore, id: string): Runtime {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFile(store, id), "utf8")) as Partial<Runtime>;
    return { queue: raw.queue ?? [], deliveries: raw.deliveries ?? [] };
  } catch {
    return { queue: [], deliveries: [] };
  }
}
function writeRuntime(store: InstanceStore, id: string, rt: Runtime): void {
  fs.mkdirSync(store.instanceDir(id), { recursive: true });
  fs.writeFileSync(runtimeFile(store, id), JSON.stringify(rt, null, 2));
}

// ── 簽章 / 送出(純函式,方便測試)──

const genSecret = () => crypto.randomBytes(32).toString("base64url");
const genId = (prefix: string, bytes = 12) => `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;

/** HMAC-SHA256(secret, `${timestamp}.${body}`) 的 hex。 */
export function signBody(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** 建 generic 格式要送的 headers(含 HMAC 簽章)。 */
export function buildGenericHeaders(
  secret: string,
  env: WebhookEnvelope,
  timestamp: string,
  body: string,
  agentVersion: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": `palserver-agent/${agentVersion}`,
    [WEBHOOK_HEADERS.event]: env.type,
    [WEBHOOK_HEADERS.delivery]: env.id,
    [WEBHOOK_HEADERS.timestamp]: timestamp,
    [WEBHOOK_HEADERS.signature]: `sha256=${signBody(secret, timestamp, body)}`,
  };
}

interface DeliverResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function deliver(wh: StoredWebhook, env: WebhookEnvelope, agentVersion: string): Promise<DeliverResult> {
  const body =
    wh.format === "discord" ? JSON.stringify(toDiscordPayload(env)) : JSON.stringify(env);
  const headers =
    wh.format === "discord"
      ? { "Content-Type": "application/json", "User-Agent": `palserver-agent/${agentVersion}` }
      : buildGenericHeaders(wh.secret, env, Math.floor(Date.now() / 1000).toString(), body, agentVersion);
  try {
    const res = await fetch(wh.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

function toPublic({ secret, ...rest }: StoredWebhook, rt: Runtime): WebhookConfigPublic {
  const last = [...rt.deliveries].reverse().find((del) => del.deliveryId.startsWith(rest.id));
  return {
    ...rest,
    lastDelivery: last ? { at: last.at, ok: last.ok, status: last.status, error: last.error } : undefined,
    secretSet: !!secret,
  };
}

// ── 服務 ──

export class WebhooksService {
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private store: InstanceStore,
    private agentVersion: string,
    /** 授權判斷注入點(測試用);預設走 license 模組。 */
    private featureEnabledFn: () => boolean = () => featureEnabled("webhooks"),
  ) {}

  start(): void {
    if (this.unsub) return;
    this.unsub = onAgentEvent((ev) => void this.dispatchEvent(ev));
    this.timer = setInterval(() => void this.retryTick(), RETRY_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 同一實例的所有狀態變更序列化執行,避免並行 read-modify-write 互蓋。 */
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(id, next.catch(() => {}));
    return next;
  }

  // ── dispatcher ──

  /** 收到一個匯流排事件:送給所有訂閱且啟用的 webhook。回傳的 promise 完成 = 這次都送完
   *  (含記錄/入佇列),測試可 await。 */
  dispatchEvent(ev: AgentEvent): Promise<void> {
    if (!this.featureEnabledFn()) return Promise.resolve();
    const cfg = readConfig(this.store, ev.instanceId);
    const matched = cfg.webhooks.filter((w) => w.enabled && eventMatches(w.events, ev.type));
    if (!matched.length) return Promise.resolve();
    const name = this.store.get(ev.instanceId)?.name ?? ev.instanceId;
    // 每個 webhook 平行送出、且「不在網路請求期間佔序列化鎖」——一筆慢(甚至 timeout)不會拖垮
    // 其他 webhook 或後續事件;只在寫 runtime 狀態(記錄/入佇列)時才短暫佔鎖避免並行互蓋。
    return Promise.all(
      matched.map(async (wh) => {
        const env: WebhookEnvelope = {
          id: genId(wh.id), // delivery id 以 webhook id 為前綴,方便回查該 webhook 的送出紀錄
          type: ev.type,
          specVersion: WEBHOOK_SPEC_VERSION,
          instance: { id: ev.instanceId, name },
          occurredAt: ev.occurredAt,
          data: ev.data,
        };
        const res = await deliver(wh, env, this.agentVersion);
        await this.serialize(ev.instanceId, async () => {
          const rt = readRuntime(this.store, ev.instanceId);
          this.record(rt, env, res, 1);
          if (!res.ok) {
            rt.queue.push({
              webhookId: wh.id,
              envelope: env,
              attempts: 1,
              nextAttemptAt: Date.now() + backoffMs(1),
              firstTriedAt: Date.now(),
            });
          }
          writeRuntime(this.store, ev.instanceId, rt);
        });
      }),
    ).then(() => {});
  }

  private async retryTick(): Promise<void> {
    if (!this.featureEnabledFn()) return;
    const now = Date.now();
    for (const rec of this.store.list()) {
      await this.serialize(rec.id, async () => {
        const rt = readRuntime(this.store, rec.id);
        if (!rt.queue.length) return;
        const cfg = readConfig(this.store, rec.id);
        const keep: QueuedDelivery[] = [];
        let changed = false;
        for (const entry of rt.queue) {
          if (entry.nextAttemptAt > now) {
            keep.push(entry);
            continue;
          }
          changed = true;
          const wh = cfg.webhooks.find((w) => w.id === entry.webhookId);
          if (!wh || !wh.enabled) continue; // webhook 已刪/停用 → 丟棄
          if (now - entry.firstTriedAt > MAX_QUEUE_AGE_MS) {
            this.record(rt, entry.envelope, { ok: false, error: "gave up (max age)" }, entry.attempts);
            continue;
          }
          const res = await deliver(wh, entry.envelope, this.agentVersion);
          const attempts = entry.attempts + 1;
          this.record(rt, entry.envelope, res, attempts);
          if (!res.ok && attempts < MAX_ATTEMPTS) {
            keep.push({ ...entry, attempts, nextAttemptAt: now + backoffMs(attempts) });
          }
        }
        if (changed) {
          rt.queue = keep;
          writeRuntime(this.store, rec.id, rt);
        }
      });
    }
  }

  private record(rt: Runtime, env: WebhookEnvelope, res: DeliverResult, attempts: number): void {
    rt.deliveries.push({
      deliveryId: env.id,
      event: env.type,
      at: new Date().toISOString(),
      ok: res.ok,
      status: res.status,
      error: res.error,
      attempts,
    });
    if (rt.deliveries.length > MAX_DELIVERIES) rt.deliveries = rt.deliveries.slice(-MAX_DELIVERIES);
  }

  // ── config CRUD(給 routes 用;皆經 serialize 排隊)──

  list(id: string): WebhookConfigPublic[] {
    const rt = readRuntime(this.store, id);
    return readConfig(this.store, id).webhooks.map((w) => toPublic(w, rt));
  }

  create(
    id: string,
    input: { url: string; events: string[]; format?: WebhookFormat; label?: string; enabled?: boolean },
  ): Promise<{ config: WebhookConfigPublic; secret: string }> {
    return this.serialize(id, async () => {
      const cfg = readConfig(this.store, id);
      const secret = genSecret();
      const wh: StoredWebhook = {
        id: genId("wh", 8),
        label: input.label,
        url: input.url,
        events: input.events,
        format: input.format ?? "generic",
        enabled: input.enabled ?? true,
        createdAt: new Date().toISOString(),
        secret,
      };
      cfg.webhooks.push(wh);
      writeConfig(this.store, id, cfg);
      return { config: toPublic(wh, readRuntime(this.store, id)), secret };
    });
  }

  update(
    id: string,
    whId: string,
    patch: Partial<Pick<WebhookConfig, "url" | "events" | "format" | "enabled" | "label">>,
  ): Promise<WebhookConfigPublic | null> {
    return this.serialize(id, async () => {
      const cfg = readConfig(this.store, id);
      const wh = cfg.webhooks.find((w) => w.id === whId);
      if (!wh) return null;
      if (patch.url !== undefined) wh.url = patch.url;
      if (patch.events !== undefined) wh.events = patch.events;
      if (patch.format !== undefined) wh.format = patch.format;
      if (patch.enabled !== undefined) wh.enabled = patch.enabled;
      if (patch.label !== undefined) wh.label = patch.label;
      writeConfig(this.store, id, cfg);
      return toPublic(wh, readRuntime(this.store, id));
    });
  }

  remove(id: string, whId: string): Promise<boolean> {
    return this.serialize(id, async () => {
      const cfg = readConfig(this.store, id);
      const before = cfg.webhooks.length;
      cfg.webhooks = cfg.webhooks.filter((w) => w.id !== whId);
      if (cfg.webhooks.length === before) return false;
      writeConfig(this.store, id, cfg);
      return true;
    });
  }

  rotateSecret(id: string, whId: string): Promise<{ secret: string } | null> {
    return this.serialize(id, async () => {
      const cfg = readConfig(this.store, id);
      const wh = cfg.webhooks.find((w) => w.id === whId);
      if (!wh) return null;
      wh.secret = genSecret();
      writeConfig(this.store, id, cfg);
      return { secret: wh.secret };
    });
  }

  deliveries(id: string, whId: string, limit = 50): WebhookDelivery[] {
    return readRuntime(this.store, id)
      .deliveries.filter((del) => del.deliveryId.startsWith(whId))
      .slice(-limit)
      .reverse();
  }

  /** 送一則 webhook.ping 測試給指定 webhook(不經匯流排)。回傳送出結果。 */
  testSend(id: string, whId: string): Promise<DeliverResult | null> {
    return this.serialize(id, async () => {
      const cfg = readConfig(this.store, id);
      const wh = cfg.webhooks.find((w) => w.id === whId);
      if (!wh) return null;
      const name = this.store.get(id)?.name ?? id;
      const env: WebhookEnvelope = {
        id: genId(wh.id),
        type: "webhook.ping",
        specVersion: WEBHOOK_SPEC_VERSION,
        instance: { id, name },
        occurredAt: new Date().toISOString(),
        data: {},
      };
      const res = await deliver(wh, env, this.agentVersion);
      const rt = readRuntime(this.store, id);
      this.record(rt, env, res, 1);
      writeRuntime(this.store, id, rt);
      return res;
    });
  }

  /** 已授權且有啟用中的 webhook 訂閱到 `types` 任一事件 —— 背景 tracker 用它決定要不要追。 */
  private wantsAny(id: string, types: WebhookEventType[]): boolean {
    if (!this.featureEnabledFn()) return false;
    return readConfig(this.store, id).webhooks.some(
      (w) => w.enabled && types.some((t) => eventMatches(w.events, t)),
    );
  }

  /** log-event-tracker 的 wants(id):訂閱 player log 事件(chat/death/capture)。 */
  wantsLogEvents(id: string): boolean {
    return this.wantsAny(id, ["player.chat", "player.death", "player.capture"]);
  }

  /** boss-event-tracker 的 wants(id):訂閱 boss 事件(killed/respawn)。 */
  wantsBossEvents(id: string): boolean {
    return this.wantsAny(id, ["boss.killed", "boss.respawn"]);
  }
}
