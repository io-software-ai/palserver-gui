# palserver GUI — v2.1.1

中國大陸/香港線路無法啟用贊助碼已修復;線上地圖新增礦物圖層、公會成員頭像與一鍵定位;玩家數上限放寬到 99
Sponsor-code activation fixed for mainland-China/HK networks; ore map layer, guild member avatars & jump-to-location; player cap raised to 99
中国本土/香港回線でスポンサーコードを有効化できない問題を修正;鉱石マップレイヤー、ギルドメンバーのアバターと位置ジャンプ;プレイヤー上限を 99 人に

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### 新功能
- **礦物地點圖層(贊助者)** — 線上地圖新增「礦物」開關:全地圖 3,868 個礦點、12 種礦種(金屬礦石、石炭、硫磺、純水晶、鉻鐵礦、六稜晶礦、烈陽金屬、原油,含大型礦脈),依礦種著色、大型礦脈畫大顆,滑過顯示名稱 —— 選基地位置、規劃挖礦路線一眼看完。
- **公會詳情升級(贊助者)** — 成員列表顯示帕魯頭像(與地圖上同一隻);**在線成員直接點一下,地圖就飛到他現在的位置**。
- **玩家數上限放寬到 99** — 世界設定與建立伺服器表單同步放寬(官方預設 32,調高請自行評估主機效能)。
- **路徑隱私** — 實例總覽不再顯示伺服器目錄;設定分頁的路徑預設模糊遮蔽(點眼睛顯示、複製仍是完整路徑),截圖或直播不再外洩本機路徑。

### 修正
- **中國大陸/香港線路無法啟用贊助碼** — 驗證伺服器改走自訂網域 `stats.iosoftware.ai`(原 `workers.dev` 網域在部分地區被 DNS 污染),並保留舊端點作備援;首次啟用連不上時顯示明確訊息並自動重試。受影響地區請更新到本版。
- **舊版瀏覽器連不上 agent**(缺 `AbortSignal.timeout`) — 感謝 @LilaS-tw 貢獻(#21)。
- **k8s 設定改為下次重啟生效** — 感謝 @teps3105 貢獻(#20)。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 新功能
- **矿物地点图层(赞助者)** — 在线地图新增「矿物」开关:全地图 3,868 个矿点、12 种矿种(金属矿石、煤炭、硫磺、纯水晶、铬铁矿、六棱晶矿、烈阳金属、原油,含大型矿脉),按矿种着色、大型矿脉画大颗,滑过显示名称 —— 选基地位置、规划挖矿路线一眼看完。
- **公会详情升级(赞助者)** — 成员列表显示帕鲁头像(与地图上同一只);**在线成员直接点一下,地图就飞到他现在的位置**。
- **玩家数上限放宽到 99** — 世界设定与创建服务器表单同步放宽(官方默认 32,调高请自行评估主机性能)。
- **路径隐私** — 实例总览不再显示服务器目录;设置页的路径默认模糊遮蔽(点眼睛显示、复制仍是完整路径),截图或直播不再泄露本机路径。

### 修复
- **中国大陆/香港线路无法启用赞助码** — 验证服务器改走自定义域名 `stats.iosoftware.ai`(原 `workers.dev` 域名在部分地区被 DNS 污染),并保留旧端点作备援;首次启用连不上时显示明确信息并自动重试。**受影响地区请更新到本版。**
- **旧版浏览器连不上 agent**(缺 `AbortSignal.timeout`) — 感谢 @LilaS-tw 贡献(#21)。
- **k8s 设置改为下次重启生效** — 感谢 @teps3105 贡献(#20)。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### New
- **Ore map layer (sponsors)** — a new "Ores" toggle on the live map: 3,868 mining nodes across the whole map, 12 ore types (Ore, Coal, Sulfur, Pure Quartz, Chromite, Hexolite Quartz, Soralite, Crude Oil — clusters included), colour-coded with bigger dots for cluster nodes and names on hover. Base-site scouting and mining routes at a glance.
- **Guild details upgraded (sponsors)** — member lists now show Pal avatars (the same Pal as on the map); **click an online member to fly the map straight to their current position**.
- **Player cap raised to 99** — world settings and the create-server form both allow up to 99 (the official default is 32; mind your host's performance if you go higher).
- **Path privacy** — the instance overview no longer shows the server directory, and the path on the settings tab is blurred by default (eye icon to reveal; copying still copies the full path). No more leaking local paths in screenshots or streams.

### Fixes
- **Sponsor-code activation failing on mainland-China/HK networks** — the license server now lives on a custom domain, `stats.iosoftware.ai` (the old `workers.dev` domain is DNS-poisoned in some regions), with the old endpoint kept as fallback; a clear message and automatic retries when the first activation can't get through. Please update to this version if you're in an affected region.
- **Older browsers unable to connect to the agent** (missing `AbortSignal.timeout`) — thanks @LilaS-tw (#21).
- **k8s settings now apply on next restart** — thanks @teps3105 (#20).

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 新機能
- **鉱石マップレイヤー(スポンサー向け)** — ライブマップに「鉱石」トグルを追加:全マップ 3,868 か所の採掘ポイント、12 種類の鉱石(金属鉱石、石炭、硫黄、ピュアクォーツ、クロマイト、ヘクソクォーツ、ソルライト、原油 — 大型鉱脈も含む)。鉱石ごとに色分け、大型は大きい点で表示、ホバーで名前を表示。拠点選びや採掘ルートがひと目でわかります。
- **ギルド詳細を強化(スポンサー向け)** — メンバー一覧にパルアバターを表示(マップ上と同じパル);**オンラインのメンバーをクリックすると、マップがその現在位置へ飛びます**。
- **プレイヤー上限を 99 人に緩和** — ワールド設定とサーバー作成フォームの両方で 99 人まで設定可能(公式デフォルトは 32。上げる場合はホスト性能にご注意を)。
- **パスのプライバシー** — インスタンス概要にサーバーディレクトリを表示しないように;設定タブのパスはデフォルトでぼかし表示(目のアイコンで表示、コピーは常にフルパス)。スクリーンショットや配信でローカルパスが漏れません。

### 修正
- **中国本土/香港回線でスポンサーコードを有効化できない問題** — 認証サーバーを独自ドメイン `stats.iosoftware.ai` へ移行(旧 `workers.dev` ドメインは一部地域で DNS 汚染の影響を受けます)。旧エンドポイントはフォールバックとして維持;初回有効化に失敗した場合は明確なメッセージ表示と自動リトライ。該当地域の方はこのバージョンへ更新してください。
- **古いブラウザで agent に接続できない問題**(`AbortSignal.timeout` 未対応) — @LilaS-tw さんの貢献(#21)。
- **k8s 設定が次回再起動時に反映されるように** — @teps3105 さんの貢献(#20)。

</details>
