import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_RESTART_POLICY,
  type RestartEvent,
  type RestartPolicy,
  type RestartReason,
} from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceStore, InstanceRecord } from "./store.js";
import { rest } from "./restapi.js";
import { getPalDefenderConfig } from "./paldefender-config.js";
import { newestPalDefenderLogLines } from "./native.js";

/**
 * Automatic restarts, three triggers:
 *  - scheduled: every N minutes, or at fixed times of day
 *  - memory:    sustained above a threshold (a single spike won't trip it)
 *  - crash:     the process exited on its own while we expected it up
 *
 * Planned restarts (scheduled/memory) warn players over the REST API and ask
 * the server to save first. Crash restarts skip that — the server is already
 * gone — and are rate-limited so a server that dies on boot doesn't get
 * restarted forever.
 */

/** How often policies are evaluated. Overridable to speed up tests. */
const TICK_MS = Number(process.env.PALSERVER_SUPERVISOR_TICK_MS ?? 30_000);
const MAX_EVENTS = 50;
const MAX_ANNOUNCE_SECONDS = 300;
/** A native server that exits within this window of starting never really came
 * up — a boot failure, not a mid-game crash. Palworld's own boot takes ~30-60s. */
const BOOT_GRACE_MS = 120_000;
/** After a graceful REST /shutdown (waittime 10s), how long we poll for the old
 * process to actually exit before force-stopping. Big worlds flush saves on the
 * way out, so this needs headroom beyond the announced waittime. */
const SHUTDOWN_EXIT_TIMEOUT_MS = 60_000;

interface SupervisorState {
  /** we last observed it running, so an "exited" now means it crashed */
  wasRunning: boolean;
  /** when we last (re)started the process — anchors boot-failure detection */
  lastStartAt?: string;
  /** consecutive checks over the memory threshold */
  memoryStreak: number;
  /** ISO timestamps of recent restarts, for rate limiting */
  recentRestarts: string[];
  /** anchors the "interval" schedule */
  lastScheduledAt?: string;
  /** guards against firing a daily time twice within its minute */
  lastDailyFire?: string;
  events: RestartEvent[];
}

const emptyState = (): SupervisorState => ({
  wasRunning: false,
  memoryStreak: 0,
  recentRestarts: [],
  events: [],
});

export class RestartSupervisor {
  private timer: NodeJS.Timeout | null = null;
  /** instances currently mid-restart — skip them until they settle */
  private busy = new Set<string>();

  constructor(
    private store: InstanceStore,
    private driverFor: (rec: InstanceRecord) => ServerDriver,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private policyFile = (id: string) => path.join(this.store.instanceDir(id), "restart-policy.json");
  private stateFile = (id: string) => path.join(this.store.instanceDir(id), "restart-state.json");

  readPolicy(id: string): RestartPolicy {
    try {
      const raw = JSON.parse(fs.readFileSync(this.policyFile(id), "utf8"));
      return {
        ...DEFAULT_RESTART_POLICY,
        ...raw,
        scheduled: { ...DEFAULT_RESTART_POLICY.scheduled, ...raw.scheduled },
        memory: { ...DEFAULT_RESTART_POLICY.memory, ...raw.memory },
        crash: { ...DEFAULT_RESTART_POLICY.crash, ...raw.crash },
      };
    } catch {
      return structuredClone(DEFAULT_RESTART_POLICY);
    }
  }

  writePolicy(id: string, policy: RestartPolicy): RestartPolicy {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.policyFile(id), JSON.stringify(policy, null, 2));
    return policy;
  }

  private readState(id: string): SupervisorState {
    try {
      return { ...emptyState(), ...JSON.parse(fs.readFileSync(this.stateFile(id), "utf8")) };
    } catch {
      return emptyState();
    }
  }

  private writeState(id: string, state: SupervisorState): void {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.stateFile(id), JSON.stringify(state, null, 2));
  }

  events(id: string): RestartEvent[] {
    return [...this.readState(id).events].reverse();
  }

  restartsLastHour(id: string): number {
    return this.recentWithinHour(this.readState(id).recentRestarts).length;
  }

  private recentWithinHour(stamps: string[]): string[] {
    const cutoff = Date.now() - 3_600_000;
    return stamps.filter((s) => Date.parse(s) >= cutoff);
  }

  private record(id: string, state: SupervisorState, event: RestartEvent): void {
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
    this.writeState(id, state);
  }

  /** Fixed times of day: fire once when the clock reaches HH:MM. */
  private dailyDue(policy: RestartPolicy, state: SupervisorState, now: Date): boolean {
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (!policy.scheduled.dailyTimes.includes(hhmm)) return false;
    const key = `${now.toDateString()} ${hhmm}`;
    return state.lastDailyFire !== key;
  }

  private scheduledDue(policy: RestartPolicy, state: SupervisorState, now: Date): boolean {
    if (!policy.scheduled.enabled) return false;
    if (policy.scheduled.mode === "daily") return this.dailyDue(policy, state, now);
    const anchor = state.lastScheduledAt ?? state.recentRestarts.at(-1);
    if (!anchor) return false; // start counting from the first observed tick
    return (now.getTime() - Date.parse(anchor)) / 60_000 >= policy.scheduled.intervalMinutes;
  }

  private async tick(): Promise<void> {
    for (const rec of this.store.list()) {
      // docker: scheduled + memory restart only (crash handled by unless-stopped).
      // native: full crash/memory/scheduled. k8s: scheduled only — STS handles
      // Pod self-heal and "exited" (replicas=0) is a deliberate stop, not crash.
      if (this.busy.has(rec.id)) continue;
      try {
        await this.check(rec);
      } catch {
        // transient (server going down mid-check) — next tick re-evaluates
      }
    }
  }

  private async check(rec: InstanceRecord): Promise<void> {
    const ctx: DriverContext = { instanceDir: this.store.instanceDir(rec.id) };
    const driver = this.driverFor(rec);
    const policy = this.readPolicy(rec.id);
    const state = this.readState(rec.id);
    const now = new Date();
    const { status } = await driver.status(rec, ctx);

    if (status !== "running") {
      // Crashed if we saw it running before and nobody asked us to stop it.
      // k8s is excluded: its STS auto-restarts crashed Pods, and replicas=0
      // ("exited") is a user-initiated stop, not a crash we should fight.
      const crashCandidate = state.wasRunning && status === "exited" && policy.crash.enabled
        && rec.backend === "native";
      if (crashCandidate) {
        // PalDefender's `exitServerOnStartupFailure` makes the server exit on
        // boot when the plugin can't load. That reads as a crash, but restarting
        // just loops until the hourly cap — so detect it and stop with a reason.
        if (this.isStartupFailure(rec, ctx, state, now)) {
          this.handleStartupFailure(rec, ctx, state);
        } else {
          await this.handleCrash(rec, ctx, driver, policy, state);
        }
        return;
      }
      if (state.wasRunning && status !== "exited") {
        state.wasRunning = false;
        this.writeState(rec.id, state);
      }
      return;
    }

    if (!state.wasRunning) {
      state.wasRunning = true;
      state.lastScheduledAt ??= now.toISOString();
      this.writeState(rec.id, state);
    }

    if (this.scheduledDue(policy, state, now)) {
      if (policy.scheduled.mode === "daily") {
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        state.lastDailyFire = `${now.toDateString()} ${hhmm}`;
      }
      await this.restart(rec, ctx, driver, policy, state, "scheduled", "已達排定的重啟時間");
      return;
    }

    if (policy.memory.enabled) {
      const stats = await driver.stats(rec, ctx);
      const memoryMB = stats ? stats.memoryBytes / (1 << 20) : 0;
      state.memoryStreak = memoryMB > policy.memory.thresholdMB ? state.memoryStreak + 1 : 0;
      this.writeState(rec.id, state);

      if (state.memoryStreak >= policy.memory.sustainedChecks) {
        state.memoryStreak = 0;
        await this.restart(
          rec,
          ctx,
          driver,
          policy,
          state,
          "memory",
          `記憶體 ${memoryMB.toFixed(0)} MB 持續超過 ${policy.memory.thresholdMB} MB`,
        );
      }
    }
  }

  /** A crash is really a PalDefender startup abort when: the server died during
   * boot (within the grace window of our last start) AND the user asked
   * PalDefender to exit the server on startup failure. Restarting can't help. */
  private isStartupFailure(
    rec: InstanceRecord,
    ctx: DriverContext,
    state: SupervisorState,
    now: Date,
  ): boolean {
    if (!state.lastStartAt) return false;
    if (now.getTime() - Date.parse(state.lastStartAt) >= BOOT_GRACE_MS) return false;
    try {
      return getPalDefenderConfig(rec, ctx).values.exitServerOnStartupFailure === true;
    } catch {
      return false;
    }
  }

  /** Stop the auto-restart loop and surface why, instead of restarting into the
   * same failure. Sets wasRunning=false so later ticks don't re-flag it. */
  private handleStartupFailure(rec: InstanceRecord, ctx: DriverContext, state: SupervisorState): void {
    state.wasRunning = false;
    // Only quote PalDefender logs written since this boot — the newest file by
    // mtime may be the *previous* process's shutdown tail, which reads like
    // evidence but is just a normal goodbye message.
    const bootMs = state.lastStartAt ? Date.parse(state.lastStartAt) : undefined;
    const hint = newestPalDefenderLogLines(rec, ctx, 1, bootMs)[0];
    this.record(rec.id, state, {
      at: new Date().toISOString(),
      reason: "startup-failure",
      ok: false,
      detail:
        "伺服器在啟動階段即結束,且 PalDefender 已開啟「啟動失敗時關閉伺服器」— 研判為 PalDefender 啟動失敗自我關閉,已停止自動重啟以免無限重啟迴圈。請查看 PalDefender 日誌修正原因,或關閉該選項與崩潰自動重啟其一。"
        + (hint ? ` 最後日誌:${hint}` : "(本次啟動期間沒有 PalDefender 日誌 — 外掛可能未載入,或伺服器在載入外掛前就結束了。)"),
    });
  }

  private async handleCrash(
    rec: InstanceRecord,
    ctx: DriverContext,
    driver: ServerDriver,
    policy: RestartPolicy,
    state: SupervisorState,
  ): Promise<void> {
    const recent = this.recentWithinHour(state.recentRestarts);
    if (recent.length >= policy.crash.maxPerHour) {
      state.wasRunning = false; // stop retrying until someone starts it manually
      state.recentRestarts = recent;
      this.record(rec.id, state, {
        at: new Date().toISOString(),
        reason: "crash",
        ok: false,
        detail: `一小時內已重啟 ${recent.length} 次,達到上限後停止自動重啟`,
      });
      return;
    }

    this.busy.add(rec.id);
    try {
      const started = await driver.start(rec, ctx);
      const at = new Date().toISOString();
      if (started) state.recentRestarts = [...recent, at];
      state.wasRunning = true;
      state.lastStartAt = at;
      this.record(rec.id, state, {
        at,
        reason: "crash",
        ok: true,
        detail: started
          ? `伺服器異常結束,已自動重啟(本小時第 ${recent.length + 1} 次)`
          : "伺服器異常結束,但偵測時已在執行(可能已被手動啟動),略過自動重啟",
      });
    } catch (err) {
      state.recentRestarts = [...recent, new Date().toISOString()];
      this.record(rec.id, state, {
        at: new Date().toISOString(),
        reason: "crash",
        ok: false,
        detail: `自動重啟失敗:${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.busy.delete(rec.id);
    }
  }

  /** Planned restart: warn players, flush the world, then stop and start. */
  async restart(
    rec: InstanceRecord,
    ctx: DriverContext,
    driver: ServerDriver,
    policy: RestartPolicy,
    state: SupervisorState,
    reason: RestartReason,
    detail: string,
  ): Promise<void> {
    this.busy.add(rec.id);
    try {
      // 遊戲內公告用 GUI 儲存設定時寫入的在地化模板;沒存過(舊設定)退回內建繁中。
      // detail 留給重啟紀錄/log(內含動態數字,不進遊戲聊天室)。
      const tpl = policy.announceTemplates;
      const reasonLabel =
        reason === "scheduled" ? tpl?.reasonScheduled ?? "已達排定的重啟時間"
        : reason === "memory" ? tpl?.reasonMemory ?? "記憶體超標"
        : detail;
      const announceMsg = (n: number) =>
        (tpl?.restart ?? "伺服器將在 {n} 秒後重新啟動({reason})")
          .split("{n}").join(String(n))
          .split("{reason}").join(reasonLabel);
      const wait = Math.min(Math.max(policy.announceSeconds, 0), MAX_ANNOUNCE_SECONDS);
      if (wait > 0) {
        await rest
          .announce(rec, announceMsg(wait))
          .catch(() => {}); // REST off — restart anyway, just without warning
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
      // Save and wait for the world to flush to disk. The REST /save
      // endpoint returns 200 immediately but the actual write is async —
      // stopping too soon can corrupt save files. We save, then wait a
      // few seconds before stopping to let the server finish writing.
      await rest.save(rec).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));

      // Remember the old process's identity (native: pid) before asking it to
      // exit — during the wait below this is how we tell "old process still
      // exiting" apart from "someone manually restarted and a NEW process is
      // running", which we must never kill.
      const oldRuntimeId = (await driver.status(rec, ctx)).runtimeId;

      // Try graceful shutdown first (server saves then exits cleanly).
      // Fall back to hard stop if REST is unavailable or shutdown fails.
      const shutdownOk = await rest
        .shutdown(rec, 10, announceMsg(10))
        .then(() => true)
        .catch(() => false);

      if (!shutdownOk) {
        await driver.stop(rec, ctx);
      } else {
        // Graceful shutdown succeeded — but the server only *begins* exiting
        // after the announced waittime (10s), and flushing a big world can take
        // longer still. Poll until the old process is really gone: starting the
        // new one too early makes driver.start() see a live process and silently
        // no-op — the restart then never happens, and the old process's own
        // exit a few seconds later gets misread as a PalDefender startup
        // failure, which halts auto-restart entirely.
        const deadline = Date.now() + SHUTDOWN_EXIT_TIMEOUT_MS;
        for (;;) {
          const cur = await driver.status(rec, ctx);
          if (cur.status !== "running") break;
          if (oldRuntimeId !== null && cur.runtimeId !== null && cur.runtimeId !== oldRuntimeId) {
            // A different process took over mid-wait (manual restart from the
            // UI). The goal — a fresh server — is already met; hand over.
            // (Carry lastDailyFire so a daily schedule doesn't refire this
            // same minute — check() set it in memory only.)
            const cur2 = this.readState(rec.id);
            cur2.lastDailyFire = state.lastDailyFire;
            this.record(rec.id, cur2, {
              at: new Date().toISOString(),
              reason,
              ok: false,
              detail: "等待舊程序退出期間,伺服器已被手動重啟接手 — 本次排程重啟取消,不影響新程序。",
            });
            return;
          }
          if (Date.now() >= deadline) {
            // Still alive past the deadline — escalate like the REST-less path
            // (driver.stop verifies the PID and waits for it to die).
            await driver.stop(rec, ctx);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // A manual stop during any of the waits above (announce / save /
      // shutdown) writes wasRunning=false via noteManualState. Respect it —
      // resurrecting a server the user just stopped is worse than skipping
      // one scheduled restart.
      const preStart = this.readState(rec.id);
      if (!preStart.wasRunning) {
        preStart.lastDailyFire = state.lastDailyFire;
        this.record(rec.id, preStart, {
          at: new Date().toISOString(),
          reason,
          ok: false,
          detail: "重啟等待期間偵測到手動停止 — 尊重停止指令,本次排程重啟取消(伺服器維持停止)。",
        });
        return;
      }

      const started = await driver.start(rec, ctx);
      if (!started) {
        throw new Error("舊伺服器程序尚未退出,無法啟動新程序 — 本次重啟未執行(伺服器維持原狀)");
      }

      // Re-read state instead of writing back the copy we've held across a
      // wait that can span minutes — a concurrent manual start/stop updates
      // the state file, and clobbering it re-arms stale flags.
      const now = new Date().toISOString();
      const fresh = this.readState(rec.id);
      fresh.lastDailyFire = state.lastDailyFire; // set by check() at fire time
      fresh.recentRestarts = [...this.recentWithinHour(fresh.recentRestarts), now];
      fresh.lastScheduledAt = now;
      fresh.wasRunning = true;
      fresh.lastStartAt = now;
      this.record(rec.id, fresh, { at: now, reason, ok: true, detail });
    } catch (err) {
      // Fresh read for the same reason as the success path; keep lastDailyFire
      // so a failed daily restart isn't re-attempted within the same minute.
      const cur = this.readState(rec.id);
      cur.lastDailyFire = state.lastDailyFire;
      this.record(rec.id, cur, {
        at: new Date().toISOString(),
        reason,
        ok: false,
        detail: `重啟失敗:${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.busy.delete(rec.id);
    }
  }

  /** Called when a human starts/stops an instance, so crash detection and the
   * interval schedule anchor to the new reality. */
  noteManualState(id: string, running: boolean): void {
    const state = this.readState(id);
    state.wasRunning = running;
    state.memoryStreak = 0;
    if (running) {
      state.lastStartAt = new Date().toISOString();
    }
    this.writeState(id, state);
  }
}
