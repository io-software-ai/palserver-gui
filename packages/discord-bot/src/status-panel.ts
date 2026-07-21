import type { Client, Message } from "discord.js";
import { agent, resolveInstance } from "./agent.js";
import { brandEmbed } from "./theme.js";
import { buildStatusEmbed } from "./views.js";

/**
 * 伺服器狀態面板:在指定頻道維護「一則」自動更新的 embed(每分鐘編輯同一則訊息,不洗版)。
 * bot 重啟後從頻道近期訊息找回自己上次的面板訊息續用(靠 footer 標記,免持久化 message id)。
 * 畫面與 /status 指令共用同一個渲染器(views.ts buildStatusEmbed),設計語言一致。
 */

const UPDATE_INTERVAL_MS = 60_000;
/** footer 前綴 = 面板訊息的識別標記(重啟後據此找回舊訊息)。 */
const PANEL_FOOTER_PREFIX = "狀態面板";

export function startStatusPanel(client: Client<true>, channelId: string): { stop(): void } {
  let message: Message | null = null;
  let stopped = false;

  async function resolvePanelMessage(): Promise<Message | null> {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) {
      console.error(`[discord-bot] 狀態面板頻道 ${channelId} 不存在或無法發送(缺權限?)`);
      return null;
    }
    // 找回自己上次的面板訊息(近 30 則、自己發的、footer 帶標記),找不到就發新的一則。
    try {
      const recent = await ch.messages.fetch({ limit: 30 });
      const mine = recent.find(
        (m) =>
          m.author.id === client.user.id &&
          m.embeds[0]?.footer?.text?.startsWith(PANEL_FOOTER_PREFIX) === true,
      );
      if (mine) return mine;
    } catch {
      /* 沒有讀歷史權限就直接發新的 */
    }
    return ch.send({ embeds: [brandEmbed({ title: "狀態面板啟動中…" })] });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const instance = await resolveInstance();
      const live = await agent.live(instance.id);
      const footer = `${PANEL_FOOTER_PREFIX} · ${instance.name} · 每分鐘自動更新`;
      const embed = buildStatusEmbed(instance.name, live, footer);
      if (!message) message = await resolvePanelMessage();
      if (message) await message.edit({ embeds: [embed] });
    } catch (err) {
      // 訊息被刪 / 頻道變動 → 丟掉 handle,下一輪重找;其他錯誤照實記 log 繼續跑。
      message = null;
      console.error("[discord-bot] 狀態面板更新失敗:", err instanceof Error ? err.message : err);
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), UPDATE_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
