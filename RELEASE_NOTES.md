# palserver GUI — v2.0.4

日誌全新體驗 · 三款新主題 · 世界設定更自由 · Docker/K8s 補完
Reworked logs · three new themes · freer world settings · Docker/K8s completed
ログを刷新 · 新テーマ3種 · ワールド設定の自由度UP · Docker/K8s 対応強化

> 這版有介面與 agent 的更新,需要新的執行檔:有開自動更新會自己抓,或依下方手動下載。
> This release changes both the UI and the agent, so it needs the new build — the in-app updater fetches it, or download below.
> 今回は UI と agent 両方の更新のため新しいビルドが必要です。自動更新が有効なら自動取得、または下記から。

<details>
<summary><b>🇹🇼 中文更新說明</b></summary>

- **日誌全新體驗** — 日誌改成彈窗(不再佔一個分頁);原生模式現在能擷取到**真正的伺服器日誌**,而且啟動時**不再彈出黑色 cmd 視窗**;裝了 PalDefender 就只顯示它的日誌(最有料)。贊助者另有:事件**自動上色**(加入 / 離開 / 聊天 / 死亡 / 捕捉…)、把生硬的英文日誌**套版成好讀格式**、一鍵 **Google 翻譯**成介面語言。
- **三款新主題** — **午夜紫**、**櫻花粉**、**橘色貓貓**(呼應橘貓吉祥物)。(贊助者專屬)
- **世界設定更自由** — 倍率上限放寬,而且**允許填更極端的值**(超出建議範圍會提醒,想亂玩就玩);**手動編輯 `PalWorldSettings.ini` 不會再被啟動時覆寫**;採用既有伺服器安裝時也會沿用它原本的設定,不再被預設值蓋掉。
- **Docker / Kubernetes 補完** — docker 帶入查詢埠 / 啟動參數 / Engine.ini、鏡像更新、存檔備份;k8s 環境變數套用與備份。(感謝社群貢獻 PR #13 · @teps3105)
- **建立伺服器更清楚** — 後端下拉標示各平台限制(Windows 不支援 Docker、macOS 非 x86 未驗證、k8s 為遠端管理)。
- **小改進** — 更新卡片的「更新說明」直接連到 GitHub release 頁;引擎微調的代管推廣卡可收起(設定→卡片隱藏恢復)。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

- **Reworked logs** — logs now open in a dialog (no longer a tab); native mode finally captures the **real server log**, and starting a server **no longer pops the black cmd window**; with PalDefender installed, only its (richest) log is shown. Sponsors also get: automatic **event coloring** (join / leave / chat / death / capture…), reformatting raw English logs into a **readable form**, and one-click **Google translation** into your UI language.
- **Three new themes** — **Midnight Lilac**, **Cherry Blossom**, and **Orange Cat** (matching the mascot). (sponsor-only)
- **Freer world settings** — wider rate caps, and you can now enter **extreme values** (a notice appears outside the suggested range — mess around all you want); **manual edits to `PalWorldSettings.ini` are no longer overwritten on start**; adopting an existing server install keeps its own settings instead of clobbering them with defaults.
- **Docker / Kubernetes completed** — docker now passes query port / launch args / Engine.ini, image update, and save backups; k8s env patching and backups. (community PR #13 · thanks @teps3105)
- **Clearer server creation** — the backend dropdown explains per-platform limits (Docker unsupported on Windows, unverified on non-x86 macOS, k8s is remote-management).
- **Small touches** — the update card's "Release notes" links straight to the GitHub release page; the maintenance promo card on the Engine tab can be dismissed (restore under Settings → Hidden cards).

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

- **ログを刷新** — ログはダイアログ表示に(タブを占有しません);ネイティブモードで**本当のサーバーログ**を取得できるようになり、起動時に**黒い cmd ウィンドウが出なくなりました**;PalDefender 導入時はそのログ(最も充実)のみ表示。スポンサー特典:イベントの**自動色分け**(参加 / 退出 / チャット / 死亡 / 捕獲…)、生の英語ログを**読みやすく整形**、ワンクリック **Google 翻訳**。
- **新テーマ3種** — **ミッドナイト・ライラック**、**桜ピンク**、**オレンジキャット**(マスコット連動)。(スポンサー限定)
- **ワールド設定の自由度UP** — 倍率の上限を拡大、さらに**極端な値も入力可能**(推奨範囲外は注意表示 — 好きに遊べます);**`PalWorldSettings.ini` の手動編集が起動時に上書きされなくなりました**;既存サーバーを取り込む際も既定値で潰さず、元の設定を引き継ぎます。
- **Docker / Kubernetes 対応強化** — docker にクエリポート / 起動引数 / Engine.ini、イメージ更新、セーブバックアップを追加;k8s の環境変数適用とバックアップ。(コミュニティ PR #13 · @teps3105 に感謝)
- **サーバー作成がより明確に** — バックエンド選択に各プラットフォームの制限を表示(Windows は Docker 非対応、非 x86 macOS は未検証、k8s はリモート管理)。
- **細かな改善** — 更新カードの「更新内容」が GitHub リリースページへ直接リンク;エンジン調整の保守プロモカードを閉じられるように(設定→カードの非表示で復元)。

</details>

---

## ⬇️ 下載 / Download / ダウンロード

解壓縮後雙擊 **`palserver-agent`** 即可(免裝 Node / Docker)· Unzip and double-click **`palserver-agent`**.

| 你的電腦 / OS | 下載 / File |
| --- | --- |
| **Windows** | **`palserver-agent-windows.zip`** |
| **Linux** | `palserver-agent-linux.zip` |
| **macOS**(僅遠端管理 / manage remote only) | `palserver-agent-macos.zip` |

安裝教學 / Setup → [中文指南](https://github.com/io-software-ai/palserver-gui/blob/main/docs/INSTALL.zh-TW.md) · 有問題來 [Discord](https://discord.gg/sgMMdUZd3V)

<details>
<summary>其他檔案 / Other files</summary>

- **`palserver-web.zip`** — 只有網頁介面(自架公開站用)/ web UI only, for hosting the panel publicly.
- **`*.tar.gz`** — agent 自我更新用的格式 / for the in-app self-updater. 手動下載請用 `.zip`.
- **`SHA256SUMS.txt`** — 檔案校驗碼 / checksums (used by the self-updater).

</details>

> 免費開源,僅限非商業使用(PolyForm Noncommercial)· Free & open source, non-commercial use only.
