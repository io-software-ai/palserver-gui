import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, LICENSE_URL } from "./env.js";
import { EARLY_ACCESS_FEATURES, featureFreeNow, hasFeature, type LicenseStatus } from "@palserver/shared";

/**
 * 贊助者識別碼(先行版授權)。一碼綁一台:第一次向 worker 啟用時把這台的機器碼綁上去,
 * 之後只有同一台能驗證通過。驗證結果快取在 data-dir,帶離線寬限期 —— 網路不通時仍可用一段時間。
 *
 * 提醒:因為開源自架,這個檢查跑在使用者機器上,無法硬性防止改碼繞過;定位是「贊助者提前體驗」。
 */

const KEY_FILE = path.join(DATA_DIR, "license.json");
const CACHE_FILE = path.join(DATA_DIR, "license-cache.json");
const MACHINE_FILE = path.join(DATA_DIR, "machine-id");

const RECHECK_MS = 12 * 60 * 60 * 1000; // 每 12 小時重新驗證
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 連不上時,快取有效沿用 14 天

interface Cache {
  valid: boolean;
  tier: string | null;
  features: string[];
  expiresAt: string | null;
  reason: string | null;
  checkedAt: string; // ISO
}

/** 這台伺服器的機器碼(隨機、存在 data-dir);識別碼一旦啟用就綁這台。 */
function machineId(): string {
  try {
    const id = fs.readFileSync(MACHINE_FILE, "utf8").trim();
    if (id) return id;
  } catch {
    /* 尚未產生 */
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MACHINE_FILE, id);
  return id;
}

function readKey(): string | null {
  try {
    const { code } = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as { code?: string };
    return code?.trim() || null;
  } catch {
    return null;
  }
}

function readCache(): Cache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return null;
  }
}

function writeCache(c: Cache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}

/** 向 worker 啟用/驗證識別碼(首次會綁機器)。網路失敗回 null,交給呼叫端沿用舊快取。 */
async function activate(code: string): Promise<Cache | null> {
  try {
    const res = await fetch(`${LICENSE_URL}/api/license/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, machineId: machineId() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok && res.status >= 500) return null; // 伺服器錯 -> 沿用快取
    const data = (await res.json()) as {
      valid?: boolean;
      tier?: string;
      features?: string[];
      expiresAt?: string | null;
      reason?: string;
    };
    return {
      valid: !!data.valid,
      tier: data.tier ?? null,
      features: Array.isArray(data.features) ? data.features : [],
      expiresAt: data.expiresAt ?? null,
      reason: data.valid ? null : (data.reason ?? "invalid"),
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null; // 連不上 -> 沿用快取
  }
}

/** 目前有效的授權(套用離線寬限期)。無 key 或寬限期已過則視為無授權。 */
function effectiveCache(): Cache | null {
  if (!readKey()) return null;
  const c = readCache();
  if (!c) return null;
  // 上次是「有效」但已離線超過寬限期 -> 失效。
  if (c.valid && Date.now() - Date.parse(c.checkedAt) > OFFLINE_GRACE_MS) {
    return { ...c, valid: false, reason: "offline" };
  }
  return c;
}

/** 重新驗證(有 key 且距上次超過 RECHECK_MS 才打;force 立即打)。 */
export async function refreshLicense(force = false): Promise<void> {
  const code = readKey();
  if (!code) return;
  const c = readCache();
  if (!force && c && Date.now() - Date.parse(c.checkedAt) < RECHECK_MS) return;
  const fresh = await activate(code);
  if (fresh) writeCache(fresh);
  else if (c) writeCache({ ...c }); // 保留舊快取(不更新 checkedAt),讓寬限期繼續計時
}

/** 設定/更換識別碼:存檔並立即向 worker 驗證。回傳最新狀態。 */
export async function setLicenseKey(code: string): Promise<LicenseStatus> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ code: code.trim().toUpperCase() }, null, 2));
  const fresh = await activate(code);
  if (fresh) writeCache(fresh);
  else writeCache({ valid: false, tier: null, features: [], expiresAt: null, reason: "offline", checkedAt: new Date().toISOString() });
  return licenseStatus();
}

/** 清除識別碼(不影響 worker 上的綁定;要換機請用管理端的 reset)。 */
export function clearLicenseKey(): LicenseStatus {
  fs.rmSync(KEY_FILE, { force: true });
  fs.rmSync(CACHE_FILE, { force: true });
  return licenseStatus();
}

/** 給前端看的完整授權狀態(含免費/早鳥功能整併後的可用功能)。 */
export function licenseStatus(): LicenseStatus {
  const c = effectiveCache();
  const now = new Date();
  const lic = { valid: c?.valid ?? false, features: c?.features ?? [] };
  // 對前端而言「可用的早鳥功能」= 已免費 或 這張碼有解鎖。
  const availableEarlyAccess = EARLY_ACCESS_FEATURES.filter((f) =>
    hasFeature(f.id, lic, now),
  ).map((f) => f.id);
  return {
    hasKey: readKey() !== null,
    valid: c?.valid ?? false,
    tier: c?.tier ?? null,
    features: availableEarlyAccess,
    expiresAt: c?.expiresAt ?? null,
    reason: c?.reason ?? null,
    machineId: machineId().slice(0, 8),
    checkedAt: c?.checkedAt ?? null,
  };
}

/** 後端閘門:這個功能現在能不能用(免費 或 有效識別碼解鎖)。給路由擋用。 */
export function featureEnabled(id: string): boolean {
  if (featureFreeNow(id)) return true;
  const c = effectiveCache();
  return hasFeature(id, { valid: c?.valid ?? false, features: c?.features ?? [] });
}
