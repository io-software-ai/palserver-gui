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
  { id: "guild-map", label: "地圖公會詳情(名稱 / 成員 / 據點)", until: "2027-12-31" },
  { id: "pal-stats", label: "帕魯物種數值編輯器(PalSchema:HP / 攻防 / 首領)", until: "2027-12-31" },
  { id: "bulk-items", label: "批量給予道具(物品選單 + 數量)", until: "2027-12-31" },
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

/**
 * 統一的功能可用性判斷:已免費 OR 有有效贊助授權。
 *
 * 目前只有單一贊助層級,識別碼的 `features` 清單僅供顯示 —— 有效贊助者一律解鎖
 * 全部早鳥功能(這樣新增功能不必重發碼 / 改 worker)。若日後要做分層,再把
 * `lic.features.includes(id)` 的判斷加回來即可。
 */
export function hasFeature(
  id: string,
  lic: Pick<LicenseStatus, "valid" | "features">,
  now: Date = new Date(),
): boolean {
  return featureFreeNow(id, now) || lic.valid;
}
