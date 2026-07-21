import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type Client as DiscordClient,
} from "discord.js";
import { AgentError, configureAgent, resolveInstance } from "./agent.js";
import { commands } from "./commands.js";
import { BRAND, brandEmbed } from "./theme.js";

export interface StartBotOptions {
  /** Discord bot token(唯一必填)。application id / guild id 都從 token 推導。 */
  discordToken: string;
  /** 要回控的 agent base URL(不含結尾斜線)。同機 = http(s)://127.0.0.1:<port>。 */
  agentUrl: string;
  /** 跨機才需要;同機連 loopback 免 token。 */
  agentToken?: string;
  /** 固定操作的實例 id;留空取第一個實例。 */
  instanceId?: string;
  /** 管理員白名單(whitelist-only):只有這些 Discord user id 能用管理指令。留空 = 沒人能用。 */
  adminUserIds?: string[];
}

export interface RunningBot {
  /** 關閉 Discord 連線(登出 gateway)。 */
  stop(): Promise<void>;
}

/**
 * 啟動 Discord bot:建立 gateway client、自動註冊 slash 指令、把互動轉成對 agent 的 REST 呼叫。
 * standalone(index.ts)與 agent 同機內嵌(PALSERVER_RUN_BOT)共用這一支;差別只在參數怎麼來。
 * 呼叫端負責讓行程專屬於 bot —— 登入失敗會直接 process.exit(1),讓監督者(agent / shell)察覺並重試。
 */
export function startBot(opts: StartBotOptions): RunningBot {
  configureAgent({ agentUrl: opts.agentUrl, agentToken: opts.agentToken ?? "", instanceId: opts.instanceId });

  // slash 指令走 Interactions,不需要讀訊息內容,所以只要 Guilds intent。
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const commandMap = new Map(commands.map((c) => [c.json.name, c]));
  const commandBody = commands.map((c) => c.json);
  // 管理員白名單(whitelist-only):只認這些 Discord user id,不看 Discord 伺服器管理員權限。留空 = 沒人能用管理指令。
  const adminIds = new Set(opts.adminUserIds ?? []);

  /** 事件通知(同機模式):agent 主行程經 IPC 傳來渲染好的 embed,貼到指定頻道。
   *  standalone(無 IPC 父行程)時 process.on("message") 不會觸發,無害。 */
  async function postNotify(channelId: string, embeds: unknown[]): Promise<void> {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch?.isSendable()) await ch.send({ embeds: embeds as APIEmbed[] });
      else console.error(`[discord-bot] 通知頻道 ${channelId} 不存在或無法發送(缺權限?)`);
    } catch (err) {
      console.error("[discord-bot] 發送事件通知失敗:", err instanceof Error ? err.message : err);
    }
  }
  process.on("message", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { kind?: string; channelId?: string; payload?: { embeds?: unknown[] } };
    if (m.kind !== "notify" || !m.channelId || !m.payload) return;
    void postNotify(m.channelId, m.payload.embeds ?? []);
  });

  /** 啟動時把指令自動註冊到 bot 目前所在的每個 Discord 伺服器 —— 使用者不必手動跑 deploy,
   *  也不必填 application id / guild id(都從 token 推導)。指令定義變動後重啟即重新註冊。 */
  async function registerGuildCommands(readyClient: Client<true>): Promise<void> {
    const guilds = [...readyClient.guilds.cache.values()];
    for (const guild of guilds) {
      try {
        await readyClient.application.commands.set(commandBody, guild.id);
      } catch (err) {
        console.error(`[discord-bot] 註冊指令到「${guild.name}」失敗:`, err instanceof Error ? err.message : err);
      }
    }
    console.log(`[discord-bot] 已在 ${guilds.length} 個伺服器自動註冊 ${commandBody.length} 個指令`);
  }

  async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    if (command.admin && !adminIds.has(interaction.user.id)) {
      await interaction.reply({
        embeds: [
          brandEmbed({
            color: BRAND.danger,
            title: "權限不足",
            description: "此指令僅限管理員(白名單)使用。請伺服器主在 GUI 的「Discord Bot」分頁把你的 Discord user id 加入白名單。",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
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

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[discord-bot] 已上線:${readyClient.user.tag}`);
    await registerGuildCommands(readyClient);
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

  // bot 被加進新的 Discord 伺服器 → 自動註冊指令(不用手動處理)。
  client.on(Events.GuildCreate, async (guild) => {
    try {
      await guild.client.application?.commands.set(commandBody, guild.id);
      console.log(`[discord-bot] 已在新加入的「${guild.name}」註冊指令`);
    } catch (err) {
      console.error(`[discord-bot] 註冊指令到「${guild.name}」失敗:`, err instanceof Error ? err.message : err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleCommand(interaction);
  });

  // 登入失敗(token 無效等)= 這個 bot 行程沒有存在意義 —— 印出原因並以非零碼退出,
  // 讓監督者(agent 的 DiscordBotManager,或 shell)看得到崩潰並按退避重試。
  void (client as DiscordClient).login(opts.discordToken).catch((err) => {
    console.error("[discord-bot] 登入失敗:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

  return {
    stop: async () => {
      await client.destroy();
    },
  };
}
