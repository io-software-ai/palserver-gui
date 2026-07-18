// 公開地圖 viewer 的共用圓形徽章產生器 —— 所有 DOM marker(玩家/離線玩家/公會據點/
// 地標)都套同一組視覺:圓形、白色/主題色描邊、卡片底、陰影,對齊
// packages/web/src/MapTab.tsx 的 .pmap-avatar 語言(GUI 的據點是圓角方形,這裡刻意統一
// 成圓形,讓 viewer 的圖層看起來是同一套系統)。礦物層點數太多(~3.9k)扛不住 DOM
// marker,另外用 canvas circleMarker 畫(見 LeafletMap.tsx),不走這支產生器。

import * as L from 'leaflet';

export interface BadgeIconOptions {
  /** 徽章直徑(px)。 */
  size: number;
  /** 描邊色,預設白色。 */
  ring?: string;
  /** 徽章底色,預設卡片色(主題色,亮/暗自動切換)。 */
  background?: string;
  /** 徽章內容(圖片 <img> 或首字母 <span>),呼叫端需自行 escape 任何使用者文字。 */
  contentHtml: string;
  /** Leaflet div-icon 外層 class,用來清掉預設白框。 */
  wrapClass: string;
  /** 疊加在 .pmap2-badge 上的額外 class(粗框/離線變暗等)。 */
  extraClass?: string;
  /** 徽章旁的名字標籤(已含定位樣式),沒有就不顯示。 */
  labelHtml?: string;
}

export function badgeIcon(opts: BadgeIconOptions): L.DivIcon {
  const { size, ring = '#fff', background = 'var(--card)', contentHtml, wrapClass, extraClass = '', labelHtml = '' } = opts;
  return L.divIcon({
    className: wrapClass,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [0, -size / 2],
    html:
      `<span class="pmap2-badge${extraClass ? ' ' + extraClass : ''}" style="width:${size}px;height:${size}px;border-color:${ring};background:${background}">` +
      contentHtml +
      `</span>` +
      labelHtml,
  });
}

/** 每個名字專屬的識別色(HSL hash),演算法照抄 GUI 的 guildColor/avatarIconUrl 雜湊 —— 玩家
 * 在 viewer 端沒有真人頭像可用:GUI 的「頭像」其實是拿 userId 雜湊去本地 pals.json 挑一隻
 * 隨機圖鑑怪物圖當佔位,不是真的玩家照片,也不是 agent 快照會帶的每人資料,所以 viewer
 * 改用「雜湊色底 + 名字首字母」的徽章,一樣是每個玩家穩定但不同的視覺。 */
export function letterColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 58% 40%)`;
}

/** 首字母徽章內容(白字置中,字級隨徽章尺寸縮放)。 */
export function initialHtml(name: string, size: number): string {
  const ch = (name.trim()[0] || '?').toUpperCase();
  const fontSize = Math.round(size * 0.42);
  return `<span class="pmap2-badge-initial" style="font-size:${fontSize}px">${ch}</span>`;
}

/** 徽章旁的名字標籤,水平/垂直位移都隨徽章尺寸算(取代舊版寫死在 CSS 裡、只為 14px 圓點
 * 調過的 left:18px/top:-3px —— 徽章尺寸階層拉開後(26~34px)標籤要跟著置中對齊)。 */
export function nameLabelHtml(escapedName: string, size: number, opts: { offline?: boolean } = {}): string {
  const top = Math.round(size / 2 - 9);
  return `<span class="pmap2-label${opts.offline ? ' pmap2-label-offline' : ''}" style="left:${size + 4}px;top:${top}px">${escapedName}</span>`;
}
