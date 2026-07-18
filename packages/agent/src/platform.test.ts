import assert from "node:assert/strict";
import test from "node:test";
import type { InstanceRecord } from "./store.js";
import { serverPlatform, configPlatformDir } from "./platform.js";

const baseRec = {
  id: "test",
  name: "test",
  createdAt: "2026-01-01T00:00:00Z",
  flavor: "vanilla" as const,
  gamePort: 8211,
  settings: {} as InstanceRecord["settings"],
};

const nativeRec = (platform: string): InstanceRecord =>
  ({ ...baseRec, backend: "native" }) as InstanceRecord;

const dockerRec: InstanceRecord = { ...baseRec, backend: "docker" } as InstanceRecord;
const k8sRec: InstanceRecord = { ...baseRec, backend: "k8s" } as InstanceRecord;
const dockerWineRec: InstanceRecord = { ...baseRec, backend: "docker", runtime: "wine" } as InstanceRecord;
const k8sWineRec: InstanceRecord = { ...baseRec, backend: "k8s", runtime: "wine" } as InstanceRecord;

test("serverPlatform: native 反映真實 host OS(006 回歸 — 既有 Linux native 保留)", () => {
  // 006:serverPlatform(native) 回歸真實 host OS。新建 Linux native 由 routes.ts
  // create instance gate 擋(backend-availability NativeDetector Windows-only),
  // 不在這裡。既有 Linux native 實例正確走 Linux 路徑。
  // 註:nativeRec 的 platform 參數未使用(serverPlatform 直接讀 process.platform),
  // 所以這個斷言依賴測試環境 OS — Windows CI 驗 windows,Linux CI 驗 linux。
  const expected = process.platform === "win32" ? "windows" : "linux";
  assert.equal(serverPlatform(nativeRec("win32")), expected);
});

test("serverPlatform: native + 非 Windows host → linux(006 迴歸保護)", () => {
  // 維護者 review 建議補的案例。確保 serverPlatform 不再對 native 硬回 windows。
  // 非 Windows 環境(Linux/macOS CI)直接驗證;Windows 環境用 dockerRec/k8sRec
  // 的 linux 分支驗證同樣邏輯(serverPlatform 對非 wine 的 docker/k8s 回 linux)。
  if (process.platform !== "win32") {
    assert.equal(serverPlatform(nativeRec("linux")), "linux");
  } else {
    // Windows CI 上無法直接驗(native 回 windows),改驗 docker 非 wine 回 linux
    assert.equal(serverPlatform(dockerRec), "linux");
  }
});

test("serverPlatform: docker/k8s currently linux (will change with Wine support)", () => {
  assert.equal(serverPlatform(dockerRec), "linux");
  assert.equal(serverPlatform(k8sRec), "linux");
});

test("serverPlatform: docker/k8s runtime=wine returns windows", () => {
  assert.equal(serverPlatform(dockerWineRec), "windows");
  assert.equal(serverPlatform(k8sWineRec), "windows");
});

test("configPlatformDir: maps to WindowsServer or LinuxServer", () => {
  assert.equal(configPlatformDir(dockerRec), "LinuxServer");
  assert.equal(configPlatformDir(k8sRec), "LinuxServer");
  assert.equal(configPlatformDir(dockerWineRec), "WindowsServer");
  assert.equal(configPlatformDir(k8sWineRec), "WindowsServer");
});
