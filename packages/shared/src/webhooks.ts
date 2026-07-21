/**
 * Webhook 對外合約(agent 與 web、以及第三方 bot 共用的型別與常數)。
 *
 * 這份是「開發者合約」的真相來源:事件信封、事件型別、payload 形狀、訂閱比對規則。
 * 破壞性改動才升 specVersion 的 major;新增欄位 / 事件型別不升。
 */

export const WEBHOOK_SPEC_VERSION = "1.0";

// ── 事件型別 ────────────────────────────────────────────────────────────

export type WebhookEventType =
  | "player.join"
  | "player.leave"
  | "player.chat"
  | "player.death"
  | "player.capture"
  | "server.starting"
  | "server.running"
  | "server.exited"
  | "server.crash"
  | "server.restart"
  | "server.startup_failure"
  | "server.update_available"
  | "boss.killed"
  | "boss.respawn"
  | "backup.completed"
  | "backup.failed"
  | "webhook.ping";

export interface WebhookEventDef {
  type: WebhookEventType;
  label: string;
  /** 事件來源是否需要額外環境(供 UI 標註,避免使用者以為必收得到)。 */
  requires?: "log" | "paldefender" | "boss-mod";
}

export interface WebhookEventGroup {
  namespace: string;
  label: string;
  events: WebhookEventDef[];
}

/** 事件目錄(UI 分組勾選 + 文件用)。 */
export const WEBHOOK_EVENT_CATALOG: WebhookEventGroup[] = [
  {
    namespace: "player",
    label: "玩家",
    events: [
      { type: "player.join", label: "玩家加入" },
      { type: "player.leave", label: "玩家離開" },
      { type: "player.chat", label: "聊天訊息", requires: "log" },
      { type: "player.death", label: "玩家死亡", requires: "log" },
      { type: "player.capture", label: "捕捉帕魯", requires: "log" },
    ],
  },
  {
    namespace: "server",
    label: "伺服器",
    events: [
      { type: "server.starting", label: "啟動中" },
      { type: "server.running", label: "已上線" },
      { type: "server.exited", label: "已停止" },
      { type: "server.crash", label: "崩潰" },
      { type: "server.restart", label: "重啟" },
      { type: "server.startup_failure", label: "啟動失敗" },
      { type: "server.update_available", label: "有新版本" },
    ],
  },
  {
    namespace: "boss",
    label: "頭目",
    events: [
      { type: "boss.killed", label: "頭目被擊殺", requires: "boss-mod" },
      { type: "boss.respawn", label: "頭目重生", requires: "boss-mod" },
    ],
  },
  {
    namespace: "backup",
    label: "備份",
    events: [
      { type: "backup.completed", label: "備份完成" },
      { type: "backup.failed", label: "備份失敗" },
    ],
  },
];

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = WEBHOOK_EVENT_CATALOG.flatMap((g) =>
  g.events.map((e) => e.type),
);

// ── 事件 payload(信封的 data 欄位) ────────────────────────────────────

export interface PlayerJoinData {
  userId: string;
  name: string;
  level?: number;
  ping?: number;
}
export interface PlayerLeaveData {
  userId: string;
  name: string;
}
export interface PlayerChatData {
  name: string;
  channel: string;
  message: string;
}
export interface PlayerDeathData {
  name: string;
  cause: string;
  /** 野生帕魯擊殺時的帕魯名。 */
  pal?: string;
}
export interface PlayerCaptureData {
  name: string;
  pal: string;
}
export interface ServerStatusData {
  status?: string;
  version?: string;
  code?: number;
  detail?: string;
}
export interface ServerRestartData {
  reason: "scheduled" | "memory" | "crash" | "manual" | "startup-failure";
  ok: boolean;
  detail?: string;
}
export interface ServerUpdateData {
  current: string;
  latest: string;
}
export interface BossEventData {
  bossId: string;
  name?: string;
}
export interface BackupEventData {
  path?: string;
  sizeBytes?: number;
  error?: string;
}

// ── 事件信封 ────────────────────────────────────────────────────────────

export interface WebhookEnvelope<T = unknown> {
  /** 唯一投遞 id;亦放進 X-Palserver-Delivery header,消費端拿來去重。 */
  id: string;
  type: WebhookEventType;
  specVersion: string;
  instance: { id: string; name: string };
  /** 事件發生時間(ISO8601)。 */
  occurredAt: string;
  data: T;
}

// ── Webhook 設定 ────────────────────────────────────────────────────────

export type WebhookFormat = "generic" | "discord";

export interface WebhookConfig {
  id: string;
  label?: string;
  url: string;
  /** 訂閱的事件:精確型別、命名空間萬用字元(如 "player.*")或全部("*")。 */
  events: string[];
  format: WebhookFormat;
  enabled: boolean;
  createdAt: string;
  lastDelivery?: WebhookDeliveryResult;
}

/** 回給前端的形狀:不含 secret,只回是否已設。 */
export interface WebhookConfigPublic extends Omit<WebhookConfig, never> {
  secretSet: boolean;
}

export interface WebhookDeliveryResult {
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** 送出日誌單筆(供 UI 除錯 / 手動重送)。 */
export interface WebhookDelivery extends WebhookDeliveryResult {
  deliveryId: string;
  event: WebhookEventType;
  attempts: number;
}

/** HMAC 簽章 header 名稱(常數化,避免 agent / bot 兩邊拼錯)。 */
export const WEBHOOK_HEADERS = {
  event: "X-Palserver-Event",
  delivery: "X-Palserver-Delivery",
  timestamp: "X-Palserver-Timestamp",
  signature: "X-Palserver-Signature",
} as const;

/**
 * 訂閱是否命中某事件型別。規則:
 *   "*"          → 全部
 *   "player.*"   → 該命名空間全部
 *   "player.chat"→ 精確
 */
export function eventMatches(subscriptions: string[], type: WebhookEventType): boolean {
  return subscriptions.some(
    (s) => s === "*" || s === type || (s.endsWith(".*") && type.startsWith(s.slice(0, -1))),
  );
}

/** 把事件信封轉成 Discord embed payload({embeds:[…]})。agent(webhook format:discord)與官方
 *  bot(同機通知)共用同一份渲染,確保兩條路徑的訊息一致。純函式,不簽章。 */
export function toDiscordPayload(env: WebhookEnvelope): { embeds: unknown[] } {
  const d = env.data as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const COLOR: Partial<Record<WebhookEventType, number>> = {
    "player.join": 0x57d38c,
    "player.leave": 0x9aa4b2,
    "player.chat": 0x5fb0ff,
    "player.death": 0xff6b6b,
    "player.capture": 0xc792ea,
    "server.running": 0x57d38c,
    "server.exited": 0x9aa4b2,
    "server.crash": 0xff5c7a,
    "server.restart": 0xffcf5f,
    "server.startup_failure": 0xff5c7a,
    "boss.killed": 0xf1c40f,
    "boss.respawn": 0xf1c40f,
    "backup.completed": 0x57d38c,
    "backup.failed": 0xff6b6b,
    "webhook.ping": 0x888888,
  };
  const text: Record<string, { title: string; description: string }> = {
    "player.join": { title: "玩家加入", description: `**${s("name")}** 加入了伺服器` },
    "player.leave": { title: "玩家離開", description: `**${s("name")}** 離開了伺服器` },
    "player.chat": { title: "聊天", description: `**${s("name")}**〔${s("channel")}〕${s("message")}` },
    "player.death": {
      title: "玩家死亡",
      description: d.pal
        ? `**${s("name")}** 被野生 ${s("pal")} 擊殺`
        : `**${s("name")}** 死亡:${s("cause")}`,
    },
    "player.capture": { title: "捕捉帕魯", description: `**${s("name")}** 捕捉了 ${s("pal")}` },
    "server.starting": { title: "伺服器啟動中", description: "" },
    "server.running": { title: "伺服器已上線", description: s("version") },
    "server.exited": { title: "伺服器已停止", description: "" },
    "server.crash": { title: "伺服器崩潰", description: s("detail") },
    "server.restart": {
      title: "伺服器重啟",
      description: `原因:${s("reason")}(${d.ok ? "成功" : "失敗"})`,
    },
    "server.startup_failure": { title: "啟動失敗", description: s("detail") },
    "server.update_available": {
      title: "有新版本",
      description: s("latest") ? `${s("current")} → ${s("latest")}` : `目前 ${s("current")},有可用更新`,
    },
    "boss.killed": { title: "頭目被擊殺", description: s("name") },
    "boss.respawn": { title: "頭目重生", description: s("name") },
    "backup.completed": { title: "備份完成", description: s("path") },
    "backup.failed": { title: "備份失敗", description: s("error") },
    "webhook.ping": { title: "Webhook 測試", description: "設定成功,這是一則測試訊息。" },
  };
  const t = text[env.type] ?? { title: env.type, description: "" };
  return {
    embeds: [
      {
        title: t.title,
        description: t.description || undefined,
        color: COLOR[env.type] ?? 0x5865f2,
        timestamp: env.occurredAt,
        footer: { text: env.instance.name },
      },
    ],
  };
}
