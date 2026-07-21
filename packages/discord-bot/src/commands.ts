import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { agent, resolveOnlinePlayer } from "./agent.js";
import { BRAND, brandEmbed } from "./theme.js";

export interface CommandInstance {
  id: string;
  name: string;
}

export interface BotCommand {
  json: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** true = 僅管理員(Administrator 權限);handler 會再驗一次,builder 只負責 UI 隱藏。 */
  admin: boolean;
  /** true = 回覆只有下指令的人看得到。 */
  ephemeral: boolean;
  run: (interaction: ChatInputCommandInteraction, instance: CommandInstance) => Promise<EmbedBuilder>;
}

function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (days > 0 || hours > 0) parts.push(`${hours} 小時`);
  parts.push(`${minutes} 分`);
  return parts.join(" ");
}

/** RCON console 輸出可能很長,embed 一則最多 4096 字;截斷到約 1800 字給其他欄位留空間。 */
function truncateOutput(output: string, max = 1800): string {
  if (output.length <= max) return output;
  return `${output.slice(0, max)}\n…(輸出已截斷)`;
}

export const commands: BotCommand[] = [
  {
    json: new SlashCommandBuilder().setName("players").setDescription("查看目前在線玩家").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const live = await agent.live(instance.id);
      if (!live.available) {
        return brandEmbed({
          color: BRAND.warning,
          title: "無法取得即時資訊",
          description: live.reason ?? "伺服器目前離線或尚未設定即時資訊。",
          instanceName: instance.name,
        });
      }
      const description =
        live.players.length === 0
          ? "目前沒有玩家在線。"
          : live.players.map((p) => `**${p.name}** ・ Lv.${p.level} ・ ${p.ping}ms`).join("\n");
      return brandEmbed({
        color: BRAND.primary,
        title: `在線玩家(${live.players.length})`,
        description,
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
      if (!live.available || !live.metrics || !live.info) {
        return brandEmbed({
          color: BRAND.warning,
          title: "無法取得即時資訊",
          description: live.reason ?? "伺服器目前離線或尚未設定即時資訊。",
          instanceName: instance.name,
        });
      }
      const { metrics, info } = live;
      const embed = brandEmbed({
        color: BRAND.primary,
        title: info.servername || instance.name,
        description: info.description || undefined,
        instanceName: instance.name,
      });
      embed.addFields(
        { name: "在線人數", value: `${metrics.currentplayernum} / ${metrics.maxplayernum}`, inline: true },
        { name: "FPS", value: `${metrics.serverfps}`, inline: true },
        { name: "遊戲天數", value: `${metrics.days}`, inline: true },
        { name: "據點數", value: `${metrics.basecampnum}`, inline: true },
        { name: "運行時間", value: formatUptime(metrics.uptime), inline: true },
        { name: "版本", value: info.version || "未知", inline: true },
      );
      return embed;
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("broadcast")
      .setDescription("在遊戲內廣播訊息")      .addStringOption((opt) =>
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
        title: "已送出廣播",
        description: message,
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("save")
      .setDescription("立即儲存世界存檔")      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.save(instance.id);
      return brandEmbed({ color: BRAND.success, title: "已儲存世界存檔", instanceName: instance.name });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("restart")
      .setDescription("重新啟動伺服器")      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.restart(instance.id);
      return brandEmbed({
        color: BRAND.warning,
        title: "伺服器重新啟動中",
        description: "重啟需要一點時間,期間所有玩家會斷線。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("kick")
      .setDescription("將在線玩家踢出伺服器")      .addStringOption((opt) =>
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
      .setDescription("封鎖玩家(離線也可以,用名稱或 UID)")      .addStringOption((opt) =>
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
      return brandEmbed({
        color: BRAND.danger,
        title: "已封鎖玩家",
        description: reason ? `**${player}**\n原因:${reason}` : `**${player}**`,
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("rcon")
      .setDescription("執行 RCON 指令(進階功能,需了解指令語法)")      .addStringOption((opt) =>
        opt.setName("command").setDescription("RCON 指令").setRequired(true).setMaxLength(500),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const command = interaction.options.getString("command", true);
      const { output } = await agent.rcon(instance.id, command);
      const body = output.trim().length > 0 ? `\`\`\`\n${truncateOutput(output)}\n\`\`\`` : "(無輸出)";
      return brandEmbed({
        color: BRAND.primary,
        title: `RCON:${command}`,
        description: body,
        instanceName: instance.name,
      });
    },
  },
];
