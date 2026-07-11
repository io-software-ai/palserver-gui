/**
 * 贊助者「先行版」功能目錄與授權判斷(agent 與 web 共用)。
 *
 * 模式:功能就在公開程式碼裡,但在 `until` 之前需要「有效的贊助識別碼」才會解鎖;
 * 到了 `until`(含)當天就對所有人開放 —— 也就是「贊助者提前體驗、之後免費」。
 * 因為是開源自架,識別碼檢查跑在使用者機器上,無法硬性防繞過,定位是支持者提前體驗。
 */

export interface EarlyAccessFeature {
  id: string;
  label: string;
  /** 這天(含)之後對所有人開放;在此之前需要有效贊助識別碼。ISO yyyy-mm-dd。 */
  until: string;
}

export const EARLY_ACCESS_FEATURES: EarlyAccessFeature[] = [
  { id: "custom-pal", label: "自訂帕魯(詞條 / 體質 / 星星)", until: "2026-12-31" },
];

/** 這個功能現在是否已對所有人免費(不在目錄裡的一律視為免費)。 */
export function featureFreeNow(id: string, now: Date = new Date()): boolean {
  const f = EARLY_ACCESS_FEATURES.find((x) => x.id === id);
  if (!f) return true;
  return now.toISOString().slice(0, 10) >= f.until;
}

/** agent 回報給前端的授權狀態。 */
export interface LicenseStatus {
  /** 使用者是否已填識別碼。 */
  hasKey: boolean;
  /** 識別碼目前是否有效(含離線寬限期內)。 */
  valid: boolean;
  tier: string | null;
  /** 這張識別碼解鎖的早鳥功能 id。 */
  features: string[];
  /** 到期日(ISO)或 null=永久。 */
  expiresAt: string | null;
  /** 無效原因:invalid / bound-to-another / expired / offline / server-error。 */
  reason: string | null;
  /** 這台伺服器的機器碼(短)—— 識別碼一旦啟用就綁這台。 */
  machineId: string;
  /** 上次向伺服器驗證的時間(ISO);離線時前端可提示。 */
  checkedAt: string | null;
}

/** 統一的功能可用性判斷:已免費 OR(識別碼有效且包含此功能)。 */
export function hasFeature(
  id: string,
  lic: Pick<LicenseStatus, "valid" | "features">,
  now: Date = new Date(),
): boolean {
  return featureFreeNow(id, now) || (lic.valid && lic.features.includes(id));
}
