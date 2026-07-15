# 下一版 release 草稿(尚未發布)

v2.2.6 已發布(2026-07-15:彙整 2.2.4–2.2.6 更新失敗修復包,notes 涵蓋 DD 自我修復/清場/診斷尾段/停止時清場)。v2.2.4 同日(DD 損毀自我修復)。v2.2.3 同日(立即更新常駐)。v2.2.2 同日(hotfix:重灌 EPERM/名稱埠同步/簡中搜尋)。v2.2.1 同日發布(存檔深度整合大版本 —— 玩家/公會完整檔案(離線可查)、
存檔健檢、重灌伺服器、共玩存檔自動修復、世界設定 ini 同步、首頁進階顯示、
人類 NPC/研究目錄。完整清單見該版 RELEASE_NOTES 或 git log v2.1.1..v2.2.1)。
發版流程:bump 四個 package.json → 四語 RELEASE_NOTES → chore(release) commit → tag → push --tags。

## Features(自 v2.2.6 起)
- PR #32(BlackWhiteTW):遺物指令 RelicType 參數、自訂帕魯濃縮計算、UE4SS 測試版下載、等級上限、地圖 Z 軸與多國語系修正。
- PR #29(teps3105,closes #26):REST 埠 1:1 映射(docker 不再用 ephemeral port)、
  建立/複製實例自動分配 REST 埠、世界設定 PUT 補 REST/RCON 撞埠檢查、
  native 改設定即時寫回 ini。**升級注意:既有 docker 實例要 stop→remove→start 一次**。
- PR #18(UCKETX,fixes #31):簡中全面校對(442 條 UI 字串+目錄譯名升級為人工欄位 "zh-CN")、
  下拉搜尋支援簡中名稱、MIGRATION.zh-CN.md。合併時已整合 main 的日文搜尋/六目錄/永久贊助文案;
  抓取腳本改為不覆寫人工 "zh-CN" 欄位。

## 待確認 / 需實機驗證(v2.1.1 遺留)
- 礦物圖層與公會成員定位:實機視覺確認(圓點密度/顏色分辨度、flyTo 縮放層級)。
- stats worker 已搬到新帳號(stats.iosoftware.ai);舊帳號 workers.dev 是轉發 proxy,不要刪。

## 待確認 / 需實機驗證(v2.1.0 遺留)
- Windows 實機:host-save-fix 修復後的存檔由遊戲實際載入(位元組級已與參考工具一致)、
  匯入存檔的 Windows 路徑輸入、DepotDownloader 真實輸出的進度解析、SEA 打包下的
  ooz-wasm 載入(oodle.ts 的 Function 轉換路徑)。
- 原生日誌擷取、不彈黑窗、日誌翻譯、世界設定 reconcile —— 皆需在 Windows 實機確認。
- 離線玩家詳情:實機上 /player 仍失敗,確認可用前不要在 notes 宣傳。
