# 自製機器人開發者指南(Discord bot / 任何第三方工具)

palserver-GUI 的 agent 提供完整的 **REST API**,官方 Discord bot(`packages/discord-bot`)
就只是它的一個客戶端。你可以用任何語言寫自己的 bot、面板、自動化工具 —— 本文說明
認證方式、常用端點、以及怎麼收伺服器事件。

兩個方向、兩條路:

| 方向 | 機制 | 文件 |
|---|---|---|
| **你 → 伺服器**(指令回控:查狀態、廣播、重啟…) | 呼叫 agent REST API | 本文 |
| **伺服器 → 你**(事件通知:玩家上下線、崩潰、頭目…) | agent 的 webhook 系統(簽章 POST) | [webhooks.md](webhooks.md) |

兩條都是**只出不進**:你的 bot 主動連 agent 與 Discord,不需要對外開 port(NAT/家用機
友善,跨機用 Tailscale 之類的內網位址即可)。

---

## 快速開始

最小可用範例(Node 22+,零依賴):

```js
const AGENT_URL = "http://127.0.0.1:8250"; // 跨機改成 agent 主機位址
const AGENT_TOKEN = "";                     // 同機 loopback 免 token;跨機必填(GUI「Discord Bot」分頁可複製)

async function api(path, init) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(AGENT_TOKEN ? { authorization: `Bearer ${AGENT_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

const [instance] = await api("/api/instances");        // 取第一個實例
const live = await api(`/api/instances/${instance.id}/live`);
console.log(`${instance.name}:${live.players.length} 人在線`);
await api(`/api/instances/${instance.id}/announce`, {
  method: "POST",
  body: JSON.stringify({ message: "Hello from my bot!" }),
});
```

**參考實作**:官方 bot 的 [`src/agent.ts`](../packages/discord-bot/src/agent.ts) 就是一份
完整的 typed API 客戶端(含錯誤處理與 loopback-HTTPS 特例),18 支 slash 指令全部建立
在它之上([`src/commands.ts`](../packages/discord-bot/src/commands.ts))。fork 或照抄即可。

---

## 認證

- **同機**(bot 與 agent 跑在同一台、連 `127.0.0.1`):**免 token**,什麼都不用帶。
- **跨機**:HTTP header 帶 `Authorization: Bearer <AGENT_TOKEN>`。token 在 GUI 的
  「Discord Bot」分頁(進階區)可直接複製;它等同 agent 的**完整控制權**,請妥善保管。
- agent 開 TLS 時是**自簽憑證**:連 loopback 可跳過憑證驗證(官方 bot 的做法,見
  `agent.ts` 的 `loopbackHttpsFetch`);跨機建議直接走 Tailscale + HTTP。
- 401 = token 錯;403 = 該功能屬贊助者先行版且此 agent 未解鎖。

## 取得實例

```
GET /api/instances          → InstanceSummary[](id、name、status、gamePort…)
GET /api/instances/:id/live → 即時狀態(見下)
```

多實例時用 `id` 指定要操作哪台;單實例取第一個即可。

---

## 常用端點(官方 bot 實際使用的集合)

Base path 一律為 `/api/instances/:id`。body 都是 JSON;無 body 的 POST 送 `{}`。

### 唯讀

| 端點 | 回傳 | 備註 |
|---|---|---|
| `GET /live` | `{ available, reason?, info, metrics, players[] }` | 在線玩家(name/level/ping)、FPS、運行時間等。**需要遊戲 REST API 已啟用**(GUI 世界設定),否則 `available:false` |
| `GET /connection` | `{ gamePort, lan[], vpns[], publicIp, behindNat, externalAddress }` | 給玩家的連線位址 |
| `GET /version` | `{ gameVersion, updateAvailable, latestUpdatedAt, … }` | 版本與可否更新 |
| `GET /saves` | `{ worlds[], backups[], schedule }` | `worlds[].active` = 啟用中世界 |
| `GET /saves/players-snapshot` | `{ generatedAt, players[] }` | 全玩家(含離線)等級/帕魯數/公會,來自存檔掃描 |
| `GET /guilds` | `{ available, detailed, guilds[] }` | 需 PalDefender REST;`detailed` 需贊助授權 |
| `GET /boss-respawns` | `{ supported, modInstalled, state }` | 需頭目回報模組;倒數計算函式在 `@palserver/shared`(`bossRespawnInfo`) |

### 操作

| 端點 | body | 說明 |
|---|---|---|
| `POST /announce` | `{ message }` | 遊戲內廣播 |
| `POST /save` | `{}` | 立即存世界檔 |
| `POST /start` / `POST /stop` / `POST /restart` | `{}` | 生命週期(stop/restart 可另帶倒數公告參數,見 routes) |
| `POST /update` | `{}` | 更新伺服器(執行中會回 409「請先停止」) |
| `POST /saves/backup` | `{ worldGuid }` | 立即備份(worldGuid 從 `GET /saves` 取 active 世界) |
| `POST /players/:userId/kick` | `{ message? }` | 踢人(userId 從 `/live` 的 players 對名稱解析) |
| `POST /moderation/ban` | `{ value, reason? }` | 封鎖(value = 名稱或 UID,離線可封) |
| `POST /moderation/unban` | `{ value }` | 解除封鎖 |
| `POST /rcon` | `{ command }` | 任意 RCON 指令,回 `{ output }` |

> 完整路由清單見 `packages/agent/src/routes.ts`;型別定義在 `@palserver/shared`
> (repo 內直接 import,repo 外照 JSON 形狀對接即可)。

---

## 收事件(伺服器 → 你的 bot)

不要輪詢 —— 用 agent 內建的 **webhook 系統**訂閱事件(玩家上下線/聊天/死亡、伺服器
啟停/崩潰、頭目、備份…):

1. GUI「Webhook」分頁新增一個 webhook,URL 填你服務的接收端點,格式選 `generic`。
2. 照 [webhooks.md](webhooks.md) 驗 HMAC 簽章、用 `X-Palserver-Delivery` 去重。
3. 只想把事件貼進 Discord 頻道、不寫程式?格式選 `discord`、URL 填頻道的
   Incoming Webhook 即可(或直接用官方 bot 的「事件通知」設定,連 webhook 都不用建)。

注意:webhook 需要你的接收端讓 agent 連得到(同機/內網/Tailscale)。

---

## 官方 bot 的環境變數(對照 `.env.example`)

| 變數 | 必填 | 說明 |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Discord bot token(唯一必填;指令自動註冊,免 Application/Guild ID) |
| `AGENT_URL` | 跨機 | 預設 `http://127.0.0.1:8250` |
| `AGENT_TOKEN` | 跨機 | 同機 loopback 免 token |
| `AGENT_INSTANCE_ID` | 多實例 | 留空自動取第一個實例 |
| `DISCORD_ADMIN_IDS` | | 管理指令白名單(逗號分隔 user id);**留空 = 沒人能用管理指令** |
| `DISCORD_STATUS_CHANNEL_ID` | | 狀態面板頻道(每分鐘自動更新一則狀態 embed) |
| `BRAND_ICON_URL` | | embed 品牌小圖,預設官網 icon |

> 同機零設定部署(GUI 貼 token、agent 代管)也是同一套變數 —— agent 自動幫你填。
> 唯一差異:「事件通知頻道」走 agent 內部通道,僅同機代管模式支援;standalone 請用
> webhook 系統收事件。

---

## 給第三方開發者的約定

- **相容性**:REST 回應與事件 payload 遵守「新增欄位不算破壞」——你的程式請容忍多出來的
  欄位、對缺欄位給預設值。事件合約版本規則見 webhooks.md 的 `specVersion`。
- **贊助閘門**:webhook 相關端點與部分進階資料(公會詳情等)需該 agent 有贊助授權,未解
  鎖回 403 —— 請把 403 當成「功能未解鎖」而不是錯誤重試。
- **自律**:`/live` 之類的查詢請控制在每 5–15 秒一次的等級;操作類端點不要重試風暴
  (agent 對同實例的操作有互斥,衝突會回 4xx/5xx 帶中文錯誤訊息,直接顯示給使用者即可)。
