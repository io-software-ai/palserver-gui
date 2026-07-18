import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createBackup } from "./saves.js";

// TD-3(005):createBackup 接受可選 tarOverride 參數(測試注入點),解決 ESM
// live-binding re-export 不可 mock 的問題(configurable:false/writable:false,
// Node 內建 mock.method 與 Object.defineProperty 都無法替換)。生產呼叫端不傳
// 走模組 import 的預設 tarDirInPod;測試注入 stub 動態驗證錯誤路徑。
// 動態測試覆蓋:tar 失敗時保留真實錯誤(500)、tar 成功時寫入 archive。

const k8sRec = {
  id: "test-k8s",
  name: "test-k8s",
  backend: "k8s" as const,
  flavor: "vanilla" as const,
  gamePort: 8211,
  k8sNamespace: "palworld-manager",
  k8sStatefulSet: "palworld-game-server-wine",
  settings: {} as never,
  createdAt: "2026-07-17T00:00:00.000Z",
};

const nativeRec = {
  id: "test-native",
  name: "test-native",
  backend: "native" as const,
  flavor: "vanilla" as const,
  gamePort: 8211,
  settings: {} as never,
  createdAt: "2026-07-17T00:00:00.000Z",
};

function tempCtx() {
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-test-"));
  return { instanceDir, cleanup: () => fs.rmSync(instanceDir, { recursive: true, force: true }) };
}

test("k8s backup:tar 失敗時保留真實錯誤訊息與 500", async () => {
  const { instanceDir, cleanup } = tempCtx();
  const failingTar = () => Promise.reject(new Error("file changed as we read it"));
  try {
    await assert.rejects(
      () => createBackup(k8sRec, { instanceDir }, "DEADBEEFDEADBEEFDEADBEEFDEADBEEF", failingTar),
      (err: Error & { statusCode?: number }) =>
        err.message.includes("file changed as we read it") && err.statusCode === 500,
    );
  } finally {
    cleanup();
  }
});

test("k8s backup:tar 成功時寫入 archive 並回傳 BackupInfo", async () => {
  const { instanceDir, cleanup } = tempCtx();
  const okTar = () => Promise.resolve(Buffer.from("dummy-tar-payload"));
  try {
    const info = await createBackup(
      k8sRec,
      { instanceDir },
      "ABCDEFABCDEFABCDEFABCDEFABCDEFAB",
      okTar,
    );
    assert.match(info.name, /^ABCDEFABCDEFABCDEFABCDEFABCDEFAB__.*\.tar\.gz$/);
    assert.equal(info.worldGuid, "ABCDEFABCDEFABCDEFABCDEFABCDEFAB");
    const archive = path.join(instanceDir, "backups", info.name);
    assert.ok(fs.existsSync(archive), "archive 應存在");
    assert.equal(fs.readFileSync(archive).toString(), "dummy-tar-payload");
  } finally {
    cleanup();
  }
});

test("native backup:目錄不存在時拋 404 找不到世界存檔(保護既有行為)", async () => {
  const { instanceDir, cleanup } = tempCtx();
  // serverRoot 預設為 instanceDir/server;該目錄不存在 → savedRoot 與 saveGamesDir 也不存在。
  try {
    await assert.rejects(
      () => createBackup(nativeRec, { instanceDir }, "01234567890123456789012345678901"),
      (err: Error & { statusCode?: number }) =>
        err.message.includes("找不到世界存檔") && err.statusCode === 404,
    );
  } finally {
    cleanup();
  }
});
