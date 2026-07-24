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

test("serverPlatform: native reflects agent platform", () => {
  // These assertions are inherently agent-OS-dependent; they validate the
  // current process.platform rather than mocking it.
  const expected = process.platform === "win32" ? "windows" : "linux";
  assert.equal(serverPlatform(nativeRec("win32")), expected);
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

test("serverPlatform: native + Linux + runtime=wine → windows", () => {
  // Linux native 選「強化」(modded)時 runtime=wine,走 Windows binary + Wine。
  const nativeWineRec: InstanceRecord = { ...baseRec, backend: "native", runtime: "wine" } as InstanceRecord;
  assert.equal(serverPlatform(nativeWineRec), "windows");
  assert.equal(configPlatformDir(nativeWineRec), "WindowsServer");
});
