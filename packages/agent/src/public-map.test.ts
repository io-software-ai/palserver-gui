import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicMapSettings } from "@palserver/shared";
import { DEFAULT_PUBLIC_MAP_SETTINGS, WorldSettingsSchema } from "@palserver/shared";
import {
  anonymizedLabels,
  assemblePublicMapSnapshot,
  pickDelayedSnapshot,
  resolvePublishTarget,
  PublicMapPublisher,
  type PublicMapAssembleInput,
} from "./public-map.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import type { ServerDriver } from "./driver.js";
import type { PresenceTracker } from "./presence.js";

const settings = (patch: Partial<PublicMapSettings>): PublicMapSettings => ({
  ...DEFAULT_PUBLIC_MAP_SETTINGS,
  ...patch,
});

// ── 測試替身:白箱存取 PublicMapPublisher 的 private 成員(TS private 只在編譯期擋,
// 執行期就是一般屬性,cast 過去合法存取) —— 用於 Finding B/C/D 需要控制內部時序的測試。

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRec(id: string): InstanceRecord {
  return {
    id,
    name: `測試實例-${id}`,
    backend: "native",
    flavor: "vanilla",
    gamePort: 8211,
    settings: WorldSettingsSchema.parse({}),
    createdAt: new Date().toISOString(),
  };
}

function makeStore(instanceDir: string, rec: InstanceRecord): InstanceStore {
  return {
    list: () => [rec],
    instanceDir: () => instanceDir,
  } as unknown as InstanceStore;
}

function writeStateFile(instanceDir: string, state: { settings: PublicMapSettings; secret?: string }): void {
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, "public-map.json"), JSON.stringify(state, null, 2));
}

/** 卡住的 driver.status():回傳一個「拿得到 resolve 控制權」的 promise,測試藉此在
 * assemble() 途中暫停執行、插入其他動作(模擬併發),再放行。 */
function makeDeferredDriver(): {
  driver: ServerDriver;
  resolve: (status: "running" | "stopped") => void;
} {
  let resolveFn!: (v: { status: "running" | "stopped"; runtimeId: string | null }) => void;
  const pending = new Promise<{ status: "running" | "stopped"; runtimeId: string | null }>((resolve) => {
    resolveFn = resolve;
  });
  const driver = { status: async () => pending } as unknown as ServerDriver;
  return { driver, resolve: (status) => resolveFn({ status, runtimeId: null }) };
}

/** 暫時接管 globalThis.fetch,回傳還原函式(務必在 finally 呼叫)。 */
function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const fakePresence = {} as unknown as PresenceTracker;
const stoppedDriver = { status: async () => ({ status: "stopped" as const, runtimeId: null }) } as unknown as ServerDriver;

const baseInput = (patch: Partial<PublicMapAssembleInput> = {}): PublicMapAssembleInput => ({
  serverName: "測試伺服器",
  onlineCount: 0,
  online: [],
  offline: [],
  bases: [],
  ...patch,
});

test("anonymizedLabels:同一組 uid 不論輸入順序都得到同樣代號", () => {
  const a = anonymizedLabels(["b-user", "a-user", "c-user"]);
  const b = anonymizedLabels(["c-user", "a-user", "b-user"]);
  // 按 uid 字母序排:a-user < b-user < c-user
  assert.equal(a.get("a-user"), "Player 1");
  assert.equal(a.get("b-user"), "Player 2");
  assert.equal(a.get("c-user"), "Player 3");
  // 輸入順序不影響結果 —— 同一組 uid 兩次呼叫得到一模一樣的代號。
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("assemblePublicMapSnapshot:匿名化代號在快照裡穩定(不受玩家陣列順序影響)", () => {
  const alice = { userId: "a-user", name: "Alice", level: 9, savX: 0, savY: 0 };
  const bob = { userId: "b-user", name: "Bob", level: 5, savX: 100, savY: 100 };
  const s = settings({ showPlayers: true, showPlayerNames: false });

  const snap1 = assemblePublicMapSnapshot(baseInput({ online: [bob, alice] }), s, false);
  const snap2 = assemblePublicMapSnapshot(baseInput({ online: [alice, bob] }), s, false);

  // snap1: 陣列順序是 [bob, alice] → 輸出保留相同順序,但代號按 uid 排序決定
  assert.equal(snap1.players?.[0]?.n, "Player 2"); // bob = b-user
  assert.equal(snap1.players?.[1]?.n, "Player 1"); // alice = a-user
  // snap2: 陣列順序反過來,代號依然對得上同一個 uid
  assert.equal(snap2.players?.[0]?.n, "Player 1"); // alice = a-user
  assert.equal(snap2.players?.[1]?.n, "Player 2"); // bob = b-user
});

test("assemblePublicMapSnapshot:關掉 showBases 後 bases 欄位整個省略(不是空陣列)", () => {
  const input = baseInput({
    bases: [{ worldX: 1000, worldY: -2000, guildName: "公會A" }],
  });
  const snap = assemblePublicMapSnapshot(input, settings({ showBases: false }), true);
  assert.equal(snap.bases, undefined);
  assert.equal("bases" in snap, false);
  // 序列化後最外層也真的沒有 bases 這個 key(前端/Worker 依此判斷圖層關閉);
  // show.bases:false 這個旗標本身當然還在,只檢查最外層物件的 key 清單。
  assert.equal(Object.keys(snap).includes("bases"), false);
});

test("assemblePublicMapSnapshot:showGuildNames 開啟但 guild-map 未解鎖時,公會名一律省略", () => {
  const input = baseInput({
    bases: [
      { worldX: 1000, worldY: -2000, guildName: "公會A" },
      { worldX: -500, worldY: 3000, guildName: "公會B" },
    ],
  });
  const s = settings({ showBases: true, showGuildNames: true });

  const locked = assemblePublicMapSnapshot(input, s, /* guildNamesUnlocked */ false);
  assert.equal(locked.show.guildNames, false);
  assert.ok(locked.bases && locked.bases.length === 2);
  for (const b of locked.bases ?? []) assert.equal("g" in b, false);

  // 對照組:解鎖時應該看得到公會名 —— 確認過濾真的是被 guildNamesUnlocked 控制,而不是恆定省略。
  const unlocked = assemblePublicMapSnapshot(input, s, true);
  assert.equal(unlocked.show.guildNames, true);
  assert.deepEqual(
    (unlocked.bases ?? []).map((b) => b.g),
    ["公會A", "公會B"],
  );
});

test("pickDelayedSnapshot:取『至少 delayMinutes 分鐘前』組好、但最接近門檻的那份", () => {
  const now = 1_700_000_000_000;
  const tag = (label: string) => assemblePublicMapSnapshot(baseInput({ serverName: label }), settings({}), true, now);
  const buffer = [
    { at: now - 20 * 60_000, snapshot: tag("t-20") },
    { at: now - 14 * 60_000, snapshot: tag("t-14") },
    { at: now - 9 * 60_000, snapshot: tag("t-9") },
    { at: now - 4 * 60_000, snapshot: tag("t-4") },
    { at: now, snapshot: tag("t-0") },
  ];
  const picked = pickDelayedSnapshot(buffer, 10, now);
  // cutoff = now-10min:符合的是 t-20、t-14,取「最新但仍夠舊」的 t-14。
  assert.equal(picked?.name, "t-14");

  // delayMinutes=0 直接拿最新一份,不受門檻限制。
  assert.equal(pickDelayedSnapshot(buffer, 0, now)?.name, "t-0");
});

test("pickDelayedSnapshot:delay 緩衝還沒攢夠(全部太新)回傳 null,不提早外洩位置", () => {
  const now = 1_700_000_000_000;
  const snap = assemblePublicMapSnapshot(baseInput(), settings({}), true, now);
  const buffer = [
    { at: now - 2 * 60_000, snapshot: snap },
    { at: now, snapshot: snap },
  ];
  assert.equal(pickDelayedSnapshot(buffer, 15, now), null);
  // 空緩衝一樣回 null。
  assert.equal(pickDelayedSnapshot([], 5, now), null);
});

// ── Finding A:delayMinutes>0 時,緩衝空不得 fallback 成即時快照 ──

test("resolvePublishTarget:delayMinutes>0 且緩衝空 → 回傳最小快照,不含玩家/據點(Finding A)", () => {
  const now = 1_700_000_000_000;
  const alice = { userId: "a-user", name: "Alice", level: 9, savX: 0, savY: 0 };
  const s = settings({ showPlayers: true, showBases: true, delayMinutes: 15 });
  const freshSnapshot = assemblePublicMapSnapshot(baseInput({ onlineCount: 1, online: [alice] }), s, true, now);
  // 先確認「即時快照」本身真的帶著玩家位置 —— 這樣底下的斷言才有意義(不是恆真)。
  assert.ok(freshSnapshot.players && freshSnapshot.players.length === 1);

  const result = resolvePublishTarget([], s, freshSnapshot, now);
  assert.equal(result.onlineCount, freshSnapshot.onlineCount);
  assert.equal(result.name, freshSnapshot.name);
  assert.equal("players" in result, false);
  assert.equal("offline" in result, false);
  assert.equal("bases" in result, false);
  assert.deepEqual(result.show, { players: false, names: false, offline: false, bases: false, guildNames: false });

  // 對照組 1:delayMinutes<=0(使用者本來就要即時),緩衝空時直接送即時快照,不繞道最小快照。
  const immediate = resolvePublishTarget([], settings({ delayMinutes: 0 }), freshSnapshot, now);
  assert.equal(immediate, freshSnapshot);

  // 對照組 2:緩衝裡已經有夠舊的版本時,優先用那份,不使用最小快照 fallback。
  const old = assemblePublicMapSnapshot(baseInput({ serverName: "夠舊的版本" }), s, true, now - 20 * 60_000);
  const withBuffer = resolvePublishTarget([{ at: now - 20 * 60_000, snapshot: old }], s, freshSnapshot, now);
  assert.equal(withBuffer.name, "夠舊的版本");
});

// ── Finding B:世代號(generation)擋住插隊的 tick ──

test("PublicMapPublisher:assemble 途中世代號被改變 → tick 放棄送出(Finding B)", async () => {
  const instanceDir = tempDir("public-map-gen-");
  const dataDir = tempDir("public-map-gen-data-");
  const rec = makeRec("inst-gen-abort");
  const store = makeStore(instanceDir, rec);
  writeStateFile(instanceDir, {
    settings: settings({ enabled: true, shareId: "share-gen", delayMinutes: 0 }),
    secret: "secret-gen",
  });

  const { driver, resolve } = makeDeferredDriver();
  const publisher = new PublicMapPublisher(store, () => driver, fakePresence, dataDir, () => true);

  let publishCalls = 0;
  const restoreFetch = stubFetch(async (input) => {
    if (String(input).includes("/api/map/publish")) publishCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    const priv = publisher as unknown as {
      tick: () => Promise<void>;
      bumpGeneration: (id: string) => void;
    };
    const tickPromise = priv.tick();
    // 讓已排入的微任務都跑完,執行應該卡在 assemble() 裡等 driver.status() resolve。
    await new Promise((r) => setImmediate(r));

    // 模擬「序列化被繞過」情境下的併發 rotate/disable:直接洗世代號,驗證世代號檢查
    // 這第二道防線本身是有效的(不只是靠 enqueue 序列化擋住)。
    priv.bumpGeneration(rec.id);

    resolve("stopped");
    await tickPromise;

    assert.equal(publishCalls, 0, "世代號變了,不該送出任何 publish 請求");
  } finally {
    restoreFetch();
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PublicMapPublisher:世代號沒變時 tick 照常送出(對照組)", async () => {
  const instanceDir = tempDir("public-map-gen-ok-");
  const dataDir = tempDir("public-map-gen-ok-data-");
  const rec = makeRec("inst-gen-ok");
  const store = makeStore(instanceDir, rec);
  writeStateFile(instanceDir, {
    settings: settings({ enabled: true, shareId: "share-gen-ok", delayMinutes: 0 }),
    secret: "secret-gen-ok",
  });

  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir, () => true);
  let publishCalls = 0;
  const restoreFetch = stubFetch(async (input) => {
    if (String(input).includes("/api/map/publish")) publishCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    await (publisher as unknown as { tick: () => Promise<void> }).tick();
    assert.equal(publishCalls, 1, "世代號沒變,這輪應該正常送出一次");
  } finally {
    restoreFetch();
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── 贊助者 gating(public-map):授權過期時背景 tick 自動跳過發布 ──

test("PublicMapPublisher:featureEnabledFn 回傳 false(未授權)時 tick 不發布,設定原封不動(public-map gating)", async () => {
  const instanceDir = tempDir("public-map-gate-");
  const dataDir = tempDir("public-map-gate-data-");
  const rec = makeRec("inst-gate");
  const store = makeStore(instanceDir, rec);
  const initialState = {
    settings: settings({ enabled: true, shareId: "share-gate", delayMinutes: 0 }),
    secret: "secret-gate",
  };
  writeStateFile(instanceDir, initialState);

  // 明確注入「未授權」,不依賴這台機器上真的沒有 license.json(那只是巧合成立的假設)。
  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir, () => false);
  let publishCalls = 0;
  const restoreFetch = stubFetch(async (input) => {
    if (String(input).includes("/api/map/publish")) publishCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    await (publisher as unknown as { tick: () => Promise<void> }).tick();
    assert.equal(publishCalls, 0, "未授權時這輪不該送出任何 publish 請求");

    // 設定檔本身不被動:enabled/shareId/secret 都原封不動(不清設定、不 unpublish)。
    const stateFile = path.join(instanceDir, "public-map.json");
    const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8")) as typeof initialState;
    assert.deepEqual(onDisk.settings.enabled, true);
    assert.deepEqual(onDisk.settings.shareId, "share-gate");
    assert.deepEqual(onDisk.secret, "secret-gate");
  } finally {
    restoreFetch();
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PublicMapPublisher:未授權時 publishNow 也不發布(設定變更的即時發布不能繞過 gate)", async () => {
  const instanceDir = tempDir("public-map-gate2-");
  const dataDir = tempDir("public-map-gate2-data-");
  const rec = makeRec("inst-gate2");
  const store = makeStore(instanceDir, rec);
  const s = settings({ enabled: true, shareId: "share-gate2", delayMinutes: 0 });
  writeStateFile(instanceDir, { settings: s, secret: "secret-gate2" });

  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir, () => false);
  let publishCalls = 0;
  const restoreFetch = stubFetch(async (input) => {
    if (String(input).includes("/api/map/publish")) publishCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    await (
      publisher as unknown as {
        publishNow: (r: typeof rec, st: typeof s, sec: string) => Promise<void>;
      }
    ).publishNow(rec, s, "secret-gate2");
    assert.equal(publishCalls, 0, "未授權時 publishNow 不該送出 publish 請求");
  } finally {
    restoreFetch();
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── Finding C:全域下架佇列 ──

test("PublicMapPublisher 下架佇列:失敗保留、成功移出、404/410 視為完成移出(Finding C)", async () => {
  const dataDir = tempDir("public-map-queue-");
  const instanceDir = tempDir("public-map-queue-inst-");
  const rec = makeRec("inst-queue");
  const store = makeStore(instanceDir, rec);
  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir);

  const outcomeOf = new Map<string, "ok" | "gone" | "fail">([
    ["remove-ok", "ok"],
    ["remove-gone", "gone"],
    // "keep-me" 不在表裡 -> 一律回 500(失敗)
  ]);
  const restoreFetch = stubFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: string };
    const outcome = outcomeOf.get(body.id) ?? "fail";
    if (outcome === "ok") return new Response(null, { status: 200 });
    if (outcome === "gone") return new Response(null, { status: 410 });
    return new Response(null, { status: 500 });
  });

  const priv = publisher as unknown as {
    enqueueUnpublish: (id: string, key: string) => void;
    retryUnpublishQueue: () => Promise<void>;
    readUnpublishQueue: () => Array<{ id: string; key: string; addedAt: number }>;
  };

  try {
    priv.enqueueUnpublish("keep-me", "key-fail");
    priv.enqueueUnpublish("remove-ok", "key-ok");
    priv.enqueueUnpublish("remove-gone", "key-gone");
    assert.equal(priv.readUnpublishQueue().length, 3);

    await priv.retryUnpublishQueue();

    const remainingIds = priv.readUnpublishQueue().map((e) => e.id).sort();
    assert.deepEqual(remainingIds, ["keep-me"]);
  } finally {
    restoreFetch();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test("PublicMapPublisher 下架佇列:超過 7 天的條目放棄重試、直接移出", async () => {
  const dataDir = tempDir("public-map-queue-old-");
  const instanceDir = tempDir("public-map-queue-old-inst-");
  const rec = makeRec("inst-queue-old");
  const store = makeStore(instanceDir, rec);
  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir);

  fs.mkdirSync(dataDir, { recursive: true });
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60_000;
  fs.writeFileSync(
    path.join(dataDir, "public-map-unpublish-queue.json"),
    JSON.stringify([{ id: "stale-id", key: "stale-key", addedAt: eightDaysAgo }]),
  );

  let fetchCalled = false;
  const restoreFetch = stubFetch(async () => {
    fetchCalled = true;
    return new Response(null, { status: 500 });
  });

  const priv = publisher as unknown as {
    retryUnpublishQueue: () => Promise<void>;
    readUnpublishQueue: () => Array<{ id: string; key: string; addedAt: number }>;
  };

  try {
    await priv.retryUnpublishQueue();
    assert.equal(fetchCalled, false, "過期條目不該再嘗試呼叫 Worker,直接放棄");
    assert.deepEqual(priv.readUnpublishQueue(), []);
  } finally {
    restoreFetch();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

// ── Finding C(下):實例刪除的清理鉤子 ──

test("PublicMapPublisher.instanceRemoved:把 id+secret 搬進全域下架佇列(Finding C 第二部分)", async () => {
  const dataDir = tempDir("public-map-del-data-");
  const instanceDir = tempDir("public-map-del-inst-");
  const rec = makeRec("inst-del");
  const store = makeStore(instanceDir, rec);
  const shareId = "share-del";
  const secret = "secret-del";
  writeStateFile(instanceDir, {
    settings: settings({ enabled: true, shareId, delayMinutes: 0 }),
    secret,
  });

  const publisher = new PublicMapPublisher(store, () => stoppedDriver, fakePresence, dataDir);
  // 讓「立即嘗試一次」的下架呼叫失敗,這樣佇列條目才會確實留著讓我們檢查
  // (若立即嘗試就成功,retireShareId 會馬上把它移出佇列,測不到「有沒有入佇列」這件事)。
  const restoreFetch = stubFetch(async () => new Response(null, { status: 500 }));

  try {
    await publisher.instanceRemoved(rec.id);
    // instanceRemoved 內部觸發的「立即嘗試」是不等待的 fire-and-forget fetch,
    // 讓它有機會跑完,確保讀佇列時不是在它中途。
    await new Promise((r) => setImmediate(r));

    const queueFile = path.join(dataDir, "public-map-unpublish-queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8")) as Array<{ id: string; key: string }>;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, shareId);
    assert.equal(queue[0].key, secret);
  } finally {
    restoreFetch();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});
