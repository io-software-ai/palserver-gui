# Open Issues / PR Triage — 2026-07-16

repo: io-software-ai/palserver-gui（原 repo id 1295649165）
資料來源：GitHub REST API（`/repos/io-software-ai/palserver-gui/issues`、`/pulls/{n}`、`.diff`），2026-07-16 擷取。
共 12 open issues + 2 open PR，全部涵蓋。

---

## Issue #31 — 给予道具指令下拉列表不能使用简体中文匹配名字
回報者：BraveCowardp
症狀：給道具指令的下拉選單搜尋，輸入簡體中文無法比對到道具名稱（只附兩張截圖，無文字說明細節）。
重現條件：截圖顯示搜尋框輸入簡中字未出現結果，具體操作步驟未附。
維護者回覆：Wadoekeani「抱歉 會再補上」（承認缺口，會補搜尋比對）。
**關聯**：PR #18 的 diff 說明含「搜索功能支持匹配简体中文游戏名称」——極可能是同一個修復，PR #18 合併後此 issue 可望一併解決。
分類：**可直接修**（且已有 PR #18 在路上，先審 PR 再看是否閉單）

## Issue #30 — RCON 已被官方廢棄，規劃淘汰時程與遷移計畫
回報者：teps3105
症狀：非 bug，是架構規劃請求——官方文件已標示 RCON deprecated 且即將停用，本專案 agent 大量功能（Console、給道具、給帕魯、傳送、封禁/白名單、版本偵測、PalDefender 熱重載）仍依賴 RCON，要求盤點 REST API 替代方案並訂遷移時程。
維護者回覆：「有規劃進行遷移 已經有部分指令背後跑 REST api」——已有共識方向，未給時程表。
分類：**功能請求**（架構/roadmap 規劃，非緊急 bug）

## PR #29 — fix: REST埠1:1及鏡像port衝突檢測（`feat/rest-port-1to1` → `main`）
作者：teps3105，Closes #26
變更檔案（4）：`packages/agent/src/docker.ts`、`restapi.ts`、`routes.ts`、`store.ts`（+100/-27）
內容：REST port 改 1:1 映射（container/host 都用 RESTAPIPort，移除 `restHostPort()`）；native settings PUT 即時寫回 `PalWorldSettings.ini`；`/duplicate` 複製實例時自動分配新 RESTAPIPort（不再沿用來源）；settings PUT 補 PublicPort(game port) + RCONPort 衝突檢測。
注意事項（PR 自述）：既有 docker 實例的容器仍綁 ephemeral port，升級後需手動 stop→remove→start 一次。
**GitHub 回報 `mergeable_state: dirty`**——與目前 main 有衝突，需要 rebase 才能合併。
分類：**PR 待審**（邏輯合理但需先解衝突再審）

## Issue #26 — REST API port 衝突 + native 設定不寫入 ini + 鏡像伺服器 port 衝突
回報者：teps3105（提交者本人同時是 PR #29 作者）
症狀：三個子問題——(1) 多伺服器 REST port 衝突：docker port 寫死 8212、host 用 ephemeral，無自動分配/衝突檢測；(2) native 改設定只存 store.json，沒寫入 ini；(3) 鏡像/複製伺服器時 port 衝突偵測不完整（`/duplicate` 沿用來源 RESTAPIPort、settings PUT 不驗 gamePort/RCONPort、k8s hostNetwork:true 時 namespace 隔離失效但 agent 不知情）。
Issue 本文已註明「已修復」——即 PR #29 的內容，這是先寫 issue 記錄問題、再開 PR 修的流程。
分類：**PR 待審**（本體已由 #29 覆蓋，等 #29 rebase 過了即可一併關閉）

## Issue #23 — 儘管組態正確，REST API 仍持續回傳 "Unauthorized (AdminPassword is empty)"
回報者：lk86jeff
症狀：Debian 12 LXC 容器環境，AdminPassword 已在 ini 與 GUI 正確設定，REST API 仍判定密碼為空並回 401；伺服器與 port 8211/8212 監聽正常。
重現：LXC 安裝 → 匯入本機共玩存檔建立伺服器 → GUI 設密碼 → 啟動 → 觀察到持續 401。
**回報者已自行解決**：刪除所有 `WorldOption.sav` 檔案後恢復正常（引用 palworld-server-docker issue #214 的解法——舊存檔殘留的 WorldOption.sav 會蓋掉新密碼設定）。
維護者未回覆此解法。
分類：**可直接修**（已知根因與解法：匯入存檔流程應偵測/清除殘留 `WorldOption.sav`，或至少在文件/診斷訊息提示此步驟）

## Issue #22 — 安装PalDefender与UE4SS 模组载入器失败
回報者：irlish
症狀：只有兩行瀏覽器 console 錯誤——`.../mods/ue4ss/install` 500、`.../mods/paldefender/install` 500，無 agent 端錯誤堆疊、無環境資訊、無重現步驟。
維護者：無回覆。
分類：**待回報者補資訊**（需要 agent 端的 500 錯誤詳細 log／stack trace 與環境資訊才能定位）

## Issue #15 — 道具掉落量倍率/敵人掉落物品倍率
回報者：qq5698263
症狀：`CollectionDropRate`／`EnemyDropItemRate` 設定值上限只能到 3 倍，希望能設更高（如 10 倍）。
討論串：維護者問「你希望有多少倍」→ 回報者要求至少 10 倍 → 維護者回「新版可以改嘍」→ 回報者致謝。
分類：**可直接修**（維護者已表示新版已放寬上限，待確認/關閉）

## Issue #14 — 功能建議
回報者：LiMoon
症狀（三項獨立建議）：
1. 無人在線 x 秒後自動暫停伺服器、有人登入自動恢復（省電），參考 palworld-server-docker 的 autopause script。
2. 模組頁面應標註「僅 Windows 平台支援」，避免 Linux 使用者誤會可用。
3. Windows 版網頁啟動後會多跳出一個終端機視窗，希望能靜音/背景執行。
維護者回覆：「好的沒問題 我參考看看」（尚未承諾實作）。
分類：**功能請求**（三個子項都是功能/UX 建議，非 bug）

## Issue #9 — 配置文件中存在值类型错误
回報者：Null993
症狀：`RandomizerSeed` 應為 string，但目前被寫成整數，導致 ini 出現 `Missing opening '"' in string property value` 警告；手動改 ini 也會在伺服器啟動時被重置回整數形式。
維護者回覆：「原來是這樣嗎！？」（訝異，尚未確認修復）。
分類：**可直接修**（症狀與根因都明確：schema 序列化 RandomizerSeed 時少加引號）

## Issue #7 — 重复运行实例
回報者：Arispex（v2.0.0-alpha.5）
症狀：後端伺服器程式其實已啟動，但網頁仍顯示「未運行」，因而持續嘗試啟動，導致背景疊加十幾個重複的伺服器行程。回報者自陳「還無法穩定複現」，遇過兩次。
維護者回覆：「麻煩幫我下載目前最新版 問題應該已經修正了」（懷疑已在後續版本修掉，但無法確認舊版根因對應到哪次修復）。
分類：**需實機重現**（狀態同步的競態問題，不穩定重現，需要實機驗證新版是否真的修好）

## Issue #5 — win系统版本无法通过ssh安装，win系统实体服务器只能通过有完整桌面环境安装
回報者：705152138-cyber
症狀：本文空白，僅標題陳述限制——Windows 版無法透過 SSH 安裝，實體 Windows 伺服器只能在有完整桌面環境下安裝。
討論串：回報者提議「SSH 安裝完後給配對碼即可在控制端配對使用」→ 維護者回「現在就是這樣啊 有純 agent 版本」→ teps3105 補充「直接讓你的 agents 透過 ssh 連線 安裝到服務器上」（暗示可用 agent-only 安裝模式，但溝通尚未收斂到具體規格）。
分類：**功能請求**（Windows headless/SSH 安裝流程，屬於架構層級的功能請求，非明確 bug）

## PR #18 — fix(i18n): 优化简体中文语法、用词与本地化体验（`main` → `main`，作者帳號自身分支）
作者：UCKETX
變更檔案（24 個，+1617/-208）：橫跨 `README.zh-CN.md`、`docs/MIGRATION*.md`、`docs/game-data-maintenance.md`、`packages/web/public/game-data/*.json`（技能/首領/物品/地標/帕魯/被動）、`packages/web/public/i18n/zh-CN.json`、`packages/web/src/{EntityPicker,MapTab,MultiPicker,announcement,gameData,i18n}.tsx/ts`、`styles.css`、三個 `scripts/*.mjs`、`website/i18n/{config,dictionaries}.ts`。
內容：大規模簡體中文在地化校對——不再只是繁轉簡的字形轉換，而是依大陸用語習慣重寫（設置/创建/远程/链接/文件夹/内存/端口 等術語統一）、校正遊戲功能譯名（反外挂/模组/传送玩家）、補完安裝進度/存檔匯入/主機角色遷移的簡中翻譯、**新增搜尋功能支援簡體中文遊戲名稱匹配**（與 issue #31 高度相關）、並確保人工校對譯文不被遠端生成資料覆蓋。
維護者回覆：「感恩 我有空會看」（尚未審）。
**注意**：repo 近期 commit 歷史（`0cc1a39 fix(i18n): 簡中「汇入」改為慣用語「导入」`）顯示維護者本人已直接在 main 上做過零星簡中用詞修正，與此 PR 的大範圍改動可能有重疊/衝突，需要仔細 diff 比對是否已有部分內容被獨立修掉，避免合併時互相覆蓋或衝突。
分類：**PR 待審**（範圍大、觸及 game-data 與 i18n 核心檔案，建議先確認是否與近期直接 commit 衝突，再逐檔審閱）

---

## 摘要表

| # | 一句話症狀 | 分類 |
|---|---|---|
| 31 | 簡中無法比對道具下拉選單名稱 | 可直接修（PR #18 可能已含修復） |
| 30 | RCON 已棄用，要求盤點 REST API 遷移時程 | 功能請求 |
| 29 (PR) | REST port 1:1 + 鏡像 port 衝突檢測，Closes #26 | PR 待審（有 merge conflict，需 rebase） |
| 26 | REST/native ini/鏡像三個 port 衝突問題 | PR 待審（由 #29 覆蓋） |
| 23 | AdminPassword 設了仍 401，殘留 WorldOption.sav 導致 | 可直接修（根因已知） |
| 22 | 安裝 PalDefender/UE4SS 回 500，無詳細 log | 待回報者補資訊 |
| 15 | 掉落率倍率上限只能 3 倍 | 可直接修（維護者稱新版已放寬） |
| 14 | 自動暫停/模組頁面加註/Windows 隱藏終端機 三項建議 | 功能請求 |
| 9 | RandomizerSeed 應為 string 卻寫成整數 | 可直接修（根因明確） |
| 7 | 網頁誤判未運行、重複啟動多個伺服器行程 | 需實機重現（不穩定競態） |
| 5 | Windows 無法純 SSH 安裝，需完整桌面環境 | 功能請求 |
| 18 (PR) | 簡中在地化大幅校對，24 檔 +1617/-208 | PR 待審（需核對與近期直接 commit 是否衝突） |

完整整理已涵蓋 12 issues + 2 PR，一個不漏。API 均正常回應，無失敗項目。
