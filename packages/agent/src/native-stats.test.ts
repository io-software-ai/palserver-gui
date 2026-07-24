import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCpuPercent, computePerCore } from "./native.js";

// 背景:pidusage 的 cpu 欄位在 Windows 用 os.uptime()(整秒)算間隔,短輪詢誤差極大
// 且 per-pid 歷史被多個輪詢互踩(實測 3 秒內 78%→36%→0%)。agent 改用 ctime 差分自算。

test("computeCpuPercent:毫秒精度差分(半核負載)", () => {
  // 3.2 秒間隔內累積 1.6 秒 CPU 時間 = 50%
  const prev = { ctimeMs: 10_000, at: 1_000_000 };
  assert.equal(computeCpuPercent(prev, 11_600, 1_003_200, 999_999), 50);
});

test("computeCpuPercent:並行輪詢的短間隔也正確(300ms)", () => {
  // 300ms 內累積 300ms CPU = 100%,不會像 pidusage 整秒法算成 0
  const prev = { ctimeMs: 5_000, at: 2_000_000 };
  assert.equal(computeCpuPercent(prev, 5_300, 2_000_300, null), 100);
});

test("computeCpuPercent:首次取樣退回自開機平均", () => {
  // 無歷史:累計 30 秒 CPU / 運行 120 秒 = 25%
  assert.equal(computeCpuPercent(null, 30_000, 9_999, 120_000), 25);
});

test("computeCpuPercent:行程重啟(ctime 回退)不算負值,退回平均", () => {
  const prev = { ctimeMs: 50_000, at: 1_000_000 };
  assert.equal(computeCpuPercent(prev, 2_000, 1_005_000, 10_000), 20);
});

test("computeCpuPercent:歷史過舊(>10 分鐘)不拿來差分", () => {
  const prev = { ctimeMs: 0, at: 0 };
  // 11 分鐘前的舊樣本 → 退回自開機平均(而非跨 11 分鐘的平均)
  assert.equal(computeCpuPercent(prev, 60_000, 11 * 60_000, 600_000), 10);
});

test("computeCpuPercent:無歷史且無 elapsed → 0(不回 NaN)", () => {
  assert.equal(computeCpuPercent(null, 1234, 1, null), 0);
  assert.equal(computeCpuPercent(null, 1234, 1, 0), 0);
});

// computePerCore:由 os.cpus() 的 per-core {idle, total} 差分算使用率(0–100)。

test("computePerCore:首筆無歷史 → null(需兩筆才能差分)", () => {
  assert.equal(computePerCore(undefined, [{ idle: 800, total: 1000 }]), null);
});

test("computePerCore:半載(idle 減半)→ 50%", () => {
  // total 差 1000,idle 差 500 → 閒置 50% → 使用率 50%
  const prev = [{ idle: 800, total: 1000 }];
  const cur = [{ idle: 1300, total: 2000 }];
  assert.deepEqual(computePerCore(prev, cur), [50]);
});

test("computePerCore:多核各自獨立計算", () => {
  // 核0: idle 差 0/total 差 1000 → 使用率 100%
  // 核1: idle 差 1000/total 差 1000 → 使用率 0%
  const prev = [{ idle: 0, total: 1000 }, { idle: 0, total: 1000 }];
  const cur = [{ idle: 0, total: 2000 }, { idle: 1000, total: 2000 }];
  assert.deepEqual(computePerCore(prev, cur), [100, 0]);
});

test("computePerCore:totalDelta ≤ 0(計數器回退)→ null", () => {
  const prev = [{ idle: 500, total: 1000 }];
  const cur = [{ idle: 400, total: 900 }]; // total 回退
  assert.deepEqual(computePerCore(prev, cur), [null]);
});
