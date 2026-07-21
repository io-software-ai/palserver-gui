# 野外頭目重生時間研究(2026-07-19)

> 使用者回報「野外頭目重生不是 1 小時、像是遊戲內過一天」。研究確認他是對的。

## 結論
- **官方沒有**頭目重生的技術文件;以下全來自社群觀察(palworld.wiki.gg + Steam 討論),彼此有衝突。
- **野外/地圖固定點頭目(Overworld Alpha Pal)= 下一個「遊戲內黎明」重生**(≈ 過一個遊戲日),**不是固定 3600 秒**。
- **封印領域/地城頭目 = 約 1 小時倒數**,但這 1 小時也是「遊戲內時間」,會隨 DayTimeSpeedRate/NightTimeSpeedRate 縮放。(地城我們已直接讀遊戲算好的 CalcRemainSecondsBy,準,不受此影響。)
- 底層計時是「遊戲內時間」:玩家把流速設 0.1 倍,30 分重生變 5 小時 → 證明綁遊戲時間非牆鐘。
- 預設 DayTimeSpeedRate=1.0 下:白天 ~26–27 分、夜晚 ~5–6 分,一個晝夜 ≈ **32 分現實時間**(非坊間「1 遊戲日=1 現實小時」)。
- ini **沒有**專門的頭目重生秒數參數;只有 DayTimeSpeedRate / NightTimeSpeedRate 間接影響。
- DataTable/拆檔的確切秒數:**未證實**(查不到)。

## 對程式的意涵
- 現有 shared `DEFAULT_BOSS_RESPAWN_SECONDS = 3600`(野外頭目 fallback)**不準**。
- 野外頭目是「下個遊戲黎明」,不是「死亡+固定秒數」→ 任何固定 offset 都會錯。
- 準的做法(擇一):
  1. **模組直接讀遊戲的野外重生時間**(像地城那樣),需在真機探索 BP_PalSpawner_Standard_C 有沒有 next-respawn/time 欄位。← 最準
  2. 模組讀遊戲當前 time-of-day + 日夜流速,估「下個黎明」的現實秒。← 近似
  3. 只信實測 respawnInterval(準),沒實測就顯示定性「擊殺於 HH:MM,下個遊戲日黎明重生」,不硬給倒數。← 現在就能做、誠實
- 註:實測 interval 路線在 ~32 分週期下需要玩家連續在場一整輪,很難捕捉到,靠它不夠。

## 來源
- https://palworld.wiki.gg/wiki/Alpha_Pals
- https://steamcommunity.com/app/1623730/discussions/0/8059829384743167641/
- https://docs.palworldgame.com/settings-and-operation/configuration/
- 日夜長度換算:https://wiki.indifferentbroccoli.com/Palworld/TimeRate(社群)

---

## 追加(2026-07-22):倒數卡死 + 捕捉判斷不到,兩個使用者回報的 bug

### bug 1+2:倒數過了 0 秒還繼續、「約下個遊戲日」永不刷新
根因相同:`bossRespawnInfo` 的「已擊殺」狀態只靠模組觀測到「活著」才解除,沒人在場確認重生就一直卡住。
修法:加 `WILD_BOSS_RESPAWN_GRACE_SEC`(45 分,略寬於一個遊戲日≈32 分現實時間)當寬容期上限,過了就
自動退回 unknown。純函式改動(`packages/shared/src/boss-respawn.ts`),GUI 頭目重生分頁/地圖疊圖/
Discord `/boss` 共用同一份計算,一次修全部受益。已提 47/47 測試(含 2 條新回歸測試)。commit `fcecd95`。

### bug 3:被捕捉的頭目偵測不到(靠 HP 判活,捕捉不會讓 HP 歸零)
研究了 UE4SS 有沒有直接的「捕捉判定」API(見下),但**沒有找到能從 Mac 驗證的可靠即時判定法**,
改用零新 API 風險的邏輯修法。

**研究結果**(subagent 查證,查無實機驗證,標記清楚哪些確認、哪些未證實):
- **確認存在**:`FPalIndividualCharacterSaveParameter.OwnerPlayerUId`(FGuid,野生為空、被擁有後設值)、
  `OldOwnerPlayerUIds`、`OwnedTime` 欄位(出處:localcc/PalworldModdingKit 反編譯標頭)。
  `UPalCharacterParameterComponent.IsCapturedProcessing`(捕捉動畫進行中的旗標,15 秒輪詢容易錯過視窗)。
  `UPalUtility.GetIndividualCharacterParameterByIstanceID(world, instanceId)`(全域依 ID 查個體,不管
  目前在哪個容器)。
- **找到但未證實可靠性**:捕捉球 `BP_PalCaptureBodyBase_C` 有 `OnSuccessedCapture__DelegateSignature`
  等 BlueprintAssignable delegate(出處:Dumper-7 SDK dump,SoTMaulder/SoTMaulder-Palworld)。UE4SS
  `RegisterHook` 掛 BP delegate 路徑的可靠性沒有其他 Palworld mod 先例可循,需要實機測試才能確認會不會觸發。
- **社群先例**:查無其他公開 UE4SS Palworld mod 做過「捕捉 vs 擊殺」的區分。
- **一個過程中的教訓**:研究過程中一次 WebSearch 綜合結果聲稱事件叫 `CaptureSuccessEvent`,subagent
  交叉查證(Sourcegraph 搜遍公開 repo 零命中)後判定是幻覺、已排除,真名是 `OnSuccessedCapture`。

**已實作的修法**(不用上述任何未證實 API,零新反射呼叫、零風險):main.lua 的 `detectAlive` 新增
「確認不在」訊號——spawner 本身這 tick 有被 `FindAllOf` 掃到(代表區域已載入,不是視野外假訊號),
但 `IndividualHandleList:GetArrayNum()` 確實是 0,就回傳 `false`(過去這個情況回傳 `nil`=未知)。
這代表「這隻現在真的不在這裡」,不分是擊殺後遺體立即被清、還是被捕捉帶走——兩者對重生倒數的下游
處理本來就一致(見 v1.4 檔頭註解)。既有的「未曾觀測過活著就不記 diedAt」安全網不受影響(純邏輯
上的正確性可推導,不需要新 API)。mod 版本 v1.3→v1.4,commit 待定。

**尚未驗證**:這個修法邏輯上正確(spawner 是持久世界物件,個體數與 spawner 是否被掃到本是獨立的兩件
事),但沒有在真實遊戲裡「捕捉一隻頭目、看重生倒數是否啟動」實測過。接手時请在 Windows 測試機驗一輪:
部署新 mod → 捕捉一隻已追蹤的頭目 → 15~30 秒內看 `boss-state.json` 或 GUI/Discord `/boss` 該隻是否
變成 `alive:false` 且 `diedAt` 有值。log 會印 `boss DOWN: <name> at <ts> (empty)` 區分於舊有的 `(hp)`。
