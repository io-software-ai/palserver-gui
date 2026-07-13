# palserver GUI — v2.0.5(緊急修正 · hotfix)

修正:某些設定值會讓伺服器管理程式「打不開 / 網頁進不去」
Hotfix: certain setting values could prevent the agent from starting ("won't open / page won't load")
緊急修正:一部の設定値で agent が起動できない不具合

> 只是一個修正的緊急版本 —— 有開自動更新會自己抓,或依下方手動下載。
> A small emergency fix — the in-app updater fetches it, or download below.
> 小さな緊急修正版です。自動更新で取得、または下記から。

<details>
<summary><b>🇹🇼 中文</b></summary>

- **修正「執行檔閃退 / 網頁進不去」** — 只要 store 裡有**任何一個設定值超出範圍**(例如負重 `ItemWeightRate` 被設成 0,或匯入了舊版存的髒值),舊版在開機驗證時會**整個崩潰**,導致執行檔一閃就關、管理網頁也連不上。現在改成:單一壞值會**自動退回該項預設**、整筆壞掉則退回全預設,**絕不再讓程式開不起來**;合理範圍內的極端值(如超高經驗倍率)仍保留。

如果你正好卡在這個狀況,更新到這版後就能正常開啟了。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

- **Fixed "the app flashes and closes / the web UI won't load"** — if **any single setting in the store was out of range** (e.g. `ItemWeightRate` set to 0, or dirty values from an older save), the previous build would **crash on the startup validation**, so the executable closed instantly and the panel was unreachable. Now a single bad value **falls back to that option's default** (and a fully-broken settings blob falls back to all defaults) — the agent **never fails to start** over settings again; extreme-but-in-range values (e.g. a very high XP rate) are still kept.

If you were stuck on this, updating to this build gets you back in.

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

- **「実行ファイルが一瞬で閉じる / Web UI が開けない」を修正** — store 内の**いずれかの設定値が範囲外**(例:`ItemWeightRate` が 0、または旧バージョンの不正値)だと、以前は起動時の検証で**全体がクラッシュ**し、実行ファイルが即閉じてパネルにも接続できませんでした。今は不正な値は**その項目の既定値に戻し**(設定全体が壊れていれば全既定値に)、設定が原因で**起動できなくなることは二度とありません**。範囲内の極端な値(超高倍率など)はそのまま保持します。

この症状で止まっていた方は、このビルドに更新すれば復帰できます。

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
