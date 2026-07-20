# @palserver/discord-bot

palserver-GUI 官方 Discord bot:在 Discord 用 slash 指令回控 Palworld 伺服器(查在線玩家、狀態、廣播、存檔、重啟、踢人、封鎖、RCON),背後打的是 agent 的 REST API。

伺服器事件的**主動通知**(玩家上下線、伺服器啟停等)是另一條路 —— agent 內建的 webhook 系統,設定在 GUI 的「Webhook」分頁,不在這個套件裡。這個 bot 只處理「你在 Discord 下指令 → 回控伺服器」的方向。

這個套件同時也是**第三方串接 agent REST API 的參考實作**:如果你想串自己的機器人或工具,`src/agent.ts` 示範了完整的認證方式與各端點呼叫方法。

## 需求

- Node.js 22、pnpm(repo 根目錄已設定 workspace)
- 一個已在跑的 palserver agent,且知道它的 `AGENT_TOKEN`
- 一個 Discord Application + Bot(下方步驟會建)

## 設定步驟

1. **建立 Discord Application 與 Bot**
   到 [Discord Developer Portal](https://discord.com/developers/applications) 建立新 Application →
   左側「Bot」分頁按 Reset Token 取得 **DISCORD_TOKEN**;Application 首頁最上方是 **DISCORD_CLIENT_ID**。
   Bot 分頁把不必要的 Privileged Gateway Intents 全部關閉(這個 bot 不需要任何特權 intent)。

2. **把 bot 邀進你的伺服器**
   用「OAuth2 → URL Generator」勾 `bot` + `applications.commands`,權限至少給 `Send Messages`,
   產生連結開啟並選擇伺服器。開發者模式下右鍵伺服器圖示「複製伺服器 ID」得到 **DISCORD_GUILD_ID**。

3. **拿 AGENT_TOKEN**
   agent 主機 data-dir 底下的 `token` 檔(原生預設 `~/.palserver-agent/token`),或用 GUI 設定頁的配對碼
   在瀏覽器配對一次,同一份 token 就會寫進那個檔案。詳見 `.env.example` 裡的說明。

4. **填 `.env`**
   複製 `.env.example` 成 `.env`,填入上面幾步取得的值。

5. **註冊 slash 指令**(每次改動指令定義都要重跑一次)
   ```bash
   pnpm --filter @palserver/discord-bot deploy-commands
   ```

6. **啟動**
   - 開發:`pnpm --filter @palserver/discord-bot dev`
   - Docker:`cd packages/discord-bot && docker compose up -d --build`
   - 純 Node:`pnpm --filter @palserver/discord-bot build && pnpm --filter @palserver/discord-bot start`

## 指令列表

唯讀,任何人可用:

| 指令 | 說明 |
|---|---|
| `/players` | 查看目前在線玩家(名稱、等級、延遲) |
| `/status` | 查看伺服器狀態(在線人數、FPS、遊戲天數、據點數、運行時間、版本) |

管理限定(需要 Administrator 權限,回覆僅下指令者可見):

| 指令 | 說明 |
|---|---|
| `/broadcast <message>` | 在遊戲內廣播訊息 |
| `/save` | 立即儲存世界存檔 |
| `/restart` | 重新啟動伺服器 |
| `/kick <player>` | 踢出在線玩家(限在線,離線玩家踢不到) |
| `/ban <player> [reason]` | 封鎖玩家(可用名稱或 UID,離線也能封) |
| `/rcon <command>` | 執行任意 RCON 指令(進階功能,需自行了解指令語法) |

## 網路需求

bot 只**主動對外連線**(呼叫 agent REST API 與 Discord Gateway),不需要對外開放任何 port。
和 agent 分開部署時,用 Tailscale 之類的內網位址接 `AGENT_URL` 即可,NAT 環境一樣能跑。
