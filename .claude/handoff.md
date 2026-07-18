# Handoff:頭目重生時間功能頁(2026-07-18 深夜)

> 舊 handoff(7-15 存檔工具)已完成並出貨,本檔取代之。

## 使用者需求(原話)
「做一頁頭目重生時間(包含所有boss) 跟 palschema 頁一樣要求安裝模組流程什麼都一樣 然後顯示重生頭目列表」——純伺服器端模組(已與使用者確認)。

## 已完成(2026-07-18 session)
- **PalserverBossReporter v0.5 Lua 模組**:`mods/palserver-boss-reporter/Scripts/main.lua`(已 commit)。每 15s 輪詢 `FindAllOf("BP_PalSpawner_Standard_C")`,名稱含 BOSS 過濾(FBOSS=野外頭目),寫 `Pal/Saved/palserver-boss-state.json`(bosses[{name,alive,diedAt,respawnedAt,x,y,z}]),活→死/死→活轉變記時間戳,重啟自恢復。
- **實測結論**(Windows 測試機 test-host-save 實例,經 agent API 全遠端部署迭代 5 輪):
  - 屬性讀取可靠;**BP 函式呼叫(ExistAliveCharacter 等)UE4SS setup 失敗,不可用**。
  - 判活用 `tempSpawnedMonster:IsValid()` —— 已驗證回布林(無玩家時 false=未生成,合理)。
  - 無玩家時只載入部分世界(161 spawner/僅 2 FBOSS)——未載入區域=未知,UI 要誠實顯示這個限制。
  - spawner 名稱格式 `81_1_grass_FBOSS_4`;對應地圖頭目用座標配對(state 的 x,y,z 是世界座標)。
  - 存檔沒有野外頭目狀態(詳見 .claude/notes/boss-respawn-research.md);地城頭目在 DungeonSaveData(BossState/RespawnBossTimeAt)可日後另做。
- 測試機殘留:模組已部署在 `ue4ss/Mods/PalserverBossReporter/`+mods.txt 有 `PalserverBossReporter : 1`(正式安裝管線要能冪等覆蓋);agent token 在對話中,勿寫進 repo。

## 待做(建議開新 session 執行)
1. **Lua 定稿 v1.0**:拿掉 tickCount==1 的 diag 區塊;真實玩家上線後驗證活→死轉變(需有人打頭目)。
2. **agent**:新 `boss-reporter.ts`,安裝流程照 `palschema.ts` 模式(先讀它):install=寫 main.lua(內容 embed 進 agent 常數,建議 scripts/ 生成)+mods.txt 加行;GET `/api/instances/:id/boss-respawns` 回 {modInstalled, state}。UE4SS 未裝→沿用既有 UE4SS 安裝流程(PalStatsTab 已有)。
3. **shared**:型別+`EARLY_ACCESS_FEATURES` 加 `{ id: "boss-respawn", label: "頭目重生時間(全頭目死活/重生倒數)" }`(依近期慣例 gate,回報使用者一行可改)。
4. **web**:tabPrefs 加 tab `bossrespawn`「頭目重生」(不進預設可見,knownTabs 遷移自動處理舊使用者);`BossRespawnTab.tsx` 抄 `PalStatsTab.tsx` 結構(gating→未裝=ModInstallCard→已裝=清單)。清單=「全頭目」:`bosses.json`(全野外頭目 name.zh/en/ja+地圖座標)LEFT JOIN 模組回報(世界→地圖座標轉換抄 MapTab.tsx 玩家那套);每列:帕魯名+等級+狀態(活著/已擊殺 HH:MM/未知-區域未載入)+重生倒數(diedAt+3600s 預設;respawnedAt-diedAt 有實測值優先)。state 過時(>60s)顯示警告。
5. **i18n ×3**:字典有使用者 public-map WIP 未 commit 的 key——commit 一律 surgical staging(git diff -U0 過濾自己 key 的 hunk→git apply --cached --unidiff-zero,本 session 兩次成功)。
6. **驗證**:playwright mock 三態(鎖定/未裝=安裝卡/已裝=清單);實機用測試機(tailscale 100.94.33.62:8250,token 向使用者要)。
7. 記入 .claude/notes/next-release.md。

## 陷阱備忘
- working tree 有使用者 public-map WIP(agent env/index/routes/shared/stats/web api/MapTab/i18n×3+未追蹤 public-map.ts、PublicMapModal.tsx)——絕不 stash/revert/commit 它們。routes.ts 他也改了:新端點寫在新檔案,registerRoutes 掛載行 stage 時小心。
- 遠端部署鏈不要 heredoc 混 `&&`(python 失敗後續行照跑,踩過)。
- cwd 常飄到 website/,指令前 `cd /Users/eason/Studio/projects/palserver-gui`。
