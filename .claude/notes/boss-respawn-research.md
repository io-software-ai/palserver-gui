# 頭目重生時間:伺服器端資料來源研究(2026-07-18)

> 方法:社群/文件研究(web agent)+ 真實存檔解剖(Windows 測試機 test-host-save 的 Level.sav,
> 經 agent API 備份下載、docker palsav 轉 JSON,886KB sav → 22MB JSON,flushedBeforeBackup=true)。
> 樣本與腳本:scratchpad(session 結束即失效);本檔為長期結論。

## 結論(TL;DR)

1. **野外頭目(field Alpha):存檔裡完全沒有狀態**——活體不落盤(嚴格分類 BOSS_ 角色 58 隻:52 有主人、6 無主但有 SlotId/OldOwnerPlayerUIds=容器內,真野生 0)、spawner 冷卻不落盤。要拿到重生時間**只有 UE4SS Lua 伴侶模組一條路**(已有兩個現成 mod 證明可行)。
2. **地城頭目:存檔直接有完整狀態**——`DungeonSaveData` 每筆含 `BossState`(enum `EPalDungeonInstanceBossState::Spawned/...`)、`RespawnBossTimeAt{Ticks}`、`DisappearTimeAt{Ticks}`、`DungeonSpawnAreaId`、`MarkerPointId`。擴充既有存檔掃描管線就能做(本次樣本 145 座地城全為 Spawned/0,擊殺後的 tick 基準待一筆實測樣本確認,推測對齊 `GameTimeSaveData.RealDateTimeTicks`)。
3. kill-log 推算路線不可行:官方 REST(/game-data 只回角色快照,無 spawner)、PalDefender、stdout log 都沒有頭目擊殺事件;且社群實測野外頭目 1 小時計時**在世界重載時歸零**(runtime-only 計時,與「不落盤」互相印證)。

## 實證明細(Level.sav 內部,社群未公開文件的部分)

- `worldSaveData.MapObjectSpawnerInStageSaveData` → `SpawnerDataMapByLevelObjectInstanceId`(13,779 筆,GUID→ItemMap):內部欄位為 **`NextLotteryGameTime`(Int64,-1=無排程,對齊 GameDateTimeTicks 刻度)+ `MapObjectInstanceId`(Guid)**——只管**地圖物件**(寶箱/礦點)重生抽籤,與頭目無關。本樣本 830 筆有排程值。
- `DungeonSaveData.values[]` 欄位全集:InstanceId, DungeonType, MarkerPointId, DungeonSpawnAreaId, DungeonLevelName, **BossState, EnemySpawnerDataBossRowName(如 "29"), RespawnBossTimeAt, DisappearTimeAt**, StageInstanceId, MapObjectSaveData, RewardSaveDataMap, ReceivedBonusExpPlayerIds, ReservedDataLayerAssetIndex。
- `WipedOutEnemySpawner`/`OpenedTreasureBoxSpawner`:只存在 `OilrigSaveData`(油井房據點清剿狀態),非野外頭目。
- `SupplySaveData.LastLotteryTime`(DateTime):空投抽籤,無關。
- 時間基準:`GameTimeSaveData = { GameDateTimeTicks, RealDateTimeTicks }`。

## 路線比較

| 路線 | 野外頭目 | 地城頭目 | 成本 | 判定 |
|---|---|---|---|---|
| A. 存檔掃描擴充(既有 palsav 管線) | ✗ 資料不存在 | ✅ 直接可讀 | 低 | **地城可做** |
| B. UE4SS Lua 伴侶模組(server 端 hook `BP_PalSpawner_Standard_C`,GetSpawnerName 含 "BOSS",寫 sidecar 檔給 agent 讀) | ✅ 唯一已證實路線(Boss Respawner mod / Alpha Respawn Scheduler mod 先例,後者純 server 端+自建持久化) | ✅ 也可 | 中高(要出貨一個 Lua mod;但專案已有 UE4SS 安裝管線,天然契合) | **野外唯一解** |
| C. kill 事件+固定冷卻推算 | ✗ 無事件源;計時重載歸零 | — | — | 否決 |
| D. 官方 REST / PalDefender / log | ✗ 皆無頭目端點/事件 | ✗ | — | 否決 |

出處:paldb 型別註冊 cheahjs/palworld-save-tools paltypes.py;mod 先例 curseforge.com/palworld/lua-code-mods/bossrespawner、palmods.gg/mod/alpha-respawn-scheduler;重載歸零 steamcommunity.com 討論串 4203616776858005809;REST 端點 docs.palworldgame.com/api/rest-api/。

## 若要做,建議的兩階段

1. **先做地城頭目**(便宜):存檔掃描多抽 DungeonSaveData → 地圖疊「地城頭目已擊殺/幾點重生」。前置:在測試機殺一隻地城頭目→重掃,確認 BossState 擊殺態 enum 值與 RespawnBossTimeAt 的 tick 基準。
2. **野外頭目做 UE4SS 伴侶模組**(palserver-boss-reporter.lua):hook spawner、每 15s 把 {spawnerName, 剩餘秒} 原子寫入 sidecar JSON,agent 讀檔開端點,地圖疊層。屬性名要在測試機用 UE4SS Live View 實測(mod 先例證明拿得到,但沒公開屬性名)。
