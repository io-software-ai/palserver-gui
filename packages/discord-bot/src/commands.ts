import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { bossRespawnInfo, bossStateMapCoord, isBossStateStale } from "@palserver/shared";
import { agent, resolveOnlinePlayer } from "./agent.js";
import { BRAND, brandEmbed } from "./theme.js";
import { buildStatusEmbed, buildUnavailableEmbed, formatUptime, playersBlock } from "./views.js";

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

/** ISO 時間 → Discord 原生相對時間標記(<t:…:R>,依讀者時區自動顯示「3 小時前」)。 */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** 對外位址若沒帶 port 就補上遊戲埠(playit.gg 等隧道位址常已含 port)。 */
function withPort(address: string, gamePort: number): string {
  return address.includes(":") ? address : `${address}:${gamePort}`;
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

  // ── 生命週期 ───────────────────────────────────────────────────────────
  {
    json: new SlashCommandBuilder().setName("start").setDescription("啟動伺服器").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.start(instance.id);
      return brandEmbed({
        color: BRAND.warning,
        title: "伺服器啟動中",
        description: "世界載入需要一點時間;可用 /status 或狀態面板確認上線。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("stop").setDescription("停止伺服器").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.stop(instance.id);
      return brandEmbed({
        color: BRAND.danger,
        title: "伺服器已停止",
        description: "可用 /start 重新啟動。",
        instanceName: instance.name,
      });
    },
  },

  // ── 資訊 / 社群 ────────────────────────────────────────────────────────
  {
    json: new SlashCommandBuilder().setName("join").setDescription("查看連線位址(怎麼加入伺服器)").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const c = await agent.connection(instance.id);
      const lines: string[] = [];
      if (c.externalAddress) lines.push(`**對外位址** \`${withPort(c.externalAddress, c.gamePort)}\``);
      for (const v of c.vpns.slice(0, 2)) lines.push(`**${v.name}** \`${v.address}:${c.gamePort}\``);
      if (c.publicIp && !c.externalAddress) {
        lines.push(
          `**公網** \`${c.publicIp}:${c.gamePort}\`${c.behindNat ? "(需在路由器設定連接埠轉發)" : ""}`,
        );
      }
      if (c.lan[0]) lines.push(`**區網** \`${c.lan[0]}:${c.gamePort}\``);
      return brandEmbed({
        color: BRAND.primary,
        title: "如何加入伺服器",
        description:
          lines.length > 0
            ? `在 Palworld 主選單「加入多人遊戲」輸入:\n${lines.join("\n")}`
            : "目前無法取得連線位址。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("version").setDescription("查看遊戲版本與更新狀態").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const v = await agent.versionStatus(instance.id);
      if (!v.supported) {
        return brandEmbed({
          color: BRAND.muted,
          title: "無法查詢版本",
          description: v.reason ?? "此伺服器不支援版本查詢。",
          instanceName: instance.name,
        });
      }
      const updateText =
        v.updateAvailable === true
          ? "有新版本可更新(管理員可用 /update)"
          : v.updateAvailable === false
            ? "已是最新版本"
            : "無法判定(Steam 無法連線或自帶安裝)";
      const embed = brandEmbed({
        color: v.updateAvailable === true ? BRAND.warning : BRAND.success,
        title: "遊戲版本",
        instanceName: instance.name,
      });
      embed.addFields(
        { name: "目前版本", value: v.gameVersion ? `\`${v.gameVersion}\`` : "未知", inline: true },
        { name: "更新狀態", value: updateText, inline: true },
      );
      const updated = relativeTime(v.latestUpdatedAt);
      if (updated) embed.addFields({ name: "官方最新更新", value: updated, inline: true });
      return embed;
    },
  },

  // ── 營運 ───────────────────────────────────────────────────────────────
  {
    json: new SlashCommandBuilder().setName("update").setDescription("更新伺服器到最新版(需先停止伺服器)").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      await agent.update(instance.id);
      return brandEmbed({
        color: BRAND.warning,
        title: "更新已開始",
        description: "下載與安裝需要幾分鐘;完成後用 /start 啟動、/version 確認版本。",
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("backup").setDescription("立即備份世界存檔").toJSON(),
    admin: true,
    ephemeral: true,
    run: async (_interaction, instance) => {
      const saves = await agent.savesStatus(instance.id);
      const world = saves.worlds.find((w) => w.active) ?? saves.worlds[0];
      if (!world) throw new Error("找不到世界存檔(伺服器可能還沒開過)。");
      const backup = await agent.backupNow(instance.id, world.guid);
      const embed = brandEmbed({ color: BRAND.success, title: "備份完成", instanceName: instance.name });
      embed.addFields(
        { name: "檔案", value: `\`${backup.name}\``, inline: true },
        { name: "大小", value: `\`${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MB\``, inline: true },
      );
      return embed;
    },
  },

  {
    json: new SlashCommandBuilder()
      .setName("unban")
      .setDescription("解除封鎖玩家(名稱或 UID)")
      .addStringOption((opt) =>
        opt.setName("player").setDescription("玩家名稱或 UID").setRequired(true),
      )
      .toJSON(),
    admin: true,
    ephemeral: true,
    run: async (interaction, instance) => {
      const player = interaction.options.getString("player", true);
      await agent.unban(instance.id, player);
      return brandEmbed({
        color: BRAND.success,
        title: "已解除封鎖",
        description: `**${player}** 已從封鎖名單移除。`,
        instanceName: instance.name,
      });
    },
  },

  // ── 趣味 / 社群 ────────────────────────────────────────────────────────
  {
    json: new SlashCommandBuilder().setName("top").setDescription("玩家等級排行榜(含離線玩家)").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const summary = await agent.playersSummary(instance.id);
      const ranked = summary.players
        .filter((p) => p.level !== null)
        .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
        .slice(0, 10);
      if (ranked.length === 0) {
        return brandEmbed({
          color: BRAND.muted,
          title: "等級排行榜",
          description: "尚無存檔掃描資料(伺服器開過並掃描後就會有)。",
          instanceName: instance.name,
        });
      }
      const lines = ranked.map((p, i) => {
        const guild = p.guildName ? ` · ${p.guildName}` : "";
        return `\`#${String(i + 1).padStart(2)}\` **${p.name}** · \`Lv.${p.level}\` · 帕魯 \`${p.palCount}\`${guild}`;
      });
      const embed = brandEmbed({
        color: BRAND.primary,
        title: "等級排行榜",
        description: lines.join("\n"),
        instanceName: instance.name,
      });
      const at = relativeTime(summary.generatedAt);
      if (at) embed.addFields({ name: "資料時間", value: at });
      return embed;
    },
  },

  {
    json: new SlashCommandBuilder().setName("guilds").setDescription("公會清單(成員數與據點等級)").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const list = await agent.guilds(instance.id);
      if (!list.available) {
        return brandEmbed({
          color: BRAND.muted,
          title: "公會清單",
          description: list.reason ?? "需要啟用 PalDefender REST 才能查詢公會。",
          instanceName: instance.name,
        });
      }
      const named = list.guilds.filter((g) => g.name);
      if (named.length === 0) {
        return brandEmbed({
          color: BRAND.muted,
          title: "公會清單",
          description: list.guilds.length > 0 ? "公會詳情需要贊助者授權。" : "目前沒有任何公會。",
          instanceName: instance.name,
        });
      }
      const lines = named
        .sort((a, b) => b.memberCount - a.memberCount)
        .slice(0, 10)
        .map((g) => `**${g.name}** · 成員 \`${g.memberCount}\` · 據點 \`${g.bases.length}\``);
      return brandEmbed({
        color: BRAND.primary,
        title: `公會清單(${named.length})`,
        description: lines.join("\n"),
        instanceName: instance.name,
      });
    },
  },

  {
    json: new SlashCommandBuilder().setName("boss").setDescription("野外頭目重生狀態(需頭目回報模組)").toJSON(),
    admin: false,
    ephemeral: false,
    run: async (_interaction, instance) => {
      const st = await agent.bossRespawns(instance.id);
      if (!st.supported || !st.modInstalled || !st.state) {
        return brandEmbed({
          color: BRAND.muted,
          title: "頭目重生",
          description:
            st.reason ??
            (st.modInstalled
              ? "尚無頭目資料(伺服器啟動後模組每 15 秒回報一次)。"
              : "尚未安裝頭目回報模組 — 到 GUI 的「頭目重生」分頁一鍵安裝。"),
          instanceName: instance.name,
        });
      }
      const now = Date.now() / 1000;
      const infos = st.state.bosses.map((b) => ({ b, info: bossRespawnInfo(b, now) }));
      const alive = infos.filter((x) => x.info.status === "alive").length;
      const dead = infos.filter((x) => x.info.status === "dead");
      const unknown = infos.length - alive - dead.length;
      const deadLines = dead
        .sort((a, b) => (a.info.respawnAt ?? Infinity) - (b.info.respawnAt ?? Infinity))
        .slice(0, 10)
        .map(({ b, info }) => {
          const c = bossStateMapCoord(b);
          const when =
            info.secondsLeft === null
              ? "約下個遊戲日重生"
              : info.secondsLeft <= 0
                ? "即將重生"
                : `約 ${formatUptime(info.secondsLeft)} 後重生`;
          return `\`(${Math.round(c.x)}, ${Math.round(c.y)})\` · ${when}`;
        });
      const stale = isBossStateStale(st.state, now)
        ? "\n資料已一段時間未更新(伺服器可能已停止)。"
        : "";
      const embed = brandEmbed({
        color: dead.length > 0 ? BRAND.warning : BRAND.success,
        title: "野外頭目重生",
        description:
          (dead.length > 0 ? `**已擊殺頭目(座標=地圖座標)**\n${deadLines.join("\n")}` : "目前沒有觀測到被擊殺的頭目。") +
          stale,
        instanceName: instance.name,
      });
      embed.addFields(
        { name: "存活", value: `\`${alive}\``, inline: true },
        { name: "已擊殺", value: `\`${dead.length}\``, inline: true },
        { name: "未知(區域未載入)", value: `\`${unknown}\``, inline: true },
      );
      return embed;
    },
  },
];
