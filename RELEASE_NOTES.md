# palserver GUI — v2.4.1

修補版:玩家頁改用 WebSocket 即時推播(解決 PalDefender 塞車卡在載入中),修復裝了反作弊插件卻找不到分頁
Patch: players page now updates over WebSocket (fixes the PalDefender-congestion "stuck loading"), and the anti-cheat plugin tab shows again when PalDefender is installed
パッチ:プレイヤーページを WebSocket 更新に変更(PalDefender 混雑での「読み込み中」を解消)、アンチチート導入時にタブが出ない不具合を修正

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### 修正
- **玩家頁改用 WebSocket 即時推播**(感謝 @LilaS-tw,PR #39) — 原本用輪詢,當 PalDefender 查詢塞車時整頁會卡在「載入中」;改為推播後即時更新;連不上或連到舊版 agent 會自動退回輪詢,斷線自動重連。
- **反作弊插件(PalDefender)分頁消失修復** — 裝了 PalDefender 的伺服器,分頁會因為「設定入口按鈕」在改版中遺失而找不到;現在 PalDefender 一旦安裝,分頁就會顯示(仍可在分頁列的「＋」面板手動隱藏)。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 修复
- **玩家页改用 WebSocket 实时推送**(感谢 @LilaS-tw,PR #39) — 原本用轮询,PalDefender 查询拥塞时整页会卡在「加载中」;改为推送后实时更新;连不上或连到旧版 agent 会自动退回轮询,断线自动重连。
- **反作弊插件(PalDefender)标签页消失修复** — 装了 PalDefender 的服务器,标签会因为「设置入口按钮」在改版中丢失而找不到;现在 PalDefender 一旦安装,标签就会显示(仍可在标签栏的「＋」面板手动隐藏)。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Fixes
- **Players page now pushes over WebSocket** (thanks @LilaS-tw, PR #39) — it used to poll, so a congested PalDefender query left the whole page stuck on "loading." It now updates live over a socket, falls back to polling on older/unreachable agents, and reconnects automatically.
- **Anti-cheat plugin (PalDefender) tab no longer goes missing** — the tab's discovery button was lost in a refactor, so servers with PalDefender installed couldn't find it. The tab now shows whenever PalDefender is installed (you can still hide it via the "+" panel in the tab bar).

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 修正
- **プレイヤーページを WebSocket 更新に変更**(@LilaS-tw さん、PR #39) — 従来はポーリングで、PalDefender のクエリが混雑するとページ全体が「読み込み中」で止まっていました。ソケットでリアルタイム更新するようになり、古い/接続できない agent ではポーリングに自動フォールバック、切断時は自動再接続します。
- **アンチチート(PalDefender)タブが消える不具合を修正** — タブへの導線ボタンがリファクタで失われ、PalDefender を導入したサーバーでタブが見つからなくなっていました。PalDefender を導入していればタブが表示されます(タブバーの「＋」パネルから手動で非表示にもできます)。

</details>
