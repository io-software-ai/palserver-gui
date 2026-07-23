import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DISCORD_BOT_SETTINGS,
  eventMatches,
  toDiscordPayload,
  WEBHOOK_SPEC_VERSION,
  type DiscordBotSettings,
  type DiscordBotStatus,
  type DiscordBotLogLine,
  type WebhookEnvelope,
  type WebhookEventType,
} from "@palserver/shared";
import { onAgentEvent, type AgentEvent } from "./events.js";
import { featureEnabled } from "./license.js";
import type { InstanceStore } from "./store.js";

/** 磁碟形狀 —— settings 是前端可見部分,token 只在 agent 端,絕不回前端(見 status())。 */
interface StoredState {
  settings: DiscordBotSettings;
  token?: string;
}

/** 前端 PATCH 能改的 setting;token 走 update() 的專屬路徑,不在白名單。 */
const PATCHABLE_KEYS = [
  "enabled",
  "adminUserIds",
  "notifyRoutes",
  "statusChannelId",
  "language",
] as const satisfies readonly (keyof DiscordBotSettings)[];

/** 舊設定(單一 notifyChannelId + notifyEvents)→ 新的 notifyRoutes[]。已有 notifyRoutes 就原樣;
 *  否則若磁碟上還有舊的頻道+事件,合成一條路由。就地相容,不寫回磁碟(下次 update 才落地新形狀)。 */
function migrateBotSettings(s: DiscordBotSettings): DiscordBotSettings {
  if (!Array.isArray(s.notifyRoutes)) s = { ...s, notifyRoutes: [] };
  if (s.notifyRoutes.length > 0) return s;
  const legacy = s as DiscordBotSettings & { notifyChannelId?: string; notifyEvents?: string[] };
  if (legacy.notifyChannelId && legacy.notifyEvents && legacy.notifyEvents.length > 0) {
    return { ...s, notifyRoutes: [{ channelId: legacy.notifyChannelId, events: legacy.notifyEvents }] };
  }
  return s;
}

type DiscordBotPatch = Partial<DiscordBotSettings> & { token?: string };

/** 傳給 bot 子行程的通知訊息(agent → bot,走 IPC)。 */
export interface BotNotifyMessage {
  kind: "notify";
  channelId: string;
  payload: { embeds: unknown[] };
}

// 崩潰重啟:滑動視窗計數 + 退避。bot 崩潰(尤其 token 無效)會秒退,比遊戲伺服器快很多,
// 所以視窗短、上限略高;達上限就停,要人工重新啟用(避免無限 spawn 迴圈)。
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 10;
const MAX_BACKOFF_MS = 30_000;

interface Runtime {
  child?: ChildProcess;
  starting: boolean;
  /** 因設定變更/停用而主動 kill —— exit handler 看到就不重啟。 */
  intentionalStop: boolean;
  /** 主動 kill 是為了「換設定重啟」(而非停用)—— exit 後要重新拉起。 */
  restartRequested: boolean;
  /** spawn 當下的「影響 env 的設定」簽章(token + adminIds);變了才需要重啟套用。 */
  spawnSig: string;
  restartTimer?: NodeJS.Timeout;
  /** 近期非預期退出時間戳(ms),用來套滑動視窗上限。 */
  recentExits: number[];
  /** 擷取子行程 stderr 尾段(~4KB),退出時把最後一行併進 lastError,讓 GUI 看得到真正原因。 */
  stderrTail: string;
  lastError?: string;
  /** bot 子行程輸出的環形緩衝(stdout+stderr,供 GUI 日誌檢視);跨重啟保留,只受行數上限約束。 */
  logs: DiscordBotLogLine[];
  /** stdout/stderr 尚未遇到換行的殘段(chunk 不對齊行邊界)。 */
  outPartial: string;
  errPartial: string;
}

const MAX_LOG_LINES = 300;

/**
 * 同機 Discord bot 生命週期管理:每實例 { enabled, token, adminUserIds, notify… } 存
 * <instanceDir>/discord-bot.json,enabled + 有 token + 已授權時 self-fork 一個 bot 子行程
 * (env PALSERVER_RUN_BOT=1),崩潰按退避重啟,設定變更(token/admin)就殺舊起新。
 *
 * 事件通知:本管理器(在 agent 主行程)訂閱事件匯流排,把該實例、且命中任一 notifyRoutes 路由的事件
 * 渲染成 Discord embed,經 IPC 傳給 bot 子行程貼到該路由的頻道(可多條路由 → 多頻道;bot 用 gateway 貼,免另設 webhook URL)。
 *
 * 慣例對照:持久化仿 public-map.ts;spawn + exit handler 仿 native.ts spawnServer;
 * 崩潰重啟的滑動視窗上限仿 supervisor.ts handleCrash(另加退避,因 bot 崩潰更快)。
 */
export class DiscordBotManager {
  private runtimes = new Map<string, Runtime>();
  private unsubscribe?: () => void;

  constructor(
    private store: InstanceStore,
    /** bot 子行程回控用的 agent base URL(loopback,含 scheme+port)。 */
    private agentLoopbackUrl: string,
    /** 授權判斷注入點(測試用);預設走 license 模組,與 webhook 同一個閘門。 */
    private featureEnabledFn: () => boolean = () => featureEnabled("webhooks"),
  ) {}

  // ── 持久化(仿 public-map) ──────────────────────────────────────────────
  private stateFile(id: string): string {
    return path.join(this.store.instanceDir(id), "discord-bot.json");
  }

  private readState(id: string): StoredState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile(id), "utf8")) as Partial<StoredState>;
      return {
        settings: migrateBotSettings({ ...DEFAULT_DISCORD_BOT_SETTINGS, ...(raw.settings ?? {}) }),
        token: typeof raw.token === "string" ? raw.token : undefined,
      };
    } catch {
      return { settings: { ...DEFAULT_DISCORD_BOT_SETTINGS } };
    }
  }

  private writeState(id: string, state: StoredState): void {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.stateFile(id), JSON.stringify(state, null, 2));
  }

  private rt(id: string): Runtime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = {
        starting: false,
        intentionalStop: false,
        restartRequested: false,
        spawnSig: "",
        recentExits: [],
        stderrTail: "",
        logs: [],
        outPartial: "",
        errPartial: "",
      };
      this.runtimes.set(id, r);
    }
    return r;
  }

  private isAlive(r: Runtime | undefined): boolean {
    return !!r?.child && r.child.exitCode === null && !r.child.killed;
  }

  /** 把子行程一段輸出切成行、推進環形緩衝(cap MAX_LOG_LINES),並原樣轉寫到本行程對應串流。 */
  private captureOutput(r: Runtime, level: "info" | "error", chunk: Buffer): void {
    (level === "error" ? process.stderr : process.stdout).write(chunk);
    const key = level === "error" ? "errPartial" : "outPartial";
    const combined = r[key] + chunk.toString();
    const parts = combined.split(/\r?\n/);
    r[key] = parts.pop() ?? ""; // 最後一段可能不完整,留到下次
    const now = Date.now();
    for (const line of parts) {
      if (line.trim()) r.logs.push({ at: now, level, line });
    }
    if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
  }

  private pushLog(r: Runtime, level: "info" | "error", line: string): void {
    r.logs.push({ at: Date.now(), level, line });
    if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
  }

  /** GUI 日誌檢視:回傳 bot 子行程近期輸出(時間序)。 */
  logs(id: string): DiscordBotLogLine[] {
    return this.runtimes.get(id)?.logs ?? [];
  }

  /** 影響子行程 env 的設定簽章:只有這些變了才需要重啟 bot 套用(notify 是 live、不算)。 */
  private spawnSignature(state: StoredState): string {
    return `${state.token ?? ""}|${(state.settings.adminUserIds ?? []).join(",")}|${state.settings.statusChannelId ?? ""}|${state.settings.language}`;
  }

  // ── 對外 API(routes 用) ────────────────────────────────────────────────
  /** GET 回應:含 tokenSet(有無 token)但永不含 token 本身。 */
  status(id: string): DiscordBotStatus {
    const state = this.readState(id);
    const r = this.runtimes.get(id);
    return {
      settings: state.settings,
      tokenSet: typeof state.token === "string" && state.token.length > 0,
      running: this.isAlive(r),
      lastError: r?.lastError,
    };
  }

  /** PUT:套用可寫 settings(白名單)與 token(專屬路徑),持久化後 reconcile。 */
  update(id: string, patch: DiscordBotPatch): DiscordBotStatus {
    const state = this.readState(id);
    const target = state.settings as unknown as Record<string, unknown>;
    for (const key of PATCHABLE_KEYS) {
      const value = patch[key];
      if (value !== undefined) target[key] = value;
    }
    // token 有給才動:非空 = 設定/更新;空字串 = 清除;沒給 = 保留原本(避免 PATCH 抹掉既有 token)。
    if (patch.token !== undefined) {
      const trimmed = patch.token.trim();
      state.token = trimmed ? trimmed : undefined;
    }
    this.writeState(id, state);
    // 設定變了 → 重置崩潰計數與錯誤,重新判斷該不該跑 / 是否需重啟套用新 token·admin。
    const r = this.rt(id);
    r.recentExits = [];
    r.lastError = undefined;
    this.reconcile(id);
    return this.status(id);
  }

  // ── 監督 ────────────────────────────────────────────────────────────────
  /** agent 開機時呼叫:訂閱事件匯流排(通知用)+ 對每個已 enabled 的實例把 bot 起起來。 */
  start(): void {
    if (!this.unsubscribe) this.unsubscribe = onAgentEvent((ev) => this.forwardEvent(ev));
    for (const rec of this.store.list()) this.reconcile(rec.id);
  }

  /** agent 關閉時呼叫:停掉所有 bot 子行程(不 detached,但仍顯式收掉以防孤兒)。 */
  stopAll(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of [...this.runtimes.keys()]) this.stopBot(id);
  }

  /** 讓實際執行狀態趨近設定:enabled + 有 token + 已授權 → 該跑;否則 → 該停;
   *  已在跑但 token/admin 變了 → 殺舊起新(換 env)。notify 設定是 live,不需重啟。 */
  private reconcile(id: string): void {
    const state = this.readState(id);
    const shouldRun = state.settings.enabled && !!state.token && this.featureEnabledFn();
    const r = this.rt(id);
    if (!shouldRun) {
      if (this.isAlive(r) || r.restartTimer) this.stopBot(id);
      return;
    }
    if (!this.isAlive(r)) {
      if (!r.starting) this.spawnBot(id);
      return;
    }
    // 已在跑:token/admin 變了才重啟套用。
    if (this.spawnSignature(state) !== r.spawnSig) {
      r.restartRequested = true;
      this.stopBot(id); // exit handler 見 restartRequested 會重拉
    }
  }

  private spawnBot(id: string): void {
    const state = this.readState(id);
    const token = state.token;
    if (!token) return;
    const r = this.rt(id);
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = undefined;
    }
    r.starting = true;
    r.intentionalStop = false;
    r.spawnSig = this.spawnSignature(state);

    // 自我 re-exec:帶上 process.execArgv 再接 argv.slice(1)。
    //   SEA/exe:execArgv=[] → 等於重跑自己這顆 exe;`node dist/index.js`:重跑該檔;
    //   dev(tsx watch):execArgv 含 tsx loader(如 --import tsx)→ 保留它才能重跑 .ts,否則 node 不認得 .ts 秒退。
    // 護欄:子行程帶 PALSERVER_RUN_BOT=1,主入口據此只跑 bot 分支、不會再進到這裡 spawn(見 index.ts 開頭)。
    // stdio:stdout/stderr 都 pipe 起來收進日誌環形緩衝(GUI 可看);第 4 個是 IPC(child.send 傳通知)。
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      // 不 detached:bot 隨 agent 一起活/死。孤兒 bot 控制著可能已停的伺服器是錯的,也免去 pid re-adopt。
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        PALSERVER_RUN_BOT: "1",
        DISCORD_TOKEN: token,
        AGENT_URL: this.agentLoopbackUrl,
        AGENT_INSTANCE_ID: id,
        // 同機連 loopback 免 token —— 清掉可能繼承來的 AGENT_TOKEN,避免誤帶。
        AGENT_TOKEN: "",
        // 管理員白名單(whitelist-only):逗號分隔的 Discord user id。
        DISCORD_ADMIN_IDS: (state.settings.adminUserIds ?? []).join(","),
        // 狀態面板頻道(留空 = 不顯示)。
        DISCORD_STATUS_CHANNEL_ID: state.settings.statusChannelId ?? "",
        DISCORD_LANG: state.settings.language,
      },
    });
    r.child = child;
    r.starting = false;
    r.stderrTail = "";
    r.outPartial = "";
    r.errPartial = "";
    this.pushLog(r, "info", `── bot 啟動(${new Date().toISOString()})──`);
    child.stdout?.on("data", (d: Buffer) => this.captureOutput(this.rt(id), "info", d));
    child.stderr?.on("data", (d: Buffer) => {
      const cur = this.rt(id);
      cur.stderrTail = (cur.stderrTail + d.toString()).slice(-4000);
      this.captureOutput(cur, "error", d);
    });

    child.on("error", (err) => {
      const cur = this.rt(id);
      cur.lastError = `無法啟動 bot 子行程:${err.message}`;
      this.pushLog(cur, "error", cur.lastError);
    });

    child.on("exit", (code, signal) => {
      const cur = this.rt(id);
      if (cur.child === child) cur.child = undefined; // identity guard:別讓舊 child 的 exit 清掉新 child
      if (cur.intentionalStop) {
        cur.intentionalStop = false;
        if (cur.restartRequested) {
          cur.restartRequested = false;
          this.reconcile(id); // 換 token/admin 的重啟
        }
        return; // 主動停用/改設定造成的退出 —— 不當崩潰
      }
      // 非預期退出 = 崩潰(含 token 無效秒退):記時間、套滑動視窗上限 + 退避後重啟。
      const now = Date.now();
      cur.recentExits = cur.recentExits.filter((t) => now - t < RESTART_WINDOW_MS);
      cur.recentExits.push(now);
      // 取 stderr 最後一行非空內容當原因(如「登入失敗: An invalid token was provided.」)。
      const detail = cur.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop();
      const base = `bot 子行程結束(code=${code ?? "?"}${signal ? `, signal=${signal}` : ""})`;
      cur.lastError = detail ? `${base}:${detail}` : base;
      if (cur.recentExits.length >= MAX_RESTARTS_PER_WINDOW) {
        cur.lastError = `bot 短時間內重啟過多(${cur.recentExits.length} 次)已停止自動重啟,請確認 token 是否正確後重新啟用。${detail ? `最後錯誤:${detail}` : ""}`;
        return;
      }
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (cur.recentExits.length - 1));
      cur.restartTimer = setTimeout(() => {
        cur.restartTimer = undefined;
        this.reconcile(id);
      }, backoff);
      cur.restartTimer.unref();
    });
  }

  private stopBot(id: string): void {
    const r = this.rt(id);
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = undefined;
    }
    r.recentExits = [];
    if (this.isAlive(r) && r.child) {
      r.intentionalStop = true;
      try {
        r.child.kill();
      } catch {
        /* 已結束 */
      }
    }
  }

  /** 事件匯流排回呼:把該實例、命中任一 notifyRoute 的事件渲染成 embed,經 IPC 交給 bot 子行程
   *  貼到每一條命中路由的頻道(多條路由訂同一事件 → 貼多個頻道;同頻道去重避免貼兩次)。 */
  private forwardEvent(ev: AgentEvent): void {
    const r = this.runtimes.get(ev.instanceId);
    if (!r || !this.isAlive(r) || !r.child?.connected) return;
    const state = this.readState(ev.instanceId);
    const channelIds = new Set(
      state.settings.notifyRoutes
        .filter((route) => route.channelId && eventMatches(route.events ?? [], ev.type))
        .map((route) => route.channelId),
    );
    if (channelIds.size === 0) return;
    const env: WebhookEnvelope = {
      id: `evt_${crypto.randomUUID()}`,
      type: ev.type,
      specVersion: WEBHOOK_SPEC_VERSION,
      instance: { id: ev.instanceId, name: this.store.get(ev.instanceId)?.name ?? ev.instanceId },
      occurredAt: ev.occurredAt,
      data: ev.data,
    };
    const payload = toDiscordPayload(env, state.settings.language);
    for (const channelId of channelIds) {
      const msg: BotNotifyMessage = { kind: "notify", channelId, payload };
      try {
        r.child.send(msg);
      } catch {
        /* IPC 可能剛好關閉:忽略,下次事件再說 */
      }
    }
  }

  /** 背景追蹤器的 wants(id):bot 已授權、已啟用,且有任一條「設了頻道」的路由訂閱到對應事件。
   *  與 forwardEvent 投遞條件對齊(不納入「子行程需在線」的 live 狀態,避免 bot 重啟時追蹤器抖動)。
   *  沒有這個,只設 bot、未設對應 webhook 時 chat/boss 追蹤器不會啟動 → bot 永遠收不到 chat/boss。 */
  private wantsAny(id: string, types: WebhookEventType[]): boolean {
    if (!this.featureEnabledFn()) return false;
    const { settings } = this.readState(id);
    if (!settings.enabled) return false;
    return settings.notifyRoutes.some(
      (route) => route.channelId && types.some((t) => eventMatches(route.events ?? [], t)),
    );
  }

  /** log-event-tracker 的 wants:訂閱 player log 事件(chat/death/capture)。 */
  wantsLogEvents(id: string): boolean {
    return this.wantsAny(id, ["player.chat", "player.death", "player.capture"]);
  }

  /** boss-event-tracker 的 wants:訂閱 boss 事件(killed/respawn)。 */
  wantsBossEvents(id: string): boolean {
    return this.wantsAny(id, ["boss.killed", "boss.respawn"]);
  }
}
