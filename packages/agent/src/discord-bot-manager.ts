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
  type WebhookEnvelope,
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
  "notifyChannelId",
  "notifyEvents",
] as const satisfies readonly (keyof DiscordBotSettings)[];

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
}

/**
 * 同機 Discord bot 生命週期管理:每實例 { enabled, token, adminUserIds, notify… } 存
 * <instanceDir>/discord-bot.json,enabled + 有 token + 已授權時 self-fork 一個 bot 子行程
 * (env PALSERVER_RUN_BOT=1),崩潰按退避重啟,設定變更(token/admin)就殺舊起新。
 *
 * 事件通知:本管理器(在 agent 主行程)訂閱事件匯流排,把該實例、且命中 notifyEvents 的事件
 * 渲染成 Discord embed,經 IPC 傳給 bot 子行程貼到 notifyChannelId(bot 用 gateway 貼,免另設 webhook URL)。
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
        settings: { ...DEFAULT_DISCORD_BOT_SETTINGS, ...(raw.settings ?? {}) },
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
      };
      this.runtimes.set(id, r);
    }
    return r;
  }

  private isAlive(r: Runtime | undefined): boolean {
    return !!r?.child && r.child.exitCode === null && !r.child.killed;
  }

  /** 影響子行程 env 的設定簽章:只有這些變了才需要重啟 bot 套用(notify 是 live、不算)。 */
  private spawnSignature(state: StoredState): string {
    return `${state.token ?? ""}|${(state.settings.adminUserIds ?? []).join(",")}`;
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
    // stdio 第 4 個是 IPC:agent 主行程用它把事件通知傳給 bot 子行程(child.send)。
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      // 不 detached:bot 隨 agent 一起活/死。孤兒 bot 控制著可能已停的伺服器是錯的,也免去 pid re-adopt。
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "pipe", "ipc"],
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
      },
    });
    r.child = child;
    r.starting = false;
    r.stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      const cur = this.rt(id);
      cur.stderrTail = (cur.stderrTail + d.toString()).slice(-4000);
      process.stderr.write(d);
    });

    child.on("error", (err) => {
      const cur = this.rt(id);
      cur.lastError = `無法啟動 bot 子行程:${err.message}`;
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

  /** 事件匯流排回呼:把該實例、命中 notifyEvents 的事件渲染成 embed,經 IPC 交給 bot 子行程貼出。 */
  private forwardEvent(ev: AgentEvent): void {
    const r = this.runtimes.get(ev.instanceId);
    if (!r || !this.isAlive(r) || !r.child?.connected) return;
    const state = this.readState(ev.instanceId);
    const channelId = state.settings.notifyChannelId;
    if (!channelId || !eventMatches(state.settings.notifyEvents ?? [], ev.type)) return;
    const env: WebhookEnvelope = {
      id: `evt_${crypto.randomUUID()}`,
      type: ev.type,
      specVersion: WEBHOOK_SPEC_VERSION,
      instance: { id: ev.instanceId, name: this.store.get(ev.instanceId)?.name ?? ev.instanceId },
      occurredAt: ev.occurredAt,
      data: ev.data,
    };
    const msg: BotNotifyMessage = { kind: "notify", channelId, payload: toDiscordPayload(env) };
    try {
      r.child.send(msg);
    } catch {
      /* IPC 可能剛好關閉:忽略,下次事件再說 */
    }
  }
}
