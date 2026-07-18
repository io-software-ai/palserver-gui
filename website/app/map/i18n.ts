// /map viewer 專用的輕量 i18n:這個路由在 [lang] 之外,不接站上的 i18n/dictionaries.ts
// 體系,靠 navigator.language 自己選 zh/en/ja 三語小字典就夠。

export type MapLang = 'zh' | 'en' | 'ja';

export function pickMapLang(): MapLang {
  if (typeof navigator === 'undefined') return 'zh';
  const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'zh'];
  for (const raw of prefs) {
    const l = String(raw).toLowerCase();
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('en')) return 'en';
    if (l.startsWith('zh')) return 'zh';
  }
  return 'zh';
}

interface MapDict {
  loading: string;
  missingIdTitle: string;
  missingIdBody: string;
  notFoundTitle: string;
  notFoundBody: string;
  fetchErrorTitle: string;
  fetchErrorBody: string;
  offlineBanner: string;
  updatedJustNow: string;
  updatedSecondsAgo: (n: number) => string;
  updatedMinutesAgo: (n: number) => string;
  online: (n: number, max?: number) => string;
  players: string;
  offlinePlayers: string;
  bases: string;
  landmarks: string;
  ores: string;
  mainWorld: string;
  worldTree: string;
  lv: string;
  lastSeenAt: string;
  fastTravel: string;
  tower: string;
  noPlayers: string;
  poweredBy: string;
}

const dict: Record<MapLang, MapDict> = {
  zh: {
    loading: '載入中…',
    missingIdTitle: '缺少地圖連結參數',
    missingIdBody: '這個網址少了 ?s= 分享代碼,請跟伺服器管理員確認完整連結。',
    notFoundTitle: '連結不存在或已被撤銷',
    notFoundBody: '這個地圖分享連結可能已經失效,或伺服器管理員已關閉公開分享。',
    fetchErrorTitle: '暫時連不上地圖伺服器',
    fetchErrorBody: '請稍後再試,或跟伺服器管理員確認狀態。',
    offlineBanner: '伺服器可能已離線(超過 5 分鐘沒有更新)',
    updatedJustNow: '剛剛更新',
    updatedSecondsAgo: (n) => `更新於 ${n} 秒前`,
    updatedMinutesAgo: (n) => `更新於 ${n} 分鐘前`,
    online: (n, max) => (max != null ? `在線 ${n} / ${max}` : `在線 ${n}`),
    players: '玩家',
    offlinePlayers: '離線玩家',
    bases: '公會據點',
    landmarks: '地標',
    ores: '礦物',
    mainWorld: '主世界',
    worldTree: '世界樹',
    lv: 'Lv.',
    lastSeenAt: '最後位置',
    fastTravel: '快速旅行',
    tower: '頭目塔',
    noPlayers: '目前沒有玩家在線上',
    poweredBy: 'palserver GUI 公開地圖',
  },
  en: {
    loading: 'Loading…',
    missingIdTitle: 'Missing map link parameter',
    missingIdBody: 'This URL is missing the ?s= share code — check the full link with your server admin.',
    notFoundTitle: 'Link not found or revoked',
    notFoundBody: 'This map share link may have expired, or the admin turned off public sharing.',
    fetchErrorTitle: "Can't reach the map server right now",
    fetchErrorBody: 'Please try again shortly, or check with your server admin.',
    offlineBanner: 'Server may be offline (no update for over 5 minutes)',
    updatedJustNow: 'Updated just now',
    updatedSecondsAgo: (n) => `Updated ${n}s ago`,
    updatedMinutesAgo: (n) => `Updated ${n}m ago`,
    online: (n, max) => (max != null ? `Online ${n} / ${max}` : `Online ${n}`),
    players: 'Players',
    offlinePlayers: 'Offline players',
    bases: 'Guild bases',
    landmarks: 'Landmarks',
    ores: 'Ores',
    mainWorld: 'Main World',
    worldTree: 'World Tree',
    lv: 'Lv.',
    lastSeenAt: 'Last seen',
    fastTravel: 'Fast Travel',
    tower: 'Tower',
    noPlayers: 'No players online right now',
    poweredBy: 'Public map by palserver GUI',
  },
  ja: {
    loading: '読み込み中…',
    missingIdTitle: '地図リンクのパラメータがありません',
    missingIdBody: 'この URL には ?s= 共有コードがありません。管理者に完全なリンクを確認してください。',
    notFoundTitle: 'リンクが存在しないか取り消されました',
    notFoundBody: 'この地図共有リンクは無効になったか、管理者が公開共有をオフにした可能性があります。',
    fetchErrorTitle: '地図サーバーに接続できません',
    fetchErrorBody: 'しばらくしてから再試行するか、管理者に状態を確認してください。',
    offlineBanner: 'サーバーがオフラインの可能性があります(5分以上更新なし)',
    updatedJustNow: 'たった今更新',
    updatedSecondsAgo: (n) => `${n}秒前に更新`,
    updatedMinutesAgo: (n) => `${n}分前に更新`,
    online: (n, max) => (max != null ? `オンライン ${n} / ${max}` : `オンライン ${n}`),
    players: 'プレイヤー',
    offlinePlayers: 'オフラインプレイヤー',
    bases: 'ギルド拠点',
    landmarks: 'ランドマーク',
    ores: '鉱石',
    mainWorld: 'メインワールド',
    worldTree: '世界樹',
    lv: 'Lv.',
    lastSeenAt: '最終位置',
    fastTravel: '高速移動',
    tower: 'タワー',
    noPlayers: '現在オンラインのプレイヤーはいません',
    poweredBy: 'palserver GUI 公開マップ',
  },
};

export function getMapDict(lang: MapLang): MapDict {
  return dict[lang];
}
