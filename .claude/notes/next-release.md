# 下一版 release 草稿(尚未發布)

(目前無草稿。)

v2.8.0 已發布(2026-07-22:修復為主。UE4SS 內建載入器改用 Palworld 專用的 Okaetsu fork
(experimental-palworld,GH_REPOS.ue4ss 鎖 tag,stable=UE4SS-Palworld.zip、beta=zDev)——
模組閃退大減;UE4SS 以標準資產 updated_at(建置日期)標版本+偵測更新(releaseVersion)。
**根治「停服殘留 PalServer 鎖檔擋更新」老問題**:killLeftoverProcessesUnder 從 Get-Process 的
$_.Path(需開行程控制代碼、會靜默漏抓)改用 Get-CimInstance Win32_Process 的 ExecutablePath 可靠
列舉(commit b5c1977;測試機實測 install 從 hang 110s→5.7s)。boss-reporter 修復:PR#53 v1.6
地城掃描當機、野外一律「約下個遊戲日重生」(移除 measured 倒數分支,修 22:00:00 殘留值 bug);
**改遠端交付**——原始碼獨立 repo io-software-ai/palserver-boss-reporter(含 release CI 依檔頭版本自動發
Release),agent 純遠端下載無內嵌 fallback、分頁「有新版」徽章。安裝下載>10s 跳黃色殭屍進程警告
(SlowInstallWarning,重開機/工作管理員指引)。mod install 支援 url 覆寫 + 下載 timeout(限速地區走
鏡像)。合併 PR#45(ARM64 Docker/FEX)、#52(伺服器端資料夾瀏覽器+兩階段 tp+pgbroadcast REST+
自訂帕魯濃縮 UI+WorldTreeRelic 物品)、#49(捕捉輔助配種+帕魯倉庫/公會據點位置)、#46 zh-CN 目錄
翻譯;Tailscale/CGNAT 100.64.0.0/10 放行目錄瀏覽。四語 RELEASE_NOTES 已更新。PR#46/#47 為 PR52 子集,
建議關閉;PR#42(backend 重構)因舊 base 大衝突暫緩。)

v2.7.0 已發布(2026-07-22:主打贊助者新功能「Discord 官方機器人」—— 同機貼 token 即用(agent 自跑+監督,
免 Docker/手動註冊指令)、18 支 slash 指令回控伺服器、每分鐘更新的狀態面板、事件通知、管理員白名單;
也支援進階自架(另機/Docker)+ 第三方 bot 開發者指南 + 完整 Agent REST API 文檔。另一大功能「Webhook
事件通知」分頁(事件→Discord webhook / 自訂 HTTP + HMAC)。皆為贊助者先行(SponsorLockNotice gating)。
其他:停止/重啟倒數可取消、傳送選點地圖疊頭目/地標、公會據點與名稱全用戶可見、愛發電贊助管道(簡中查碼 UI)、
boss-reporter 修正(v1.4/v1.5:捕捉判不在、觀測不可信清舊倒數、野外一律顯示「下個遊戲日」)。四語 RELEASE_NOTES 已更新。)

v2.6.0 已發布(2026-07-19:主打「頭目重生時間」贊助功能對外開放。伺服器端 UE4SS 模組
PalserverBossReporter v1.3:野外+地城頭目死活/重生;**狀態黏著**(看過活的一直記活、擊殺後倒數
不因玩家離開/spawner 卸載而停),已在 Windows 測試機實機驗證(重啟後 loadPrevState 保留 diedAt、
bossCount 3→21 穩定)。頭目重生分頁(贊助 gating,未解鎖只顯示說明卡、不預覽內容)。GUI 地圖與
公開地圖疊頭目重生 —— 地城頭目本就在 bosses.json 同座標,一個「頭目」開關一起疊(野外用
state.bosses、地城用 state.dungeons)。**野外頭目重生綁「遊戲內時間」(下個遊戲日,非固定 1 小時**;
測試機實測 FairyDragon respawnInterval=1170s 佐證;已移除錯誤的 DEFAULT_BOSS_RESPAWN_SECONDS=3600):
有實測才給精準倒數,否則定性「約下個遊戲日重生」;地城頭目時間由遊戲內建、精準。另:兩張地圖
移除礦物層、頭目改名並區分 Alpha/封印領域。研究/計畫:.claude/notes/wild-boss-respawn-research.md、
boss-map-integration-plan.md;memory `boss-respawn-feature.md`。)

v2.5.0 已發布(2026-07-19:兩個贊助者新功能 —— 公開地圖(服主一鍵把伺服器地圖公開成全網唯讀連結、
細項隱私設定、viewer 對齊管理員地圖呈現+官網品牌外框+四語、部署到 stats worker + Zeabur /map)、
配種計算(PalCalc,PR#43 UCKETX,存檔掃全服帕魯算最短配種路線);pals.json 補屋久島 12 物種;
分頁顯示修正(反作弊 tab、新分頁預設隱藏);官網下載按鈕依平台直連+更新日誌頁。
**頭目重生時間已 commit 但用 SHOW_BOSS_RESPAWN=false 隱藏,本版不對外開放**(見下方,待 Windows 驗證))。

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
