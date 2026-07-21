# @palserver/discord-bot

palserver-GUI 官方 Discord bot:在 Discord 用 slash 指令回控 Palworld 伺服器(查在線玩家、狀態、廣播、存檔、重啟、踢人、封鎖、RCON),背後打的是 agent 的 REST API。

伺服器事件的**主動通知**(玩家上下線、伺服器啟停等)是另一條路 —— agent 內建的 webhook 系統,設定在 GUI 的「Webhook」分頁,不在這個套件裡。這個 bot 只處理「你在 Discord 下指令 → 回控伺服器」的方向。

這個套件同時也是**第三方串接 agent REST API 的參考實作**:如果你想串自己的機器人或工具,`src/agent.ts` 示範了完整的認證方式與各端點呼叫方法。**開發者指南(端點表、認證、收事件)見 [docs/discord-bot.md](../../docs/discord-bot.md)。**

> **想要零設定?同機部署直接用 GUI 的「Discord Bot」分頁** —— 貼上 bot token 就好,agent 會
> 幫你把 bot 跑起來,不用碰這個套件、不用 Docker/Node。下面這套是給**跨機部署**、或想自己
> 客製 / 當第三方串接範例的人用的。

## 需求(手動 / 跨機部署)

- 一個已在跑的 palserver agent
- 一個 Discord Application + Bot(下方步驟會建)
- 執行環境:Docker,或 Node.js 22 + pnpm(repo workspace)

## 設定步驟

1. **建立 Discord Application 與 Bot**
   到 [Discord Developer Portal](https://discord.com/developers/applications) 建立 Application →
   左側「Bot」分頁按 Reset Token 取得 **DISCORD_TOKEN**。不需要任何 Privileged Gateway Intents(全關)。

2. **把 bot 邀進你的伺服器**
   用「OAuth2 → URL Generator」勾 `bot` + `applications.commands`,權限至少給 `Send Messages`,
   開啟產生的連結並選擇伺服器。(**不用**複製伺服器 ID —— bot 上線會自動把指令註冊到它所在的每個伺服器。)

3. **填 `.env`**
   複製 `.env.example` 成 `.env`,填入 `DISCORD_TOKEN`。同機部署其餘留空即可;跨機才需要
   `AGENT_URL`(agent 主機位址)與 `AGENT_TOKEN`(可在 GUI 的「Discord Bot」分頁直接複製)。

4. **啟動**(slash 指令會在 bot 上線時自動註冊,沒有額外步驟)
   - Docker:`cd packages/discord-bot && docker compose up -d --build`
   - 純 Node:`pnpm --filter @palserver/discord-bot build && pnpm --filter @palserver/discord-bot start`
   - 開發:`pnpm --filter @palserver/discord-bot dev`

## 指令列表

唯讀,任何人可用:

| 指令 | 說明 |
|---|---|
| `/players` | 查看目前在線玩家(名稱、等級、延遲) |
| `/status` | 查看伺服器狀態(在線人數、FPS、遊戲天數、據點數、運行時間、版本) |
| `/join` | 查看連線位址(怎麼加入伺服器) |
| `/version` | 查看遊戲版本與有無更新 |
| `/top` | 玩家等級排行榜(存檔掃描資料,含離線玩家) |
| `/guilds` | 公會清單(需 PalDefender REST) |
| `/boss` | 野外頭目重生狀態(需頭目回報模組) |

管理限定(**白名單制**:只有 `DISCORD_ADMIN_IDS` / GUI 白名單裡的 Discord user id 能用,
**不看** Discord 伺服器管理員權限;留空 = 沒有人能用。回覆僅下指令者可見):

| 指令 | 說明 |
|---|---|
| `/broadcast <message>` | 在遊戲內廣播訊息 |
| `/save` | 立即儲存世界存檔 |
| `/backup` | 立即備份世界存檔 |
| `/start` / `/stop` / `/restart` | 啟動 / 停止 / 重新啟動伺服器 |
| `/update` | 更新伺服器到最新版(需先停止伺服器) |
| `/kick <player>` | 踢出在線玩家(限在線,離線玩家踢不到) |
| `/ban <player> [reason]` | 封鎖玩家(可用名稱或 UID,離線也能封) |
| `/unban <player>` | 解除封鎖 |
| `/rcon <command>` | 執行任意 RCON 指令(進階功能,需自行了解指令語法) |

## 狀態面板(選用)

設 `DISCORD_STATUS_CHANNEL_ID` 後,bot 會在該頻道維護**一則每分鐘自動更新**的伺服器狀態
embed(在線玩家、FPS、運行時間…),重啟後自動找回同一則訊息續用、不洗版。bot 需要該頻道的
「發言」與「讀取訊息歷史」權限。

## 網路需求

bot 只**主動對外連線**(呼叫 agent REST API 與 Discord Gateway),不需要對外開放任何 port。
和 agent 分開部署時,用 Tailscale 之類的內網位址接 `AGENT_URL` 即可,NAT 環境一樣能跑。
