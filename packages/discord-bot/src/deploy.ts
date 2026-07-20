/** 獨立腳本:把 commands.ts 定義的 slash 指令註冊到指定 guild。
 * 執行:`pnpm deploy-commands`(=tsx src/deploy.ts)。指令改動後要重新跑一次。 */
import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config } from "./config.js";

const rest = new REST().setToken(config.discordToken);
const body = commands.map((c) => c.json);

console.log(`[deploy] 正在向 guild ${config.discordGuildId} 註冊 ${body.length} 個指令…`);
await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body });
console.log("[deploy] 完成。");
