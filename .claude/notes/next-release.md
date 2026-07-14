# 下一版 release 草稿(尚未發布)

v2.1.1 已發布(2026-07-15:贊助碼驗證改走 stats.iosoftware.ai 修大陸/香港線路、
礦物地圖圖層、公會詳情頭像+成員定位、玩家上限 99、路徑遮蔽、#20/#21 社群修正)。
以下累積之後的新功能;發版時:bump 版本 → 用這清單寫四語 RELEASE_NOTES → tag → push。

## Features(自 v2.1.1 起)
- (尚無)

## 待確認 / 需實機驗證(v2.1.1 遺留)
- 礦物圖層與公會成員定位:實機視覺確認(圓點密度/顏色分辨度、flyTo 縮放層級)。
- stats worker 已搬到新帳號(stats.iosoftware.ai);舊帳號 workers.dev 是轉發 proxy,不要刪。

## 待確認 / 需實機驗證(v2.1.0 遺留)
- Windows 實機:host-save-fix 修復後的存檔由遊戲實際載入(位元組級已與參考工具一致)、
  匯入存檔的 Windows 路徑輸入、DepotDownloader 真實輸出的進度解析、SEA 打包下的
  ooz-wasm 載入(oodle.ts 的 Function 轉換路徑)。
- 原生日誌擷取、不彈黑窗、日誌翻譯、世界設定 reconcile —— 皆需在 Windows 實機確認。
- 離線玩家詳情:實機上 /player 仍失敗,確認可用前不要在 notes 宣傳。
