import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RESTART_POLICY } from "@palserver/shared";
import { RestartSupervisor } from "./supervisor.js";
import { newestPalDefenderLogLines } from "./native.js";
import type { ServerDriver } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";

/** 回歸測試:排程重啟必須等舊程序真的退出才啟動新程序。
 *  情境還原自 2026-07-16 線上事故:REST /shutdown 要求 10 秒後關機,舊碼只睡 5 秒
 *  就呼叫 driver.start(),start() 看到舊程序還活著就靜默 no-op —— 重啟根本沒發生,
 *  幾秒後舊程序自行退出又被誤判成「PalDefender 啟動失敗」,自動重啟就此停擺。 */
test("scheduled restart waits for the old process to exit before starting", { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palsup-"));
  seedState(tmp); // check() 進 restart 前必已落檔 wasRunning=true,測試比照

  // 假的遊戲 REST API:save/announce/shutdown 一律 200;收到 shutdown 時
  // 模擬「舊程序 8 秒後才真正退出」(8s > 舊碼盲睡的 5s,< 新碼 60s poll 上限)。
  let exitAt: number | null = null;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/shutdown")) exitAt = Date.now() + 8_000;
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const rec = {
    id: "t1",
    backend: "native",
    settings: { RESTAPIEnabled: true, RESTAPIPort: port, AdminPassword: "pw" },
  } as unknown as InstanceRecord;

  const oldAlive = () => exitAt === null || Date.now() < exitAt;
  let spawnedAt: number | null = null; // 新程序 spawn 的時刻
  let noopStarts = 0; // 舊程序還活著時就被叫 start 的次數(修復前會是 1)
  let forceStops = 0;
  const driver: ServerDriver = {
    status: async () => ({
      status: spawnedAt !== null ? "running" : oldAlive() ? "running" : "exited",
      runtimeId: null,
    }),
    start: async () => {
      if (spawnedAt === null && oldAlive()) {
        noopStarts++; // 比照 native driver:看到活程序就 no-op
        return false;
      }
      spawnedAt = Date.now();
      return true;
    },
    stop: async () => {
      forceStops++;
      exitAt = Date.now();
    },
    remove: async () => {},
    stats: async () => null,
    streamLogs: async () => () => {},
    logSources: () => [],
  };

  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const supervisor = new RestartSupervisor(store, () => driver);
  const policy = { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 };
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };

  const t0 = Date.now();
  await supervisor.restart(
    rec,
    { instanceDir: tmp },
    driver,
    policy,
    state as Parameters<RestartSupervisor["restart"]>[4],
    "scheduled",
    "測試重啟",
  );
  server.close();

  assert.equal(noopStarts, 0, "start() 不得在舊程序還活著時被呼叫(修復前此值為 1)");
  assert.ok(spawnedAt !== null, "新程序必須真的被 spawn");
  assert.ok(exitAt !== null && spawnedAt >= exitAt, "spawn 必須發生在舊程序退出之後");
  assert.equal(forceStops, 0, "8 秒內自行退出,不應觸發強制停止");
  const last = readEvents(tmp).at(-1);
  assert.ok(last?.ok, "重啟事件必須記錄為成功");
  // 全程約 5s(存檔等待) + 8s(等舊程序退出),遠短於 poll 上限
  assert.ok(Date.now() - t0 < 45_000);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 落一份「伺服器正在跑」的初始狀態檔 —— 生產環境中 check() 進 restart()
 *  前一定已寫入 wasRunning=true,少了它會被「手動停止守門」正確地取消。 */
function seedState(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "restart-state.json"),
    JSON.stringify({ wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] }),
  );
}

/** 事件寫在 instanceDir 的 restart-state.json(restart() 以 fresh read 寫回)。 */
function readEvents(dir: string): { ok: boolean; detail: string }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "restart-state.json"), "utf8")) as {
      events?: { ok: boolean; detail: string }[];
    };
    return raw.events ?? [];
  } catch {
    return [];
  }
}

/** 共用腳手架:假 REST + 假 driver,收到 /shutdown 時呼叫 onShutdown。 */
async function rig(opts: { onShutdown: (api: RigApi) => void }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palsup-"));
  seedState(tmp);
  let exitAt: number | null = null;
  let runtimeId = "old-pid";
  let spawns = 0;
  const api: RigApi = {
    tmp,
    killOld: () => { exitAt = Date.now(); },
    takeover: () => { exitAt = null; runtimeId = "new-pid"; },
    spawns: () => spawns,
  };
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/shutdown")) {
      exitAt = Date.now() + 30_000; // 預設拖很久,由 onShutdown 決定劇情
      setTimeout(() => opts.onShutdown(api), 2_000);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const rec = {
    id: "t-rig",
    backend: "native",
    settings: { RESTAPIEnabled: true, RESTAPIPort: port, AdminPassword: "pw" },
  } as unknown as InstanceRecord;
  const oldAlive = () => exitAt === null || Date.now() < exitAt;
  const driver: ServerDriver = {
    status: async () => ({
      status: runtimeId !== "old-pid" || oldAlive() ? "running" : "exited",
      runtimeId: runtimeId !== "old-pid" ? runtimeId : oldAlive() ? "old-pid" : null,
    }),
    start: async () => { spawns++; return true; },
    stop: async () => { exitAt = Date.now(); },
    remove: async () => {},
    stats: async () => null,
    streamLogs: async () => () => {},
    logSources: () => [],
  };
  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const supervisor = new RestartSupervisor(store, () => driver);
  return { tmp, rec, driver, supervisor, server, spawns: () => spawns };
}
interface RigApi { tmp: string; killOld: () => void; takeover: () => void; spawns: () => number }

/** 等待期間伺服器被手動重啟接手(runtimeId 變了)→ 取消排程重啟,不碰新程序。 */
test("scheduled restart hands over when a manual restart takes over mid-wait", { timeout: 60_000 }, async () => {
  const { tmp, rec, driver, supervisor, server, spawns } = await rig({
    onShutdown: (api) => api.takeover(), // 模擬手動重啟:新 pid 接管
  });
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };
  await supervisor.restart(rec, { instanceDir: tmp }, driver, { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 },
    state as Parameters<RestartSupervisor["restart"]>[4], "scheduled", "測試");
  server.close();
  assert.equal(spawns(), 0, "接手後不得再 spawn(會疊在使用者的新程序上)");
  const events = readEvents(tmp);
  assert.match(events.at(-1)?.detail ?? "", /接手/, "必須記錄「已被手動重啟接手」事件");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 等待期間使用者手動停止(wasRunning=false 落檔 + 程序被停掉)→ 尊重停止,不自動復活。 */
test("scheduled restart respects a manual stop mid-wait", { timeout: 60_000 }, async () => {
  const { tmp, rec, driver, supervisor, server, spawns } = await rig({
    onShutdown: (api) => {
      // 模擬 /stop 路由:殺程序 + noteManualState(false) 落檔
      api.killOld();
      const f = path.join(api.tmp, "restart-state.json");
      const cur = (() => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } })();
      fs.writeFileSync(f, JSON.stringify({ ...cur, wasRunning: false, memoryStreak: 0, recentRestarts: cur.recentRestarts ?? [], events: cur.events ?? [] }));
    },
  });
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };
  await supervisor.restart(rec, { instanceDir: tmp }, driver, { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 },
    state as Parameters<RestartSupervisor["restart"]>[4], "scheduled", "測試");
  server.close();
  assert.equal(spawns(), 0, "手動停止後不得自動復活(driver.start 不得被呼叫)");
  const events = readEvents(tmp);
  assert.match(events.at(-1)?.detail ?? "", /手動停止/, "必須記錄「偵測到手動停止」事件");
  const finalState = JSON.parse(fs.readFileSync(path.join(tmp, "restart-state.json"), "utf8")) as { wasRunning: boolean };
  assert.equal(finalState.wasRunning, false, "伺服器必須維持停止");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 「最後日誌」提示只能引用本次啟動之後寫入的 PalDefender 日誌 ——
 *  上一輪程序的收尾訊息(如「REST API stopped」)會誤導診斷。 */
test("newestPalDefenderLogLines respects sinceMs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palpd-"));
  const logs = path.join(tmp, "server", "Pal", "Binaries", "Win64", "PalDefender", "logs");
  fs.mkdirSync(logs, { recursive: true });

  const oldFile = path.join(logs, "old.log");
  const newFile = path.join(logs, "new.log");
  fs.writeFileSync(oldFile, "[01:49:13][info] REST API stopped\n");
  fs.writeFileSync(newFile, "[07:54:40][error] failed to bind pdapi\n");
  const now = Date.now();
  fs.utimesSync(oldFile, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(newFile, new Date(now), new Date(now));

  const rec = {} as InstanceRecord;
  const ctx = { instanceDir: tmp };
  // 無過濾:拿到最新檔
  assert.match(newestPalDefenderLogLines(rec, ctx, 1)[0] ?? "", /failed to bind/);
  // 以「兩檔之間」為界:舊檔被排除,仍拿到新檔
  assert.match(newestPalDefenderLogLines(rec, ctx, 1, now - 30_000)[0] ?? "", /failed to bind/);
  // 以「兩檔之後」為界:本次啟動期間沒有日誌 → 空,不得回傳舊檔尾巴
  assert.deepEqual(newestPalDefenderLogLines(rec, ctx, 1, now + 30_000), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
