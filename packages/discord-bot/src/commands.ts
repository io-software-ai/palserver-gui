import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { agent, resolveOnlinePlayer } from "./agent.js";
import { BRAND, brandEmbed } from "./theme.js";
import { buildStatusEmbed, buildUnavailableEmbed, playersBlock } from "./views.js";

export interface CommandInstance {
  id: string;
  name: string;
}

export interface BotCommand {
  json: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** true = 僅白名單管理員(GUI/DISCORD_ADMIN_IDS 設定);handler 執行時判定。 */
  admin: boolean;
  /** true = 回覆只有下指令的人看得到。 */
  ephemeral: boolean;
  run: (interaction: ChatInputCommandInteraction, instance: CommandInstance) => Promise<EmbedBuilder>;
}

/** RCON console 輸出可能很長,embed 一則最多 4096 字;截斷到約 1800 字給其他欄位留空間。 */
function truncateOutput(output: string, max = 1800): string {
  if (output.length <= max) return output;
  return `${output.slice(0, max)}\n…(輸出已截斷)`;
}

/** 多行文字轉 Discord blockquote(每行前綴 "> "),用於「引用使用者輸入」的統一呈現。 */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export const commands: BotCommand[] = [
  {
    json: new SlashCommandBuilder().setName("players").setDescription("查看目前在線玩家").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const live = await agent.live(instance.id);
      if (!live.available) return buildUnavailableEmbed(live.reason ?? undefined, instance.name);
      return brandEmbed({
        color: BRAND.primary,
        title: `在線玩家(${live.players.length})`,
        description: playersBlock(live.players),
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("status").setDescription("查看伺服器狀態").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const live = await agent.live(instance.id);
      // 與狀態面板共用同一個渲染器(views.ts),兩處畫面永遠一致。
      return buildStatusEmbed(instance.name, live, instance.name);
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("broadcast")
      .setDescription("在遊戲內廣播訊息")
      .addStringOption((opt) =>
        opt.setName("message").setDescription("要廣播的訊息").setRequired(true).setMaxLength(500),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const message = interaction.options.getString("message", true);
      await agent.announce(instance.id, message);
      return brandEmbed({
        color: BRAND.success,
        title: "廣播已送出",
        description: blockquote(message),
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("save").setDescription("立即儲存世界存檔").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.save(instance.id);
      return brandEmbed({
        color: BRAND.success,
        title: "存檔完成",
        description: "世界存檔已寫入磁碟。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("restart").setDescription("重新啟動伺服器").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.restart(instance.id);
      return brandEmbed({
        color: BRAND.warning,
        title: "伺服器重啟中",
        description: "所有玩家將暫時斷線;重啟完成後即可重新連線。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("kick")
      .setDescription("將在線玩家踢出伺服器")
      .addStringOption((opt) =>
        opt.setName("player").setDescription("玩家名稱(必須在線)").setRequired(true),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const name = interaction.options.getString("player", true);
      const player = await resolveOnlinePlayer(instance.id, name);
      await agent.kick(instance.id, player.userId);
      return brandEmbed({
        color: BRAND.warning,
        title: "已踢出玩家",
        description: `**${player.name}** 已被踢出伺服器。`,
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("ban")
      .setDescription("封鎖玩家(離線也可以,用名稱或 UID)")
      .addStringOption((opt) =>
        opt.setName("player").setDescription("玩家名稱或 UID").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("封鎖原因(選填)").setRequired(false).setMaxLength(200),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const player = interaction.options.getString("player", true);
      const reason = interaction.options.getString("reason") ?? undefined;
      await agent.ban(instance.id, player, reason);
      const embed = brandEmbed({ color: BRAND.danger, title: "已封鎖玩家", instanceName: instance.name });
      embed.addFields(
        { name: "對象", value: `\`${player}\``, inline: true },
        ...(reason ? [{ name: "原因", value: reason, inline: true }] : []),
      );
      return embed;
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("rcon")
      .setDescription("執行 RCON 指令(進階功能,需了解指令語法)")
      .addStringOption((opt) =>
        opt.setName("command").setDescription("RCON 指令").setRequired(true).setMaxLength(500),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const command = interaction.options.getString("command", true);
      const { output } = await agent.rcon(instance.id, command);
      const body = output.trim().length > 0 ? `\`\`\`\n${truncateOutput(output)}\n\`\`\`` : "(無輸出)";
      const embed = brandEmbed({
        color: BRAND.primary,
        title: "RCON 執行結果",
        description: body,
        instanceName: instance.name,
      });
      embed.addFields({ name: "指令", value: `\`${command.slice(0, 200)}\`` });
      return embed;
    },
  },
];
