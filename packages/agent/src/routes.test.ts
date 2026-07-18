import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * TD-4(005):routes 層 unit test。
 * 用 createApp factory + mock deps 建構測試 app,測 /api/info(availableBackends)
 * 與 create instance 的 backend validation。
 *
 * Mock 策略:store 用真實 InstanceStore(臨時 data dir),presence/scheduler/
 * supervisor/updateOps 用最小 stub(這些測試案例不觸發它們的功能)。
 * backend-availability 的偵測結果因 process.platform 不可 mock 而依賴測試環境
 * 的 OS — Linux CI 上 native 不在 availableBackends,Windows 上 native 在。
 *
 * 重要:env.ts 的 DATA_DIR 在模組載入時凍結。靜態 import 會在 env 設好前載入,
 * 污染真實 data dir。故用動態 import,確保 process.env.PALSERVER_DATA_DIR
 * 先指向臨時目錄,再載入 app/store 等模組。
 */

async function loadTestModules() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  process.env.PALSERVER_DATA_DIR = tmpDir;
  // 動態 import:env.ts 此時才載入,讀到臨時 DATA_DIR。
  const appModule = await import("./app.js");
  const { InstanceStore } = await import("./store.js");
  return { createApp: appModule.createApp, InstanceStore, tmpDir };
}

function makeMockDeps(InstanceStore: any) {
  const store = new InstanceStore();
  return {
    store,
    presence: { start() {}, stop() {}, knownPlayers: () => [], activePlayers: () => [] },
    scheduler: { start() {}, stop() {} },
    supervisor: { start() {}, stop() {} },
    publicMap: { start() {}, stop() {}, publish: () => {} },
    auth: { token: "test-token", pairingCode: "TEST", requireToken: false },
    updateOps: { canApply: () => null, onRestart: () => {}, log: () => {} },
  } as any;
}

test("/api/info 回傳 availableBackends(依平台)", async () => {
  const { createApp, InstanceStore, tmpDir } = await loadTestModules();
  const deps = makeMockDeps(InstanceStore);
  const app = await createApp({ ...deps, webDist: null });
  try {
    const res = await app.inject({ method: "GET", url: "/api/info" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { availableBackends: string[] };
    if (process.platform === "win32") {
      assert.ok(body.availableBackends.includes("native"), "Windows 應含 native");
    } else {
      assert.ok(!body.availableBackends.includes("native"), "Linux/macOS 不應含 native");
    }
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("create instance:native 在非 Windows 應被擋", async () => {
  const { createApp, InstanceStore, tmpDir } = await loadTestModules();
  const deps = makeMockDeps(InstanceStore);
  const app = await createApp({ ...deps, webDist: null });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/instances",
      payload: { name: "test-blocked", backend: "native", flavor: "vanilla" },
    });
    if (process.platform !== "win32") {
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: string };
      assert.match(body.error, /不可用/);
    } else {
      assert.notEqual(res.statusCode, 400);
    }
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
