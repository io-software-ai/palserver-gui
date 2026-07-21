import type { EmbedBuilder } from "discord.js";
import type { LiveStatus } from "@palserver/shared";
import { BRAND, brandEmbed } from "./theme.js";

/**
 * 共用的 embed 視圖(設計語言的單一真相來源)。規範:
 *  - 資料放 fields(inline 三欄節奏),數值用 `反引號`(monospace)呈現;敘述性文字才放 description。
 *  - 色彩語意固定:綠=正常/成功、藍=資訊、黃=過渡/警告、紅=破壞性/錯誤、灰=離線/中性。
 *  - 分隔符統一用「·」;玩家行格式 `**名字** · Lv.xx · xxms` 全 bot 一致。
 *  - /status 指令與狀態面板共用 buildStatusEmbed,確保兩處畫面永遠長一樣。
 */

export function formatUptime(totalSeconds: number): string {
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

/** 玩家一行的統一格式(/players、狀態面板共用)。 */
export function playerLine(p: { name: string; level: number; ping: number }): string {
  return `**${p.name}** · \`Lv.${p.level}\` · \`${Math.round(p.ping)}ms\``;
}

/** 玩家清單區塊:最多列 MAX 行,超出折疊為總數;空清單給一致的空狀態文字。 */
export function playersBlock(players: { name: string; level: number; ping: number }[], max = 20): string {
  if (players.length === 0) return "目前沒有玩家在線。";
  const lines = players.slice(0, max).map(playerLine);
  if (players.length > max) lines.push(`…共 ${players.length} 位玩家在線`);
  return lines.join("\n");
}

/** 伺服器離線 / 拿不到即時資訊的統一畫面(灰,中性——離線不是錯誤)。 */
export function buildUnavailableEmbed(reason: string | undefined, footer: string): EmbedBuilder {
  return brandEmbed({
    color: BRAND.muted,
    title: "伺服器離線",
    description: reason ?? "伺服器目前離線或尚未設定即時資訊。",
    instanceName: footer,
  });
}

/**
 * 伺服器狀態總覽(/status 指令與狀態面板共用):
 * 標題=伺服器名,六格數據(3×2 inline),玩家清單獨立一格。
 */
export function buildStatusEmbed(instanceName: string, live: LiveStatus, footer: string): EmbedBuilder {
  if (!live.available || !live.metrics || !live.info) {
    return buildUnavailableEmbed(live.reason ?? undefined, footer);
  }
  const { metrics, info } = live;
  const embed = brandEmbed({
    color: BRAND.success,
    title: info.servername || instanceName,
    description: info.description || undefined,
    instanceName: footer,
  });
  embed.addFields(
    { name: "在線人數", value: `\`${metrics.currentplayernum} / ${metrics.maxplayernum}\``, inline: true },
    { name: "伺服器 FPS", value: `\`${metrics.serverfps}\``, inline: true },
    { name: "運行時間", value: `\`${formatUptime(metrics.uptime)}\``, inline: true },
    { name: "遊戲天數", value: `\`第 ${metrics.days} 天\``, inline: true },
    { name: "據點數量", value: `\`${metrics.basecampnum}\``, inline: true },
    { name: "遊戲版本", value: info.version ? `\`${info.version}\`` : "未知", inline: true },
    { name: `在線玩家(${live.players.length})`, value: playersBlock(live.players), inline: false },
  );
  return embed;
}
