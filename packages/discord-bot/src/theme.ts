import { EmbedBuilder, type ColorResolvable } from "discord.js";

/**
 * palserver-GUI 品牌配色(取自 web `styles.css` 的 @theme)——讓 bot 的所有回覆
 * 與 GUI 視覺一致:天空藍為主、綠=成功、紅=危險、黃=警告。
 */
export const BRAND = {
  primary: 0x3fa7e0, // 天空藍(主色 / 資訊)
  success: 0x58ba64, // 草綠(成功 / 正常運行)
  danger: 0xef6a6a, // 莓紅(危險 / 破壞性操作 / 錯誤)
  warning: 0xf2b64f, // 陽黃(警告 / 過渡狀態)
  muted: 0x9aa4b2, // 灰(離線 / 中性)
} as const;

const BRAND_NAME = "palserver-GUI";
/** 品牌小圖(embed 左上 author icon)。預設用官網 icon;設環境變數 BRAND_ICON_URL 可換成自己的。 */
const ICON_URL = process.env.BRAND_ICON_URL?.trim() || "https://palserver-gui.iosoftware.ai/icon.png";

/**
 * 統一的品牌 embed 工廠:一致的顏色 / author(palserver-GUI + 選填 logo)/ footer(實例名)/ 時間戳。
 * 所有指令回覆都經過這裡,確保整體質感一致。
 */
export function brandEmbed(opts: {
  color?: number;
  title?: string;
  description?: string;
  instanceName?: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor((opts.color ?? BRAND.primary) as ColorResolvable)
    .setAuthor({ name: BRAND_NAME, ...(ICON_URL ? { iconURL: ICON_URL } : {}) })
    .setTimestamp();
  if (opts.title) embed.setTitle(opts.title);
  if (opts.description) embed.setDescription(opts.description);
  if (opts.instanceName) embed.setFooter({ text: opts.instanceName });
  return embed;
}
