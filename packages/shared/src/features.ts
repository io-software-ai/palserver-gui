/**
 * 贊助者專屬功能目錄與授權判斷(agent 與 web 共用)。
 *
 * 模式:功能就在公開程式碼裡,但需要「有效的贊助識別碼」才會解鎖 —— 永久贊助者
 * 專屬,沒有免費期限;不在目錄裡的功能一律免費。(2026-07 起取消原本的
 * 「到期後對所有人開放」機制。)
 * 因為是開源自架,識別碼檢查跑在使用者機器上,無法硬性防繞過,定位是支持者專屬體驗。
 */

export interface EarlyAccessFeature {
  id: string;
  label: string;
}

export const EARLY_ACCESS_FEATURES: EarlyAccessFeature[] = [
  { id: "custom-pal", label: "自訂帕魯(詞條 / 體質 / 星星)" },
  { id: "guild-map", label: "地圖公會詳情(名稱 / 成員 / 據點)" },
  { id: "pal-stats", label: "帕魯物種數值編輯器(PalSchema:HP / 攻防 / 首領)" },
  { id: "bulk-items", label: "批量給予道具(物品選單 + 數量)" },
  { id: "teleport", label: "傳送玩家(玩家 / 地圖座標描點)" },
  { id: "log-tools", label: "日誌重點標記與格式化(事件上色 + 易讀套版)" },
  { id: "dashboard-stats", label: "首頁進階顯示(在線玩家 / 資源用量 / 配置評估健檢)" },
  { id: "save-slim", label: "存檔健檢(組成分析 / 殘留統計)" },
  { id: "leaderboard", label: "伺服器排行榜(等級 / 財富 / 圖鑑 / 最強帕魯 + 掃描差異週報)" },
  { id: "map-unlocks", label: "存檔解鎖(全體玩家快速傳送全開)" },
  { id: "breeding-calc", label: "配種計算(PalCalc 配種路線規劃 + 全服帕魯掃描)" },
  { id: "daily-restart", label: "每天多個固定時刻自動重啟(單一時刻免費;多時刻如 00:00/06:00/12:00/18:00)" },
  { id: "public-map", label: "公開地圖(伺服器地圖公開分享到雲端)" },
];

/** 這個功能是否對所有人免費 —— 只有「不在目錄裡」的功能免費;目錄內為贊助者專屬,無期限。 */
export function featureFreeNow(id: string): boolean {
  return !EARLY_ACCESS_FEATURES.some((x) => x.id === id);
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
 * 統一的功能可用性判斷:免費功能 OR 有有效贊助授權。
 *
 * 目前只有單一贊助層級,識別碼的 `features` 清單僅供顯示 —— 有效贊助者一律解鎖
 * 全部贊助者功能(這樣新增功能不必重發碼 / 改 worker)。若日後要做分層,再把
 * `lic.features.includes(id)` 的判斷加回來即可。
 */
export function hasFeature(id: string, lic: Pick<LicenseStatus, "valid" | "features">): boolean {
  return featureFreeNow(id) || lic.valid;
}
