import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { AgentError, resolveInstance } from "./agent.js";
import { commands } from "./commands.js";
import { config } from "./config.js";
import { BRAND, brandEmbed } from "./theme.js";

// slash 指令走 Interactions,不需要讀訊息內容,所以只要 Guilds intent。
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commandMap = new Map(commands.map((c) => [c.json.name, c]));

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[discord-bot] 已上線:${readyClient.user.tag}`);
  try {
    const instance = await resolveInstance();
    readyClient.user.setActivity(instance.name, { type: ActivityType.Watching });
  } catch (err) {
    console.error(
      "[discord-bot] 設定上線狀態失敗(不影響指令運作):",
      err instanceof Error ? err.message : err,
    );
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await handleCommand(interaction);
});

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  if (command.admin) {
    const hasPermission = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    if (!hasPermission) {
      await interaction.reply({
        embeds: [
          brandEmbed({ color: BRAND.danger, title: "權限不足", description: "此指令僅限管理員使用。" }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

  try {
    const instance = await resolveInstance();
    const embed = await command.run(interaction, instance);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const message = err instanceof AgentError || err instanceof Error ? err.message : String(err);
    console.error(`[discord-bot] /${interaction.commandName} 執行失敗:`, message);
    await interaction.editReply({
      embeds: [brandEmbed({ color: BRAND.danger, title: "操作失敗", description: message })],
    });
  }
}

client.login(config.discordToken);
