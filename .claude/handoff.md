# Handoff(2026-07-15,更新:存檔工具全家桶已實作)

## 存檔快照生態(save-slim 贊助鎖)— 本 session 最終形態

一條掃描管線(健檢按鈕/從存檔刷新,同一個 job)產出三份資料,全部離線可用、不依賴 PalDefender:
1. **健檢報告**(存檔頁卡片):組成統計+不活躍玩家+空公會+worldSections 診斷清單。
2. **玩家快照**(玩家詳情合併視圖):帕魯(IV/詞條/星級/位置分頁:身上/帕魯箱/據點)、
   離線背包/武器/防具/重要物品/食物/金錢、公會職位+據點跳地圖、加點分配。
3. **公會快照**(新「公會」分頁):成員+最後上線、據點+駐守工作帕魯+跳地圖、
   公會倉庫(二趟掃描收集)、研究進度。
其他本輪修復:共玩 WorldOptions.sav 偵測/停用+匯入自動處理、主機修復含帕魯過戶+
獨立「過戶帕魯歸屬」、人類 NPC 目錄(humans.json 432 筆+圖示)、14 張 0-byte 帕魯圖示重抓、
三語公告(WorldOptions 解法)。

**待實機驗證(Windows 測試機,agent 要跑最新 code)**:重掃一次存檔後——
健檢數字合理、玩家詳情(在線含詞條/離線/物品/公會/加點)、公會分頁、據點跳地圖。
**頭目重生時間**:上游零支援,傾向不落盤;重掃後看健檢報告的 worldSections
有無 boss spawner 類 section,有就能接、沒有就是確定做不了。

## 存檔健檢(save-slim Stage 1)— 本次新增

- 實作規格:.claude/notes/save-slim-impl.md(含已查證的上游事實與 JSON 欄位路徑)。
- 已交付:palsav-tools.yml workflow、agent save-tools.ts/save-health.ts(+單元測試 3/3)、
  GET/POST /api/instances/:id/saves/health、web HealthCard(贊助鎖 save-slim)、三語 i18n。
- **接下來必做(依序)**:
  1. ~~跑 palsav-tools workflow~~ ✅ 已完成(run #2 success,release palsav-tools-v1 四資產齊;
     首跑的 mv 檔名 bug 已修於 a6193d6)。
  2. Windows 測試機(Tailscale)真實世界存檔端到端:開始健檢 → 報告出現。
     離線天數基準已照上游作法改用存檔內世界時鐘 GameTimeSaveData.RealDateTimeTicks
     (mtime 只當 fallback,來源:.claude/notes/upstream-clean-logic.md 子題 6),
     實機仍順眼確認天數合理即可。
  3. mac dev 順眼確認卡片顯示「不支援」訊息而非壞掉。
- **玩家快照(同 session 追加)**:同一次掃描順帶產出玩家檔案+名下帕魯明細
  (個體值/詞條/星級/幸運/頭目),端點 GET /saves/players-snapshot(worldGuid 可省略)。
  依使用者要求,PlayerDetailModal 已改為 REST+存檔**單一合併視圖**(不分兩塊):
  帕魯以 InstanceId 跨來源對上、REST 缺席時整體退回存檔資料;快照/掃描的各種
  失敗狀態(無啟用世界、agent 舊版 404、mac 平台不支援)都顯式呈現,修掉死按鈕。
- Stage 2(清理/寫回)**使用者決定擱置**,計畫在 save-slim-plan.md;上游清理演算法研究
  已落檔 .claude/notes/upstream-clean-logic.md(關鍵:now 基準=GameTimeSaveData.RealDateTimeTicks、
  級聯刪除規則、必須同步的索引欄位)。另:stream-json 3.x 的 stringer 對 packed-only token
  流會丟內容(scratchpad spike 實測),Stage 2 寫回若走 parser→filter→stringer 要先解決這個
  (可能要 packValues+streamValues 並開,或自寫 stringer)。

## 本 session 完成(全部已 push)

- 授權伺服器搬遷收尾:secrets 已重設並驗證;端點 stats.iosoftware.ai,舊 workers.dev 是舊帳號上的轉發 proxy(見專案 memory `stats-worker-deployed`)。
- v2.1.1 已發版(release CI 全綠、8 資產)。
- 首頁進階顯示(贊助者,feature id `dashboard-stats`):總覽加總板塊 + 卡片六項資訊(佔位符對齊),玩家名單已移除、第六格為影格時間。
- 贊助功能改永久收費:features.ts 去除 until 機制;README×4 與 website 文案同步改。
- 地圖:礦物圖層(ores.json,scripts/fetch-map-ores.mjs 可重跑)、公會詳情帕魯頭像+在線成員點擊 flyTo。
- 效能三連(commit b818d6c):指令台「清理」分類(clearinv/deletepals/killnearestbase + hint 機制)、世界設定 8 鍵建議值提示(OptionMeta.hint)、mods 在 Linux/macOS 原生模式明講 UE4SS/PalDefender 僅 Windows。
- 研究筆記:.claude/notes/perf-research.md(效能六面向)、savetools-integration.md(Python 工具整合)、save-slim-plan.md(存檔瘦身計畫)。

## 下一步(新 session 建議從這裡接)

**存檔瘦身 Stage 1(唯讀健檢)** — 計畫在 .claude/notes/save-slim-plan.md,照做即可:
1. CI 凍結 palsav(GPL 隔離,比照 ooz-wasm 下載模式)。
2. agent save-tools.ts(參考 packages/agent/src/oodle.ts 的下載+SHA256 模式)。
3. 健檢卡 UI(贊助者鎖 `save-slim`,feature 記得加進 packages/shared/src/features.ts)。
4. 驗證要 Windows 實機真存檔(Mac 無法;使用者測試機走 Tailscale,見 memory)。

## 未完事項/注意

- 進階顯示、礦物圖層、公會定位、清理分類、設定提示:皆未實機視覺驗證(build/tsc 過了),使用者下次開 dev 順眼確認。
- v2.1.1 之後累積的未發版功能都記在 commit log;發版流程見 .claude/notes/next-release.md。
- BMC webhook 後台網址仍指舊 workers.dev(經 proxy 可用,不急)。
