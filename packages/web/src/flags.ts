/**
 * 前端功能旗標。
 *
 * 贊助者先行版功能(自訂帕魯 / 帕魯蛋 + 贊助者識別碼)尚未對外公布,先把 UI 入口
 * 全部隱藏。要正式公開時把這個改成 true(未來也可改接環境變數 / 遠端設定)即可,
 * 不用動各處元件。後端路由本來就有授權閘門,隱藏入口即足夠。
 */
export const SHOW_SPONSOR_FEATURES = true;

/** 快速傳送全開(存檔解鎖):功能已完成但先隱藏,待 Windows 實機驗證後開放。 */
export const SHOW_FAST_TRAVEL_UNLOCK = false;
