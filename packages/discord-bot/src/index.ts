/** standalone / 跨機入口:讀環境變數 → startBot()。agent 同機自跑走的是 startBot()(見
 *  packages/agent 的 PALSERVER_RUN_BOT 分支與 DiscordBotManager),不經過這個檔。 */
import { startBot } from "./bot.js";
import { loadConfigFromEnv } from "./config.js";

const bot = startBot(loadConfigFromEnv());

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void bot.stop().finally(() => process.exit(0));
  });
}
