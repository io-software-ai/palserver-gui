# palserver GUI

**繁體中文** | [简体中文](README.zh-CN.md) | [English](README.en.md) | [日本語](README.ja.md)

<p align="center"><a href="https://palserver-GUI.iosoftware.ai"><b>官方網站 palserver-GUI.iosoftware.ai</b></a> —— 下載、教學、常見問題</p>

**幻獸帕魯(Palworld)專用伺服器的圖形化管理工具。**
在你的主機上跑一支 agent,然後用瀏覽器管理伺服器 —— 開服、改設定、看玩家、備份存檔、裝模組,全都不用碰指令列。

手機、平板、另一台電腦都能連進來管理;朋友也可以用一條連結加入管理。

```
瀏覽器(React Web UI)
        │  HTTP / WebSocket(Bearer token)
        ▼
   agent(Node/TypeScript,Fastify)
        ├── native 後端(預設):直接在主機上啟動 PalServer,不需要 Docker
        └── docker 後端(beta):把 PalServer 跑在容器裡
```

---

## 畫面預覽

> 介面支援繁體中文 / 简体中文 / English / 日本語,六套主題(帕魯原色 / 白銀 / 極光翡翠 / 午夜紫 / 櫻花粉 / 橘色貓貓)分別有深色 / 淺色可切換;截圖中的玩家與資料為展示用途。

![玩家管理](docs/screenshots/players.png)

| 儀表板 | 世界設定 |
| --- | --- |
| ![儀表板](docs/screenshots/dashboard.png) | ![世界設定](docs/screenshots/settings.png) |
| **引擎微調** | **存檔備份** |
| ![引擎微調](docs/screenshots/engine.png) | ![存檔備份](docs/screenshots/saves.png) |
| **模組管理** | **實例總覽** |
| ![模組管理](docs/screenshots/mods.png) | ![實例總覽](docs/screenshots/overview.png) |

---

## 這份文件怎麼看

| 你是… | 從這裡開始 |
| --- | --- |
| **玩家 / 開服的人** —— 只想把伺服器開起來 | [給玩家:五分鐘開服](#給玩家五分鐘開服) |
| **伺服器管理員** —— 要長期營運、在意安全與自動化 | [給管理員:營運指南](#給管理員營運指南) |
| **開發者** —— 想改程式、送 PR | [給開發者:開發指南](#給開發者開發指南) |

遇到問題先看 **[常見問題 FAQ](https://faq.toc.icu/)**,或到 [Discord](https://discord.gg/sgMMdUZd3V) 問。

---

## 功能總覽

**開服與管理**
- 建立多個伺服器實例,各自獨立的世界、埠號與設定;一鍵啟動 / 停止 / 重啟 / 刪除(刪除保留存檔)
- 自動下載安裝 Palworld 伺服器檔案(透過 DepotDownloader),**即時安裝進度條**;或**直接接管你既有的安裝目錄**
- 遊戲版本檢查:比對已安裝版本與 Steam 上的最新版,一鍵更新伺服器
- 即時日誌串流(agent / 遊戲 / PalDefender 三種來源可切換)
- 啟動參數面板:Steam 查詢埠(queryport)**可自行設定**(並檢查與其他伺服器不重複);`publiclobby` / `logformat` 等啟動旗標整合進設定
- **Docker 自訂容器鏡像**:可沿用你已在用的其他帕魯鏡像;docker / k8s 後端不再被平台鎖死(macOS/Windows 裝了 Docker Desktop 也能用,k8s 一律可選)

**世界與效能設定**
- 80+ 項世界設定的圖形化編輯器,依分類分頁,含型別、範圍與預設值;也可以直接編輯原始 `PalWorldSettings.ini`
- `Engine.ini` 效能微調(tick rate、網路速率、逾時、GC 間隔、效能旗標 `useperfthreads` / `NoAsyncLoadingThread` / `UseMultithreadForDS`、工作執行緒數…)附一鍵效能預設;玩家頻寬上限可調到 1 Gbps 並即時換算 Mbps
- 設定檔損毀時自動偵測,並提供「重建乾淨設定檔」(壞檔會先備份,不會直接刪掉)

**玩家管理**
- 線上玩家清單:等級、延遲、座標、建築數,點進去可看**他的帕魯與背包**(需 PalDefender)
- 踢出、封鎖、白名單 —— **離線玩家也能操作**(例如幫人解封)
- 歷史玩家名冊:agent 每 15 秒記錄一次,留下遊玩時數、上線次數、首次/最後上線;上下線時間軸
- 全服廣播、立即存檔

**地圖**
- **內建完整世界地圖**(帕魯島 + 櫻島 + Feybreak,高解析度),不用再自備底圖
- **線上玩家即時標記** + **離線玩家最後已知位置**;公會據點、**野外首領(Alpha 帕魯)圖層**、地標(快速旅行點 / 高塔 / 地城,名稱隨介面語言)
- **全螢幕地圖**(`/map`),可從主介面一鍵開新分頁
- **地圖描點選座標**:傳送、生成等需要座標的指令,直接點地圖放圖釘即可,不用手打座標

**主控台**
- 完整的 RCON 主控台,指令有搜尋、分類與參數表單;危險指令需二次確認
- 需要玩家 ID 的參數會跳出玩家選擇器(含離線玩家);道具 / 帕魯 / 蛋的 ID 有圖示搜尋
- 裝了 PalDefender 會自動把它的指令加進來
- 帕魯 / 道具資料更新到 **Palworld 1.0(藥師島)**;主動技 / 詞條多語(繁中 / 日文)

**存檔搬家(內建,免指令)**
- **匯入存檔**:「建立伺服器」旁的按鈕,把舊世界帶著建新伺服器 —— 支援三種來源:**其他專用伺服器**、**本機共玩存檔**(四人邀請碼)、**舊版 1.0 GUI**。貼上資料夾路徑 → 掃描 → 選世界,匯入前自動備份、自動設為啟用世界
- **修復主機角色**(內建 palworld-host-save-fix):共玩存檔搬上專用伺服器後主機會被要求重建角色 —— 存檔備份分頁偵測到共玩主機檔就給你一鍵過戶,免裝 Python;支援新版 **PlM(Oodle)存檔格式**,修復前強制自動備份
- 匯入後新加入的角色檔自動標「**匯入後新增**」並預選,不用猜哪個是主機的新角色
- 完整搬家教學:[docs/MIGRATION.md](docs/MIGRATION.md)

**存檔與備份**
- 排程自動備份:間隔、保留份數、沒人在線時跳過
- 手動備份 / 還原 / 下載;還原前會自動先備份目前的世界
- 多世界管理:列出所有世界、切換「啟用中的世界」、刪除個別玩家存檔;玩家角色檔清單即時刷新

**模組**
- 一鍵安裝 / 更新 / 移除 **PalDefender**(反外掛,前身 Palguard)與 **UE4SS**(Lua/藍圖模組載入器),各有穩定版與測試版通道
- PalDefender 設定面板、Lua 模組開關、pak 模組管理;**PalDefender REST API 端口可改**
- **MOTD 登入公告**做進設定 UI
- 檔案管理器:瀏覽、上傳、編輯、刪除伺服器目錄下的檔案

**穩定性**
- 自動重啟:排程(固定間隔或每日指定時間)、記憶體超標、崩潰自動復原(有每小時上限,避免無限重啟迴圈)
- 重啟前會先廣播倒數並存檔;手動停止不會被當成崩潰

**贊助者先行版功能**(有效贊助者解鎖,到期後對所有人開放)
- **帕魯數值編輯器**(透過 PalSchema):修改物種基礎數值 HP / 攻防 / 捕獲率等,**首領版可單獨調**;一鍵安裝 PalSchema、修改紀錄清單、一鍵還原全部
- **傳送玩家**:把玩家傳送到另一位玩家,或**地圖描點的座標**
- **批量給予道具**:物品圖示選單 + 數量,一次發多個
- 自訂帕魯 / 帕魯蛋、公會據點詳情、地標名稱

**其他**
- 四種語言:繁體中文 / 简体中文 / English / 日本語;**六套主題**(帕魯原色 / 白銀 / 極光翡翠 / 午夜紫 / 櫻花粉 / 橘色貓貓)× 深色 / 淺色,部分主題為贊助者專屬
- 首頁伺服器卡片**拖曳排序**;分頁可**自訂顯示 / 隱藏**;總覽卡片可關閉
- 連線診斷:偵測公網 IP、是否在 NAT/CGNAT 後面,並提供 VPN(Tailscale / Radmin)開服教學
- GUI 自我更新(可選):從 GitHub Releases 檢查新版,驗證 SHA256 後換檔重啟

---

## 系統需求

| 項目 | 說明 |
| --- | --- |
| **作業系統** | **Windows 10+ 或 Linux(x86_64)**。macOS 可以跑 agent,但**跑不了 Palworld 伺服器**(SteamCMD/PalServer 不支援),只能拿來開發或管理遠端主機。 |
| **硬體** | 依 Palworld 官方需求;伺服器檔案本身數十 GB,首次安裝要等一段時間 |
| **Node.js** | **不需要**(免安裝執行檔已內含)。從原始碼跑才需要 Node 20+ 與 pnpm |
| **Docker** | 不需要。只有選用 docker 後端(beta)時才要 |

---

## 給玩家:五分鐘開服

> 完整的圖文教學(含邀請朋友、VPN 設定):**[官方網站](https://palserver-GUI.iosoftware.ai)** 與 **[FAQ](https://faq.toc.icu/)**

1. 到 [Releases](https://github.com/io-software-ai/palserver-gui/releases) 下載你系統對應的壓縮檔
   (`palserver-agent-windows.zip` / `-linux.zip`),解壓縮。
2. 執行裡面的 `palserver-agent`(Windows 是 `palserver-agent.exe`)。不用先裝 Node 或 Docker。
3. 視窗會印出一段說明,照著打開 **`http://localhost:8250`** —— 本機管理**不需要密碼**。
4. 按「建立伺服器」。第一次會下載 Palworld 伺服器檔案(**數十 GB,請耐心等**),介面會顯示即時進度條。
5. 裝好後按「啟動」就開服了。

**已經有舊世界?** 按「建立伺服器」旁的「**匯入存檔**」,把別台伺服器、本機共玩(四人邀請碼)或 v1 GUI 的世界帶著建新伺服器,詳見[存檔搬家教學](docs/MIGRATION.md)。

**邀請朋友一起管理:** 啟動視窗裡有一條 `?setup=XXXX-XXXX` 的連結,傳給對方在他的瀏覽器打開就能連進來
(需要在同一個區網或 VPN 內)。也可以請他打開你的 agent 網址後輸入**配對碼**。

**讓朋友連進遊戲:** 最簡單的方式是 VPN(Tailscale 或 Radmin),GUI 的「連線」卡片會偵測你的網路環境並給對應教學。
如果你有公網 IP,也可以走傳統的連接埠轉發(UDP 8211)。

> **關於地圖:** GUI 內建完整世界地圖(帕魯島 / 櫻島 / Feybreak),不用自備底圖 —— 打開「地圖」分頁或 `/map` 全螢幕檢視,就能看到線上玩家即時位置、離線玩家最後位置、公會據點與野外首領。

---

## 給管理員:營運指南

### 安全模型

agent 只有一道門:**本機(loopback)免驗證,其他一律要 token。**

- **本機管理**(`127.0.0.1`)不需要任何憑證 —— 單機自用零摩擦。
- **其他裝置**要嘛帶 API token(`Authorization: Bearer <token>`),要嘛用**配對碼**換一把 token。
  配對碼是好唸的 `XXXX-XXXX`(去掉了易混淆的字元),可隨時重新產生,舊碼與舊連結立刻失效。
- token 存在資料夾裡(權限 `0600`),第一次啟動時產生並印在視窗上。
- 多人共用的主機請設 `PALSERVER_REQUIRE_TOKEN=1`,連 loopback 也要 token。
- **SteamID 全面遮蔽**:名冊、日誌、玩家選擇器、指令輸出等處一律顯示中間碼(可點擊顯示 / 複製);配對碼與一鍵登入連結預設**馬賽克遮蔽**,防止截圖外流。

> agent 會直接操作主機上的檔案與行程,**不要把 `:8250` 直接曝露在公網上**。要遠端管理,請走 VPN(Tailscale/WireGuard)或放在反向代理後面並開 TLS。

### 環境變數

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `PALSERVER_DATA_DIR` | `~/.palserver-agent` | 所有狀態的存放位置 |
| `PALSERVER_AGENT_PORT` | `8250` | 監聽埠 |
| `PALSERVER_AGENT_HOST` | `0.0.0.0` | 綁定位址 |
| `PALSERVER_REQUIRE_TOKEN` | 未設 | `=1` 時連本機也要 token |
| `PALSERVER_TLS` | 未設 | `=1` 以 HTTPS 監聽(自簽憑證自動生成於 `<data-dir>/tls`,也可放自己的) |
| `PALSERVER_WEB_ORIGINS` | 空 | 允許跨源連線的網站來源(逗號分隔),給獨立部署的公開 web 站用 |
| `PALSERVER_AUTO_UPDATE` | 未設 | `=0` 完全停用 GUI 自我更新(連檢查都不做) |
| `PALSERVER_TELEMETRY` | 未設 | `=0` 強制停用匿名使用統計 |
| `PALSERVER_STATS_URL` | 官方統計端點 | 改成自架的統計後端 |
| `PALSERVER_GITHUB_REPO` | `io-software-ai/palserver-gui` | 自我更新要看哪個 repo 的 Releases |
| `PALSERVER_IMAGE_VANILLA` | `palserver/vanilla:latest` | docker 後端用的映像 |

### 資料放在哪

```
~/.palserver-agent/
├── token                 API token(0600)
├── pair-code             配對碼(0600)
├── instances.json        所有實例的設定(設定的唯一真相來源)
├── tools/                快取的 DepotDownloader
├── tls/                  自簽憑證(PALSERVER_TLS=1 時)
└── instances/<id>/
    ├── server/           agent 自己安裝的伺服器檔案(接管既有安裝時不會有)
    ├── server.pid        遊戲行程 pid
    ├── server.log        agent 抓到的伺服器輸出
    └── backups/          tar.gz 備份
```

伺服器行程是 **detached** 生成的,agent 重啟(或自我更新)**不會**把遊戲伺服器一起關掉;pid 檔讓 agent 重新接上。

### 部署方式

**免安裝執行檔(推薦)** —— 就是玩家那條路,適合絕大多數人。

**用 Docker 跑 agent 本身**(Linux 主機):

```sh
docker compose up -d          # 見 docker-compose.yml
```

需要掛載 `docker.sock`,而且 host 上的資料夾路徑要與容器內一致(實例目錄會被 bind-mount 進遊戲容器)。

**純 web 站 + 遠端 agent** —— Release 裡的 `palserver-web.zip` 是可獨立部署的前端;把站台網址加進 agent 的
`PALSERVER_WEB_ORIGINS`,玩家就能從公開站台連回自己家裡的 agent。

**從原始碼** —— 見下方[開發指南](#給開發者開發指南);`pnpm release:exe` 可以自己產出免安裝執行檔。

### 自我更新

在「設定 → GUI 更新」。預設**只檢查、不安裝**(每 6 小時),查到新版會顯示更新卡片,按下去才動作:
下載對應平台的 `.tar.gz` → **比對 `SHA256SUMS.txt`** → 換掉執行檔與前端 → 重啟自己。也可以打開「自動安裝」。

安全設計:沒有校驗檔就拒絕更新;非免安裝執行檔(例如開發模式)拒絕自我更新;有伺服器正在安裝檔案時拒絕更新
(下載器是 agent 的子行程,重啟會中斷它);換檔失敗會把舊執行檔搬回去。

### 隱私與匿名統計

GUI 會回報**匿名**的使用計數(安裝數、伺服器建立/啟動數、不重複玩家數),用來了解使用規模。
不含個資、IP、伺服器名稱或存檔內容;玩家識別碼只送單向雜湊。
可在「設定」關閉,或 `PALSERVER_TELEMETRY=0` 強制停用。完整說明:**[PRIVACY.md](PRIVACY.md)**。

---

## 給開發者:開發指南

### 架構

前端**永遠不直接碰**遊戲的 REST API、RCON 或 PalDefender 的 API —— 那些憑證只留在 agent 裡,瀏覽器只跟 agent 說話。

| 套件 | 內容 |
| --- | --- |
| `packages/agent` | Fastify daemon:REST + WebSocket API、行程管理、RCON、備份、模組安裝、自我更新 |
| `packages/web` | React 18 + Vite + Tailwind 4 的 Web UI |
| `packages/shared` | 共用的 zod schema 與 API 型別(世界設定、實例契約) |
| `packages/stats` | Cloudflare Worker + D1,匿名統計收集端 |
| `images/vanilla` | docker 後端用的 Linux PalServer 映像(內含 DepotDownloader) |
| `images/dev-stub` | 假的 PalServer,給 Apple Silicon 開發用 |
| `deperated/` | v1 的 Electron 版,只留作 UX/i18n 參考,不屬於這個 workspace |

### 開始開發

需要 Node 20+ 與 pnpm 11。

```sh
pnpm install
pnpm build

pnpm dev:agent    # 終端機 1 — agent(第一次會印出 API token)
pnpm dev:web      # 終端機 2 — Web UI on http://localhost:5173
```

agent 預設監聽 `:8250`。當 `packages/web/dist` 存在時,agent 會自己 serve 前端(合一版)。

| 指令 | 做什麼 |
| --- | --- |
| `pnpm typecheck` | 全 workspace 型別檢查(CI 會跑) |
| `pnpm build` | 全部建置 |
| `pnpm bundle:agent` | esbuild 打包成單一 CJS |
| `pnpm release:exe` | 產出當前平台的免安裝執行檔到 `release/` |

### 世界設定是 schema 驅動的

`packages/shared/src/options.ts` 是**唯一的真相來源**:每個選項的型別、預設值、範圍與分類都在那裡
(依[官方文件](https://docs.palworldgame.com/)校對)。zod schema、agent 的 ini 序列化、前端的設定編輯器全部由它衍生 ——
**在那裡加一個選項,整條路就通了**。中文標籤在 `packages/web/src/labels.ts`。

`Engine.ini` 與 PalDefender 的 `Config.json` 也是同樣作法,而且**寫入時採合併策略**:GUI 不管的區段、鍵與註解都會原樣保留。

### i18n

程式碼裡的字串一律寫**中文原文**,`t("中文")` 拿原文當 key 查字典。
`packages/web/public/i18n/{en,ja,zh-CN}.json` 是「中文 → 譯文」對照表,查不到就顯示中文原文,所以**漏翻不會壞版面**。
字典會在背景從 GitHub raw 抓最新版,翻譯修正不用重新發版。

### 在 Apple Silicon 上開發

真的伺服器在 Rosetta 下跑不起來(SteamCMD 是 32-bit;PalServer 一存檔就 segfault)。UI/agent 開發請用假伺服器:

```sh
docker build -t palserver/dev-stub:latest images/dev-stub
PALSERVER_IMAGE_VANILLA=palserver/dev-stub:latest pnpm dev:agent
```

真伺服器的驗證需要一台 x86_64 的 Windows 或 Linux。

### 發版

推一個 `v*` tag,[release workflow](.github/workflows/release.yml) 會在三種 OS 上各自產出:

- `palserver-agent-<os>.zip` —— 給人手動下載
- `palserver-agent-<os>.tar.gz` —— 給自我更新用
- `palserver-web.zip` —— 可獨立部署的前端
- `SHA256SUMS.txt` —— 自我更新一定會驗證它

---

## 現況

**v2 目前版本為 v2.1.0**,已可直接到 [Releases](https://github.com/io-software-ai/palserver-gui/releases) 下載使用,
上面列的功能都已經上線。

尚未完成:多主機聚合管理;Docker 後端仍標示 beta(`images/modded` 尚未提供);PalDefender 的帕魯匯入規則等進階功能。

## 授權與連結

**[PolyForm Noncommercial 1.0.0](LICENSE.md)** —— 原始碼公開,個人與非商業用途可自由使用、
修改與散布;**禁止任何商業/盈利用途**(販售本軟體、或把它包進付費服務等)。
如需商業授權,請聯絡 <contact@iosoftware.ai>。

> *License: source-available under PolyForm Noncommercial 1.0.0 — free for personal and
> noncommercial use; **commercial use is not permitted**. Contact us for commercial licensing.*

- **官方網站:** <https://palserver-GUI.iosoftware.ai>
- **常見問題:** <https://faq.toc.icu/>
- **Discord:** <https://discord.gg/sgMMdUZd3V>
- **存檔搬家:** [docs/MIGRATION.md](docs/MIGRATION.md)
- **隱私權政策:** [PRIVACY.md](PRIVACY.md)
- **v1(已停止維護):** <https://github.com/Dalufishe/palserver-GUI>

由 [Dalufish](https://github.com/Dalufishe) 與核心團隊用愛製作。
