# palserver GUI — v2.0.3

手機 / 平板可用(響應式)· 安全與網路設定搬進面板 · 大量遊戲資料補漏
Works on phone / tablet (responsive) · security & network settings in the panel · big game-data update
スマホ / タブレット対応(レスポンシブ)· セキュリティ / ネットワーク設定をパネルに · ゲームデータ大幅補完

> 這版有介面與 agent 的程式更新,需要新的執行檔:有開自動更新會自己抓,或依下方手動下載。
> This release changes both the UI and the agent, so it needs the new build — the in-app updater will fetch it, or download below.
> 今回は UI と agent 両方の更新のため新しいビルドが必要です。自動更新が有効なら自動取得、または下記から手動でどうぞ。

<details>
<summary><b>🇹🇼 中文更新說明</b></summary>

- **手機 / 平板可用(響應式)** — 整個管理介面重新設計成 RWD,窄螢幕不再爆版:導覽列自動收合、彈窗可捲動、資料列自動換行。
- **安全 / 網路設定搬進面板** — 以前只能靠環境變數(`PALSERVER_TLS` 等),現在直接在設定頁改:強制 token、HTTPS/TLS、監聽埠與位址、跨源公開站來源;改完可一鍵重啟套用(被環境變數鎖定的欄位會顯示為唯讀)。
- **開機自動開瀏覽器** — 新增開關,可自行決定 agent 啟動時要不要自動打開管理介面。
- **設定更順手** — 常駐的黃色提醒與總覽卡片都能按 X 收起,並在設定的「卡片隱藏」統一恢復;主題 / 更新 / 贊助者識別碼移到上方;「伺服器檔案」瀏覽器移到設定頁最上方。
- **遊戲資料大補漏** — 補齊 268 個先前遺漏的物品(藥師島裝備、世界樹 / 覺醒素材、新彈藥、遠古護甲、飾品、藍圖等)。
- **離線玩家詳情修正** — 修正點開離線玩家會整個讀不出來的問題;現在至少顯示名稱 / 公會 / 等級 / 科技,帕魯與背包處會註明 PalDefender 目前僅支援線上玩家的資料。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

- **Works on phone / tablet (responsive)** — the whole panel was redesigned for small screens: the nav wraps, dialogs scroll, and data rows reflow instead of overflowing.
- **Security & network settings in the panel** — what used to require env vars (`PALSERVER_TLS`, etc.) is now editable in Settings: force-token, HTTPS/TLS, listen port & host, cross-origin web origins — with one-click restart to apply (fields locked by an env var show as read-only).
- **Open browser on startup** — a new toggle to control whether the agent opens the panel automatically when it starts.
- **Smoother settings** — dismiss the yellow notices and Overview cards with an ×, and restore them under "Hidden cards" in Settings; theme / update / sponsor code moved up; the "Server files" browser moved to the top of Settings.
- **Big game-data update** — added 268 previously-missing items (Yakushima gear, World Tree / awakening materials, new ammo, ancient armor, accessories, blueprints, and more).
- **Offline-player detail fix** — opening an offline player no longer fails outright; you now get their name / guild / level / tech, with a clear note that PalDefender only serves Pals & inventory for online players.

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

- **スマホ / タブレット対応(レスポンシブ)** — パネル全体を小画面向けに再設計:ナビは折り返し、ダイアログはスクロール、データ行は溢れずに回り込みます。
- **セキュリティ / ネットワーク設定をパネルに** — これまで環境変数(`PALSERVER_TLS` など)が必要だった項目を設定画面で編集可能に:トークン強制、HTTPS/TLS、待受ポート / アドレス、クロスオリジンの公開元 — ワンクリック再起動で反映(環境変数でロックされた項目は読み取り専用表示)。
- **起動時にブラウザを開く** — agent 起動時にパネルを自動で開くかを選べるトグルを追加。
- **設定まわりを改善** — 黄色のお知らせと概要カードは × で閉じられ、設定の「カード・お知らせの非表示」からまとめて再表示;テーマ / 更新 / スポンサーコードを上部へ移動;「サーバーファイル」ブラウザを設定の最上部へ。
- **ゲームデータ大幅補完** — 抜けていた 268 個のアイテム(薬師島装備、ワールドツリー / 覚醒素材、新弾薬、古代の防具、アクセサリー、設計図など)を追加。
- **オフラインプレイヤー詳細の修正** — オフラインプレイヤーを開いても全体が読めなくなる不具合を修正;名前 / ギルド / レベル / テックは表示され、パルとインベントリは「PalDefender はオンラインプレイヤーのみ対応」と明示します。

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
