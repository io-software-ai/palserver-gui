# 下一版 release 草稿(尚未發布)

## 配種計算(PR #43 已合併 + 收尾)
- feat:PalCalc 配種計算分頁(UCKETX,PR #43):存檔掃描全服帕魯→最短配種路線樹狀圖。
- 已納入贊助者功能(breeding-calc);審查後修正:計算中提示真的會顯示(雙層 rAF)、改條件清舊結果、掃描輪詢斷線停止+unmount 清理、配方 2.3MB 模組級快取、機率性遺傳免責文案、EmptyState 統一、四語 README 同步。
- 已補:pals.json 302 筆(屋久島/泰拉瑞亞聯動 12 筆含四語名+圖示);新分頁對自訂過清單的使用者也預設隱藏(knownTabs 遷移)。待辦:同步求解未來可移 Web Worker;self-only 物種無解提示可再精準。

v2.4.1 已發布(2026-07-18:玩家頁改 WebSocket 推播 PR#39(LilaS-tw,含審查後 4 修:新鮮 rec/刪除收攤/輪詢兜底/錯誤字串化);反作弊插件 tab 消失修復(PalDefender 已安裝→分頁預設顯示))。

v2.4.0 已發布(2026-07-18:新手開服重設計/邀請朋友三選一/分頁拖曳+管理面板/
帕魯數值大升級(原版值+工作適性+熱重載)/模組停用不刪檔+新版偵測/出事說人話/
自動備份+開機自啟+立即停止/Wine+K8s(PR#36)/配置健檢;修更新後 404、CPU 亂跳。
隱藏功能:快速傳送全開(SHOW_FAST_TRAVEL_UNLOCK=false,待 Windows 驗證)。
Windows 待驗:PalDefender 停用實效、PalSchema 資料夾停用實效、熱重載 dedicated 實效、
開機自啟 Run key、立即停止實測)。

v2.3.0 已發布(2026-07-16:排行榜/伺服器大事/圖鑑完成度/世界樹地圖+三圖層/
每日多時刻重啟(贊助 daily-restart)/BOSS 帕魯/簡中完整在地化;修排程重啟停擺、
存檔掃描等級/IV(ByteProperty+重複實體+預設值)、REST 埠 1:1+跨協定撞埠。
docker 既有實例需 stop→remove→start 一次)。
v2.2.6 已發布(2026-07-15:彙整 2.2.4–2.2.6 更新失敗修復包,notes 涵蓋 DD 自我修復/清場/診斷尾段/停止時清場)。v2.2.4 同日(DD 損毀自我修復)。v2.2.3 同日(立即更新常駐)。v2.2.2 同日(hotfix:重灌 EPERM/名稱埠同步/簡中搜尋)。v2.2.1 同日發布(存檔深度整合大版本 —— 玩家/公會完整檔案(離線可查)、
存檔健檢、重灌伺服器、共玩存檔自動修復、世界設定 ini 同步、首頁進階顯示、
人類 NPC/研究目錄。完整清單見該版 RELEASE_NOTES 或 git log v2.1.1..v2.2.1)。
發版流程:bump 四個 package.json → 四語 RELEASE_NOTES → chore(release) commit → tag → push --tags。

## Features(自 v2.2.6 起)
- **排行榜分頁**(贊助 feature `leaderboard`):等級/財富/圖鑑收集/最強帕魯/公會五榜+
  「與上次掃描相比」變化報告;資料來自健檢掃描統計歷史(save-stats-history.json,每世界 60 筆)。
- **圖鑑收集完成度**(玩家詳情,沿用 save-slim 鎖):玩家 .sav RecordData 的
  PaldeckUnlockFlag ∪ PalCaptureCount,完成度進度條。
  **待實機驗證**:Windows 真實存檔掃一次,確認圖鑑數/榜單數字合理(mac 無法掃)。
- 自動重啟遊戲內倒數公告 i18n(儲存重啟設定時以介面語言存模板)。
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
