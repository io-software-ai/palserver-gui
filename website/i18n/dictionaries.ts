import type { Locale } from './config';

/** 一段可帶「強調字」的小標籤文字(hero 的 chip)。 */
type Chip = { lead?: string; strong?: string; tail?: string; plain?: string };
type Point = { head: string; body: string };
type Step = { title: string; body: string };
type Wish = { q: string; head: string; body: string };
type HighlightItem = { tag: string; title: string; body: string };
type FeatureText = {
  title: string;
  /** body 可帶一段強調字(pre + <em>emph</em> + post);純文字時只給 pre。 */
  bodyPre: string;
  bodyEmph?: string;
  bodyPost?: string;
  bullets?: string[];
  alt: string;
  label: string;
};

export type Dictionary = {
  meta: { title: string; description: string; ogAlt: string };
  nav: { features: string; how: string; start: string; team: string; github: string; download: string };
  hero: {
    eyebrow: string;
    h1Emph: string;
    h1Rest: string;
    h1Line2: string;
    sub: string;
    ctaDownload: string;
    ctaLearn: string;
    chips: Chip[];
    shotAlt: string;
    shotLabel: string;
  };
  stats: { labels: string[]; free: string };
  why: { eyebrow: string; h2: string; lead: string };
  how: {
    eyebrow: string;
    h2: string;
    lead: string;
    deviceTitle: string;
    deviceDesc: string;
    midLine1: string;
    midLine2: string;
    serverTitle: string;
    serverDesc: string;
  };
  features: { eyebrow: string; h2: string; lead: string; items: FeatureText[] };
  highlights: { eyebrow: string; h2: string; items: HighlightItem[] };
  audience: {
    eyebrow: string;
    h2: string;
    beginnerTag: string;
    beginnerTitle: string;
    powerTag: string;
    powerTitle: string;
    beginner: Point[];
    power: Point[];
  };
  wishes: { eyebrow: string; h2: string; lead: string; items: Wish[] };
  getStarted: {
    eyebrow: string;
    h2: string;
    lead: string;
    steps: Step[];
    shotAlt: string;
    shotLabel: string;
    figcaption: string;
  };
  niceDetails: { eyebrow: string; h2: string; lead: string; shotAlt: string; shotLabel: string };
  team: { eyebrow: string; h2: string; lead: string; roles: string[] };
  closing: {
    eyebrow: string;
    h2: string;
    lead: string;
    ctaDownload: string;
    notePre: string;
    noteLink: string;
    notePost: string;
  };
  footer: { madePre: string; madeMid: string; license: string };
  langLabel: string;
};

const zh: Dictionary = {
  meta: {
    title: 'palserver GUI — 帕魯專用伺服器管理, 一鍵開服零指令',
    description:
      'palserver GUI 是免費開源的帕魯(Palworld)專用伺服器管理工具:一鍵開服、內建世界地圖、三套主題、80+ 世界設定、模組管理、自動備份、手機遠端管理。零指令、零設定檔, 免安裝下載即用。',
    ogAlt: 'palserver GUI 伺服器管理總覽畫面',
  },
  nav: { features: '功能', how: '如何運作', start: '開始使用', team: '團隊', github: 'GitHub', download: '下載' },
  hero: {
    eyebrow: '開源 · 免費 · 帕魯專用伺服器管理',
    h1Emph: '一鍵',
    h1Rest: '開一台帕魯伺服器。',
    h1Line2: '零指令、零設定檔。',
    sub: 'palserver GUI 把開服、改設定、備份、邀朋友、救崩潰, 全部變成畫面上的按鈕。裝在放伺服器的電腦上, 手機、平板、電腦打開網頁就能管理——人在外面, 也能一鍵重開伺服器。',
    ctaDownload: '免費下載',
    ctaLearn: '看看能做什麼',
    chips: [
      { strong: '免安裝', tail: ' 下載就能用' },
      { lead: '本機管理 ', strong: '免密碼' },
      { lead: '手機平板 ', strong: '都能管' },
      { plain: '中／英／日 · 三主題 × 深淺色' },
    ],
    shotAlt: 'palserver GUI 伺服器總覽畫面:狀態、玩家、效能一目了然',
    shotLabel: 'palserver GUI',
  },
  stats: { labels: ['需要記的指令', '管理分頁, 一頁包辦', '介面語言', '開源 · 非商業用途'], free: '免費' },
  why: {
    eyebrow: '為什麼需要它',
    h2: '開專用伺服器, 不該是一場惡夢。',
    lead: '改不完的設定檔、背不完的指令、朋友卡在「連不進來」、遊戲一改版就炸存檔、半夜伺服器崩潰沒人救……這些不是「架好就沒事」的小事。palserver GUI 把每一項都收進乾淨的畫面裡, 新手覺得簡單, 老手覺得夠力。',
  },
  how: {
    eyebrow: '一分鐘看懂',
    h2: '打開網頁, 人在哪都能顧。',
    lead: '把 palserver GUI 裝在放伺服器的那台電腦上, 之後不管用電腦、手機還是平板, 打開網頁就是管理畫面。遊戲和存檔都留在你自己的電腦裡, 網頁只是遙控器——在家直接進, 出門在外點個連結也能連上。',
    deviceTitle: '你的裝置',
    deviceDesc: '電腦、手機、平板。打開網頁就是管理畫面, 在家直接進, 出門點連結即連。',
    midLine1: '安全連線',
    midLine2: '點一下就連上',
    serverTitle: '放伺服器的電腦',
    serverDesc: 'palserver GUI 在這裡幫你顧著伺服器:存檔、模組、備份, 通通打理好。',
  },
  features: {
    eyebrow: '功能巡禮',
    h2: '從開服到救火, 一頁全包。',
    lead: '每一台伺服器點進去就是完整面板:總覽、效能、玩家、地圖、指令、世界設定、引擎微調、模組、帕魯數值(贊助版)、存檔備份、自動重啟、日誌——13 個分頁一次展開, 不需要的分頁還能自己關掉。',
    items: [
      {
        title: '所有伺服器, 一眼掌握',
        bodyPre: '每台的狀態、原味/強化、遊戲埠、可更新提示都在卡片上, 點進去就是完整管理。',
        bullets: ['伺服器卡片可拖曳排序', '分頁能自訂顯示 / 隱藏, 總覽卡片也能關'],
        alt: 'palserver GUI 伺服器列表',
        label: '伺服器列表',
      },
      {
        title: '設定與引擎微調, 附白話說明',
        bodyPre: '世界規則、經驗倍率、掉落、PvP 全部有中文標籤與提示; 進階玩家想調的',
        bodyEmph: '引擎參數',
        bodyPost: '也備好預設組合, 一鍵套用。',
        bullets: [
          '每一項都告訴你調高調低會怎樣',
          '寫檔保留你手動加的設定',
          '啟動參數面板:Steam 查詢埠(queryport)、PalDefender REST 端口可自行設定, 並檢查埠號是否重複',
          'MOTD 登入公告直接在設定頁編輯',
        ],
        alt: '引擎微調與效能預設',
        label: '引擎微調',
      },
      {
        title: '反外掛與模組, 一鍵管理',
        bodyPre: '反外掛與模組載入器一鍵裝、更新、移除, 還會提醒「遊戲改版後模組可能暫時失效」。模組直接在畫面上開關。',
        alt: '模組安裝與管理',
        label: '模組管理',
      },
      {
        title: '即時效能, 走勢一目了然',
        bodyPre: 'CPU、記憶體、運行時間, 加上伺服器流暢度指標, 配上即時走勢圖。撐不住的時候, 你會第一個知道。',
        alt: '效能分析與即時走勢',
        label: '效能分析',
      },
      {
        title: '80+ 世界參數, 不用開檔案',
        bodyPre: '難度、資源、繁殖、據點、傷害倍率……全部整理成分類、附說明的表單, 改完提示你重啟生效。存檔損壞還會偵測並一鍵重建。',
        bullets: ['帕魯與道具資料更新到 Palworld 1.0(藥師島)', '主動技 / 詞條附中文與日文'],
        alt: '世界設定編輯器',
        label: '世界設定',
      },
      {
        title: '換裝置、邀朋友, 一頁搞定',
        bodyPre: '設定頁幫你準備好「一鍵登入連結」, 複製給手機或另一台電腦, 點開就能連; 也能一鍵清除瀏覽器暫存重連。',
        alt: '設定頁與多裝置連線',
        label: '在其他裝置連線',
      },
    ],
  },
  highlights: {
    eyebrow: 'v2.0.1 全新',
    h2: '地圖、主題、贊助功能——這次補齊的三件大事。',
    items: [
      {
        tag: '世界地圖',
        title: '整張帕魯世界, 攤開來看',
        body: '帕魯島 + 櫻島 + Feybreak 全地圖內建, 不用再自備底圖。線上玩家即時定位、離線玩家最後位置、公會據點、野外首領(Alpha 帕魯)圖層、地標通通標好, 支援全螢幕檢視(/map); 傳送、生成等需要座標的指令, 直接點地圖放圖釘就好, 不用手打座標。',
      },
      {
        tag: '主題系統',
        title: '三套主題, 深淺色都照顧到',
        body: '帕魯原色、白銀(Vercel 風)、極光翡翠, 每套都有深色 / 淺色, 搭配帶迷你即時預覽的質感切換彈窗。白銀與極光翡翠是贊助者專屬主題。',
      },
      {
        tag: '贊助者先行版',
        title: '先玩到, 到期後大家都能用',
        body: '帕魯數值編輯器(修改物種 HP / 攻防 / 捕獲率, 首領版可單獨調)、傳送玩家、批量給予道具、自訂帕魯與公會據點詳情——有效贊助者先解鎖, 贊助到期後對所有人開放。',
      },
    ],
  },
  audience: {
    eyebrow: '兩種人都合用',
    h2: '新手覺得簡單, 老手覺得夠力。',
    beginnerTag: 'For beginners',
    beginnerTitle: '第一次開伺服器',
    powerTag: 'For power users',
    powerTitle: '老手想要的控制力',
    beginner: [
      { head: '一鍵開服。', body: '建立、啟動、更新全部用按的, 不背指令、不改設定檔。' },
      { head: '本機免密碼直進。', body: '在自己電腦打開就是管理畫面, 零設定。' },
      { head: '邀朋友零門檻。', body: '傳一條設定連結, 朋友點一下就連上。' },
      { head: '可愛又直覺。', body: '中文介面、附說明, 滑鼠點一點就能調。' },
    ],
    power: [
      { head: '原生 / Docker 雙後端。', body: '直接開 PalServer 或跑容器; 可接管既有安裝或指定空資料夾安裝; Docker 也能用自訂鏡像, k8s 後端一律可選。' },
      { head: 'Schema 驅動設定。', body: '80+ 世界參數 + Engine.ini 引擎微調, 型別一致、保留未管理的鍵。' },
      { head: 'RCON 指令台 + 模組。', body: '內建 RCON; PalDefender / UE4SS 一鍵裝更新移除, PalDefender REST 端口可自訂。' },
      { head: '備份排程與遷移。', body: 'tar.gz 定期備份、一鍵還原、跨來源存檔搬家、REST API 代理。' },
    ],
  },
  wishes: {
    eyebrow: '社群一路陪著長大',
    h2: '你許願的, 我們都做了。',
    lead: 'palserver GUI 從一個「懶得改設定檔」的小工具開始, 這兩年社群提的需求, 一個一個補上。',
    items: [
      { q: '能不能把既有的存檔導進去?', head: '存檔遷移', body: '——別台專用伺服器、v1 舊版、本機四人邀請碼存檔都能接管。' },
      { q: '好怕存檔壞掉…', head: '備份排程 + 一鍵還原', body: ', 還會偵測存檔損壞並協助重建。' },
      { q: '想開伺服器玩模組', head: '反外掛與模組一鍵', body: '安裝、更新、移除, 模組在畫面上直接開關。' },
      { q: '死亡掉落、孵化時間也能調嗎?', head: '80+ 世界參數視覺化', body: ', 分類、附說明, 不用再開設定檔。' },
      { q: '朋友延遲太高連不進來', head: 'VPN 一鍵邀請', body: ', 或選公司的 IP 直連設定服務。' },
      { q: '不想每次都打一長串指令更新', head: '版本檢查 + 一鍵更新', body: ', 零指令。' },
      { q: '同一台電腦想多開幾台伺服器, 常常連不上', head: '查詢埠自動避開衝突', body: '——同機多開的 Steam 查詢埠(queryport)不再打架, 每台都能自行指定。' },
      { q: '玩家 ID 外流讓人不安心', head: 'SteamID 全面遮蔽', body: '——名冊、日誌、玩家選擇器、指令輸出一律中間碼, 要看再點開顯示或複製。' },
    ],
  },
  getStarted: {
    eyebrow: '三步開始',
    h2: '下載、執行、打開瀏覽器。',
    lead: '不用先裝任何環境、不用碰命令列。免安裝執行檔把需要的都包好了。',
    steps: [
      { title: '下載', body: '到下載頁抓對應你系統的檔案, 解壓縮就好。' },
      { title: '雙擊執行', body: '視窗會顯示你的管理網址, 和邀請朋友用的連結, 讓它開著就好。' },
      { title: '打開瀏覽器', body: '點視窗裡的管理網址, 進入畫面, 開你的第一台伺服器。' },
    ],
    shotAlt: 'palserver GUI 首次連線與配對畫面',
    shotLabel: '第一次連線',
    figcaption: '換裝置或幫朋友設定?把設定連結傳過去, 點一下就連上——不用手動輸入一長串密碼。',
  },
  niceDetails: {
    eyebrow: '細節控的貼心',
    h2: '連「開場白」都幫你想好了。',
    lead: '內建公告系統、存檔損壞偵測與一鍵重建、自動重啟(排程 / 記憶體門檻 / 崩潰救援)、玩家 ID 全站打碼、完整世界地圖(帕魯島 + 櫻島 + Feybreak, 含全螢幕檢視)、三套主題 × 深淺色、三語介面——很多你之後才會感謝的小地方。',
    shotAlt: 'palserver GUI 內建公告系統',
    shotLabel: '公告系統',
  },
  team: {
    eyebrow: '誰做的',
    h2: '一群喜歡帕魯的人, 用愛維護。',
    lead: 'palserver GUI 完全免費開源, 由核心團隊持續維護。喜歡的話, 一杯咖啡就是最大的鼓勵。',
    roles: ['核心開發人員', '核心開發人員', '核心團隊維護者', '核心團隊維護者', '核心團隊維護者・資安', '核心團隊維護者'],
  },
  closing: {
    eyebrow: '開始吧',
    h2: '把開伺服器的麻煩, 交給 palserver GUI。',
    lead: '完全免費、開源。喜歡的話到 GitHub 給顆星、到 Discord 一起聊。',
    ctaDownload: '免費下載',
    notePre: '不想自己顧?我們也提供 ',
    noteLink: '遊戲伺服器代管維護服務',
    notePost: '——版本更新、備份、崩潰救援交給我們。',
  },
  footer: {
    madePre: '由 ',
    madeMid: ' 與核心團隊用愛製作 · ',
    license: 'palserver GUI 2.0 · 開源免費 · 僅限非商業使用(PolyForm Noncommercial), 不得用於營利',
  },
  langLabel: '語言',
};

const en: Dictionary = {
  meta: {
    title: 'palserver GUI — Palworld dedicated server manager, one-click, no commands',
    description:
      'palserver GUI is a free, open-source manager for Palworld dedicated servers: one-click hosting, a built-in world map, three themes, 80+ world settings, mod management, automatic backups, and remote control from your phone. No commands, no config files — download and run, no install.',
    ogAlt: 'palserver GUI server management overview',
  },
  nav: { features: 'Features', how: 'How it works', start: 'Get started', team: 'Team', github: 'GitHub', download: 'Download' },
  hero: {
    eyebrow: 'Open source · Free · Palworld dedicated server manager',
    h1Emph: 'One click',
    h1Rest: ' to run a Palworld server.',
    h1Line2: 'No commands, no config files.',
    sub: 'palserver GUI turns hosting, settings, backups, inviting friends and crash recovery into buttons on a screen. Install it on the PC that hosts the server, then manage from any phone, tablet or computer through a web page — even restart the server with one tap while you are out.',
    ctaDownload: 'Download free',
    ctaLearn: 'See what it does',
    chips: [
      { strong: 'No install', tail: ' — download and run' },
      { lead: 'Local access ', strong: 'password-free' },
      { lead: 'Manage from ', strong: 'phone or tablet' },
      { plain: 'EN / 中文 / 日本語 · 3 themes × light/dark' },
    ],
    shotAlt: 'palserver GUI server overview: status, players and performance at a glance',
    shotLabel: 'palserver GUI',
  },
  stats: { labels: ['commands to memorize', 'management tabs, all in one', 'interface languages', 'open source · non-commercial'], free: 'Free' },
  why: {
    eyebrow: 'Why you need it',
    h2: 'Running a dedicated server should not be a nightmare.',
    lead: 'Endless config files, commands to memorize, friends stuck at "can\'t connect", a game update that corrupts your save, a 3 a.m. crash with nobody to fix it — none of this is "set it and forget it". palserver GUI folds every one of these into a clean interface: simple enough for beginners, powerful enough for veterans.',
  },
  how: {
    eyebrow: 'Understand it in a minute',
    h2: 'Open a web page, manage from anywhere.',
    lead: 'Install palserver GUI on the PC that hosts your server. From then on the management screen is just a web page — on your computer, phone or tablet. The game and saves stay on your own PC; the web page is only a remote control — walk right in at home, or tap a link to connect from anywhere.',
    deviceTitle: 'Your device',
    deviceDesc: 'Computer, phone, tablet. Open the web page and you are in — walk in at home, tap a link on the go.',
    midLine1: 'Secure connection',
    midLine2: 'connect in one tap',
    serverTitle: 'The host PC',
    serverDesc: 'palserver GUI looks after the server here: saves, mods and backups, all taken care of.',
  },
  features: {
    eyebrow: 'Feature tour',
    h2: 'From hosting to firefighting, all on one page.',
    lead: 'Every server opens into a full panel: overview, performance, players, map, commands, world settings, engine tuning, mods, pal stats (sponsor), backups, auto-restart, logs — 13 tabs at once, and you can hide any tab you don\'t need.',
    items: [
      {
        title: 'Every server, at a glance',
        bodyPre: 'Status, vanilla/modded, game port and update hints all sit on the card — click in for full management.',
        bullets: ['Drag to reorder server cards', 'Tabs can be shown or hidden per server, and the overview card can be turned off too'],
        alt: 'palserver GUI server list',
        label: 'Server list',
      },
      {
        title: 'Settings & engine tuning, in plain words',
        bodyPre: 'World rules, XP rates, drops and PvP all come with labels and hints; the ',
        bodyEmph: 'engine parameters',
        bodyPost: ' power users want are preset too — apply in one click.',
        bullets: [
          'Each option tells you what higher or lower does',
          'Saving keeps the keys you added by hand',
          'Launch options panel: set your own Steam query port and PalDefender REST port, with a check for conflicts',
          'Edit the login MOTD announcement right from the settings page',
        ],
        alt: 'Engine tuning and performance presets',
        label: 'Engine tuning',
      },
      {
        title: 'Anti-cheat and mods, one-click',
        bodyPre: 'Install, update and remove anti-cheat and the mod loader in one click, with a reminder that "mods may break for a while after a game update". Toggle mods right on screen.',
        alt: 'Mod install and management',
        label: 'Mods',
      },
      {
        title: 'Live performance, trends at a glance',
        bodyPre: 'CPU, memory and uptime plus a server smoothness metric, with a live trend chart. When it starts to struggle, you are the first to know.',
        alt: 'Performance analysis with live trends',
        label: 'Performance',
      },
      {
        title: '80+ world settings, no file editing',
        bodyPre: 'Difficulty, resources, breeding, bases, damage multipliers — all organized into categorized, annotated forms, with a restart reminder when you save. It even detects corrupt saves and rebuilds them in one click.',
        bullets: ['Pal and item data updated to Palworld 1.0 (Feybreak)', 'Active skill and trait names in Chinese and Japanese too'],
        alt: 'World settings editor',
        label: 'World settings',
      },
      {
        title: 'Switch devices, invite friends, one page',
        bodyPre: 'The settings page prepares a "one-tap login link" — copy it to your phone or another PC and just open it; you can also clear the browser cache and reconnect in one click.',
        alt: 'Settings page and multi-device access',
        label: 'Connect on another device',
      },
    ],
  },
  highlights: {
    eyebrow: 'New in v2.0.1',
    h2: 'Map, themes, sponsor perks — the three big additions this round.',
    items: [
      {
        tag: 'World map',
        title: 'The whole Palworld map, laid out',
        body: 'The full map — Palpagos Islands + Sakurajima + Feybreak — ships built in, no more bringing your own base image. Live player pins, last-known spots for offline players, guild bases, a wild-boss (alpha pal) layer and landmarks are all plotted, with a fullscreen view (/map); any command that needs coordinates lets you just click the map and drop a pin instead of typing numbers.',
      },
      {
        tag: 'Theme system',
        title: 'Three themes, light and dark both covered',
        body: 'Palworld classic, Silver (Vercel-style) and Aurora Emerald — each with a light and dark mode — switchable from a theme picker with a live mini preview. Silver and Aurora Emerald are sponsor-exclusive themes.',
      },
      {
        tag: 'Sponsor early access',
        title: 'Get it first, everyone gets it later',
        body: 'A pal stat editor (HP/attack/defense/capture rate, bosses adjustable separately), teleport a player, bulk-give items, custom pals and guild-base detail views — unlocked early for active sponsors, opened to everyone once the sponsorship period ends.',
      },
    ],
  },
  audience: {
    eyebrow: 'Right for both kinds of people',
    h2: 'Simple for beginners, powerful for veterans.',
    beginnerTag: 'For beginners',
    beginnerTitle: 'Hosting for the first time',
    powerTag: 'For power users',
    powerTitle: 'The control veterans want',
    beginner: [
      { head: 'One-click hosting.', body: 'Create, start and update all with buttons — no commands, no config files.' },
      { head: 'Password-free at home.', body: 'Open it on your own PC and the management screen is right there — zero setup.' },
      { head: 'Inviting friends is effortless.', body: 'Send one setup link and your friend is connected with a single tap.' },
      { head: 'Cute and intuitive.', body: 'A localized interface with hints — adjust everything with a few clicks.' },
    ],
    power: [
      { head: 'Native / Docker backends.', body: 'Run PalServer directly or in a container; adopt an existing install or install into an empty folder. Docker also accepts a custom image, and the k8s backend is always selectable.' },
      { head: 'Schema-driven settings.', body: '80+ world settings + Engine.ini tuning, type-consistent, keeping keys it does not manage.' },
      { head: 'RCON console + mods.', body: 'Built-in RCON; one-click install/update/remove of PalDefender / UE4SS, with a configurable PalDefender REST port.' },
      { head: 'Backup scheduling & migration.', body: 'Scheduled tar.gz backups, one-click restore, cross-source save migration, REST API proxy.' },
    ],
  },
  wishes: {
    eyebrow: 'Grown up alongside the community',
    h2: 'You wished for it — we built it.',
    lead: 'palserver GUI started as a little "too lazy to edit config files" tool. Over two years, the community\'s requests got ticked off one by one.',
    items: [
      { q: 'Can I import my existing save?', head: 'Save migration', body: ' — adopt saves from another dedicated server, the old v1, or a local 4-player invite-code world.' },
      { q: 'I\'m scared of corrupting my save…', head: 'Scheduled backups + one-click restore', body: ', and it even detects corrupt saves and helps rebuild them.' },
      { q: 'I want to run a modded server', head: 'One-click anti-cheat and mods', body: ': install, update, remove, and toggle mods right on screen.' },
      { q: 'Can I tweak death drops and hatch time too?', head: '80+ world settings, visualized', body: ', categorized and annotated — no more editing config files.' },
      { q: 'My friends can\'t connect, latency is too high', head: 'One-click VPN invites', body: ', or choose our direct-IP setup service.' },
      { q: 'I hate typing a long command to update every time', head: 'Version check + one-click update', body: ', zero commands.' },
      { q: 'I run several servers on one PC and they keep failing to start', head: 'Query-port conflicts avoided automatically', body: ' — the Steam query port no longer clashes when hosting multiple servers; set it per server.' },
      { q: 'Leaking player IDs makes me uneasy', head: 'Site-wide SteamID masking', body: ' — rosters, logs, the player picker and command output all show a masked ID; reveal or copy it only when you choose to.' },
    ],
  },
  getStarted: {
    eyebrow: 'Start in three steps',
    h2: 'Download, run, open your browser.',
    lead: 'No environment to install first, no command line. The no-install executable bundles everything it needs.',
    steps: [
      { title: 'Download', body: 'Grab the file for your system from the download page and unzip it.' },
      { title: 'Double-click to run', body: 'The window shows your management URL and the link to invite friends — just leave it open.' },
      { title: 'Open your browser', body: 'Click the management URL in the window, go in, and start your first server.' },
    ],
    shotAlt: 'palserver GUI first-connection and pairing screen',
    shotLabel: 'First connection',
    figcaption: 'Switching devices or setting up for a friend? Send the setup link, one tap connects — no long password to type by hand.',
  },
  niceDetails: {
    eyebrow: 'Thoughtful for the detail-minded',
    h2: 'We even thought out the "welcome message" for you.',
    lead: 'A built-in announcement system, corrupt-save detection with one-click rebuild, auto-restart (scheduled / memory threshold / crash recovery), site-wide player-ID masking, a full world map (Palpagos Islands + Sakurajima + Feybreak, with a fullscreen view), three themes × light/dark, three interface languages — plenty of little touches you\'ll thank us for later.',
    shotAlt: 'palserver GUI built-in announcement system',
    shotLabel: 'Announcements',
  },
  team: {
    eyebrow: 'Who made it',
    h2: 'A group of Palworld fans, maintaining it with love.',
    lead: 'palserver GUI is completely free and open source, maintained by a core team. If you like it, a cup of coffee is the best encouragement.',
    roles: ['Core developer', 'Core developer', 'Core maintainer', 'Core maintainer', 'Core maintainer · Security', 'Core maintainer'],
  },
  closing: {
    eyebrow: 'Get started',
    h2: 'Leave the hassle of hosting to palserver GUI.',
    lead: 'Completely free and open source. If you like it, star us on GitHub and come chat on Discord.',
    ctaDownload: 'Download free',
    notePre: "Don't want to look after it yourself? We also offer a ",
    noteLink: 'managed game-server maintenance service',
    notePost: ' — version updates, backups and crash recovery, handled by us.',
  },
  footer: {
    madePre: 'Made with love by ',
    madeMid: ' and the core team · ',
    license: 'palserver GUI 2.0 · Open source & free · Non-commercial use only (PolyForm Noncommercial); not for profit',
  },
  langLabel: 'Language',
};

const ja: Dictionary = {
  meta: {
    title: 'palserver GUI — Palworld 専用サーバー管理、ワンクリック・コマンド不要',
    description:
      'palserver GUI は無料・オープンソースの Palworld 専用サーバー管理ツールです。ワンクリックでサーバー起動、内蔵ワールドマップ、3 テーマ、80 以上のワールド設定、MOD 管理、自動バックアップ、スマホからの遠隔管理。コマンド不要・設定ファイル不要、インストール不要でダウンロードしてすぐ使えます。',
    ogAlt: 'palserver GUI サーバー管理の概要画面',
  },
  nav: { features: '機能', how: '仕組み', start: '使い方', team: 'チーム', github: 'GitHub', download: 'ダウンロード' },
  hero: {
    eyebrow: 'オープンソース · 無料 · Palworld 専用サーバー管理',
    h1Emph: 'ワンクリック',
    h1Rest: 'で Palworld サーバーを起動。',
    h1Line2: 'コマンド不要、設定ファイル不要。',
    sub: 'palserver GUI は、サーバー起動・設定変更・バックアップ・フレンド招待・クラッシュ復旧を、すべて画面上のボタンにまとめます。サーバーを置く PC に入れておけば、スマホ・タブレット・PC からブラウザで管理でき、外出先からでもワンタップでサーバーを再起動できます。',
    ctaDownload: '無料ダウンロード',
    ctaLearn: 'できることを見る',
    chips: [
      { strong: 'インストール不要', tail: ' ダウンロードしてすぐ' },
      { lead: 'ローカル管理は ', strong: 'パスワード不要' },
      { lead: 'スマホ・タブレット ', strong: 'でも管理' },
      { plain: '日本語 / 中文 / EN · 3 テーマ×ライト/ダーク' },
    ],
    shotAlt: 'palserver GUI サーバー概要画面:状態・プレイヤー・パフォーマンスが一目瞭然',
    shotLabel: 'palserver GUI',
  },
  stats: { labels: ['覚えるコマンド数', '管理タブ、1 ページに集約', 'インターフェース言語', 'オープンソース · 非商用'], free: '無料' },
  why: {
    eyebrow: 'なぜ必要か',
    h2: '専用サーバーの運用は、悪夢であるべきではない。',
    lead: '終わらない設定ファイル、覚えきれないコマンド、「接続できない」で止まるフレンド、アップデートで壊れるセーブ、深夜のクラッシュを直す人がいない……どれも「立てれば終わり」ではありません。palserver GUI はそのすべてを、きれいな画面にまとめます。初心者には簡単に、上級者には十分に。',
  },
  how: {
    eyebrow: '1 分でわかる',
    h2: 'ブラウザを開けば、どこにいても管理できる。',
    lead: 'palserver GUI をサーバー用の PC に入れておけば、以降は PC・スマホ・タブレットのどれでも、ブラウザを開くだけで管理画面になります。ゲームとセーブはあなたの PC に残り、ブラウザはリモコンにすぎません。自宅ではそのまま、外ではリンクをタップして接続します。',
    deviceTitle: 'あなたの端末',
    deviceDesc: 'PC・スマホ・タブレット。ブラウザを開けば管理画面。自宅ではそのまま、外ではリンクをタップ。',
    midLine1: '安全な接続',
    midLine2: 'ワンタップで接続',
    serverTitle: 'サーバー用の PC',
    serverDesc: 'palserver GUI がここでサーバーを見守ります。セーブ・MOD・バックアップまで、すべてお任せ。',
  },
  features: {
    eyebrow: '機能ツアー',
    h2: 'サーバー起動から火消しまで、1 ページで完結。',
    lead: 'どのサーバーも開けばフルパネル:概要・パフォーマンス・プレイヤー・マップ・コマンド・ワールド設定・エンジン調整・MOD・パルステータス(スポンサー版)・バックアップ・自動再起動・ログ——13 タブを一度に展開、不要なタブは非表示にできます。',
    items: [
      {
        title: 'すべてのサーバーを一目で',
        bodyPre: '状態・バニラ/MOD・ゲームポート・更新通知はすべてカード上に。クリックすればそのままフル管理へ。',
        bullets: ['サーバーカードはドラッグで並び替え可能', 'タブはサーバーごとに表示 / 非表示を設定でき、概要カードも非表示にできます'],
        alt: 'palserver GUI サーバー一覧',
        label: 'サーバー一覧',
      },
      {
        title: '設定とエンジン調整を、やさしい言葉で',
        bodyPre: 'ワールドルール、経験値倍率、ドロップ、PvP にすべてラベルとヒント付き。上級者が触りたい',
        bodyEmph: 'エンジン設定',
        bodyPost: 'もプリセットを用意、ワンクリックで適用。',
        bullets: [
          '各項目が「上げ下げでどうなるか」を説明',
          '保存しても手動で足したキーは残す',
          '起動オプションパネル:Steam クエリポートと PalDefender REST ポートを自分で設定でき、重複もチェック',
          'ログイン時の MOTD お知らせも設定ページで編集可能',
        ],
        alt: 'エンジン調整とパフォーマンスプリセット',
        label: 'エンジン調整',
      },
      {
        title: 'アンチチートと MOD をワンクリック管理',
        bodyPre: 'アンチチートと MOD ローダーをワンクリックで導入・更新・削除。「アップデート後は MOD が一時的に使えないことがある」と通知も。MOD は画面上で直接オン・オフ。',
        alt: 'MOD の導入と管理',
        label: 'MOD 管理',
      },
      {
        title: 'リアルタイム性能、推移が一目瞭然',
        bodyPre: 'CPU・メモリ・稼働時間に加えサーバーの快適さ指標を、リアルタイムの推移グラフで表示。苦しくなったとき、まっさきに気づけます。',
        alt: 'パフォーマンス分析とリアルタイム推移',
        label: 'パフォーマンス',
      },
      {
        title: '80 以上のワールド設定、ファイルを開かず',
        bodyPre: '難易度・資源・繁殖・拠点・ダメージ倍率……すべてを分類・説明付きのフォームに整理。保存すると再起動が必要と通知。セーブ破損も検出し、ワンクリックで再構築します。',
        bullets: ['パルとアイテムのデータを Palworld 1.0(フェイブレイク)に更新', 'アクティブスキル / 特性名も中国語・日本語表記に対応'],
        alt: 'ワールド設定エディター',
        label: 'ワールド設定',
      },
      {
        title: '端末の切り替えもフレンド招待も、1 ページで',
        bodyPre: '設定ページが「ワンタップ・ログインリンク」を用意。スマホや別の PC にコピーして開くだけ。ブラウザのキャッシュを消して再接続もワンクリック。',
        alt: '設定ページとマルチデバイス接続',
        label: '別の端末で接続',
      },
    ],
  },
  highlights: {
    eyebrow: 'v2.0.1 の新機能',
    h2: 'マップ・テーマ・スポンサー特典——今回の 3 大追加。',
    items: [
      {
        tag: 'ワールドマップ',
        title: 'パルワールドの全地図を丸ごと',
        body: 'パルパゴス諸島 + 桜島 + フェイブレイクの全地図を内蔵、自分でベース画像を用意する必要はもうありません。オンラインプレイヤーの位置、オフラインプレイヤーの最終位置、ギルド拠点、野生ボス(アルファパル)レイヤー、ランドマークを表示、全画面表示(/map)にも対応。座標が必要なコマンドは、数値を打つ代わりに地図をクリックしてピンを置くだけ。',
      },
      {
        tag: 'テーマシステム',
        title: '3 テーマ、ライトもダークも',
        body: 'パルワールド標準・シルバー(Vercel 風)・オーロラエメラルドの 3 テーマ、それぞれライト / ダーク対応。ミニプレビュー付きのテーマ切り替えダイアログから選択できます。シルバーとオーロラエメラルドはスポンサー限定テーマ。',
      },
      {
        tag: 'スポンサー先行機能',
        title: '先に使えて、期限後は誰でも',
        body: 'パルのステータス編集(HP・攻撃・防御・捕獲率、ボスは個別調整可)、プレイヤーのテレポート、アイテムの一括付与、カスタムパルやギルド拠点の詳細表示——有効なスポンサーに先行解放し、スポンサー期間が終了すると全員に公開されます。',
      },
    ],
  },
  audience: {
    eyebrow: 'どちらのタイプにも',
    h2: '初心者には簡単に、上級者には十分に。',
    beginnerTag: 'For beginners',
    beginnerTitle: '初めてのサーバー運用',
    powerTag: 'For power users',
    powerTitle: '上級者が求める操作性',
    beginner: [
      { head: 'ワンクリックで起動。', body: '作成・起動・更新はすべてボタンで。コマンドも設定ファイルも不要。' },
      { head: 'ローカルはパスワード不要。', body: '自分の PC で開けばそのまま管理画面。設定ゼロ。' },
      { head: 'フレンド招待も手間なし。', body: 'セットアップリンクを 1 本送るだけ。相手はワンタップで接続。' },
      { head: 'かわいくて直感的。', body: 'ローカライズされた UI と説明付き。クリックだけで調整できます。' },
    ],
    power: [
      { head: 'ネイティブ / Docker の両対応。', body: 'PalServer を直接、またはコンテナで。既存インストールの引き継ぎや空フォルダへの導入も。Docker はカスタムイメージにも対応、k8s バックエンドも常に選択可能。' },
      { head: 'スキーマ駆動の設定。', body: '80 以上のワールド設定 + Engine.ini 調整。型が一貫し、管理外のキーも保持。' },
      { head: 'RCON コンソール + MOD。', body: 'RCON 内蔵。PalDefender / UE4SS をワンクリックで導入・更新・削除、PalDefender の REST ポートも変更可能。' },
      { head: 'バックアップのスケジュールと移行。', body: 'tar.gz の定期バックアップ、ワンクリック復元、ソース間のセーブ移行、REST API プロキシ。' },
    ],
  },
  wishes: {
    eyebrow: 'コミュニティと共に成長',
    h2: 'あなたの願い、ぜんぶ叶えました。',
    lead: 'palserver GUI は「設定ファイルをいじるのが面倒」という小さなツールから始まりました。この 2 年、コミュニティの要望を一つずつ実装してきました。',
    items: [
      { q: '既存のセーブを取り込める?', head: 'セーブ移行', body: '——他の専用サーバー、旧 v1、ローカル 4 人の招待コード・ワールドも引き継げます。' },
      { q: 'セーブが壊れるのが怖い…', head: '定期バックアップ + ワンクリック復元', body: '。セーブ破損の検出と再構築の支援も。' },
      { q: 'MOD サーバーを立てたい', head: 'アンチチートと MOD をワンクリック', body: 'で導入・更新・削除。MOD は画面上で直接オン・オフ。' },
      { q: '死亡ドロップや孵化時間も変えられる?', head: '80 以上のワールド設定を可視化', body: '。分類・説明付きで、設定ファイルを開く必要はもうありません。' },
      { q: 'フレンドが遅延で接続できない', head: 'VPN ワンクリック招待', body: '。あるいは当社の IP 直結セットアップサービスを。' },
      { q: '毎回長いコマンドで更新したくない', head: 'バージョン確認 + ワンクリック更新', body: '。コマンドはゼロ。' },
      { q: '1 台の PC で複数サーバーを立てると起動できないことがある', head: 'クエリポートの衝突を自動回避', body: '——同一 PC での複数起動時、Steam クエリポートが衝突しなくなりました。サーバーごとに個別設定できます。' },
      { q: 'プレイヤー ID が漏れるのが心配', head: 'SteamID を全面マスク', body: '——名簿・ログ・プレイヤー選択・コマンド出力はすべて中間表記。表示やコピーはクリックしたときだけ。' },
    ],
  },
  getStarted: {
    eyebrow: '3 ステップで開始',
    h2: 'ダウンロード、実行、ブラウザを開く。',
    lead: '先に何かをインストールする必要も、コマンドラインも不要。インストール不要の実行ファイルが必要なものをすべて同梱しています。',
    steps: [
      { title: 'ダウンロード', body: 'ダウンロードページでお使いのシステム用ファイルを取得し、解凍します。' },
      { title: 'ダブルクリックで実行', body: 'ウィンドウに管理用 URL とフレンド招待リンクが表示されます。開いたままにしておけば OK。' },
      { title: 'ブラウザを開く', body: 'ウィンドウ内の管理用 URL をクリックして画面に入り、最初のサーバーを立ち上げます。' },
    ],
    shotAlt: 'palserver GUI 初回接続とペアリング画面',
    shotLabel: '初回接続',
    figcaption: '端末を替える、フレンドの設定を手伝う?セットアップリンクを送ればワンタップで接続——長いパスワードを手入力する必要はありません。',
  },
  niceDetails: {
    eyebrow: '細部までの心配り',
    h2: '「あいさつ文」まで用意しました。',
    lead: 'お知らせ機能、セーブ破損の検出とワンクリック再構築、自動再起動(スケジュール / メモリ閾値 / クラッシュ復旧)、サイト全体でのプレイヤー ID マスク、完全なワールドマップ(パルパゴス諸島 + 桜島 + フェイブレイク、全画面表示対応)、3 テーマ×ライト/ダーク、3 言語 UI——後から感謝したくなる小さな配慮がたくさん。',
    shotAlt: 'palserver GUI 内蔵のお知らせ機能',
    shotLabel: 'お知らせ',
  },
  team: {
    eyebrow: '作った人たち',
    h2: 'Palworld 好きが集まって、愛を込めて運営。',
    lead: 'palserver GUI は完全無料・オープンソースで、コアチームが継続的に運営しています。気に入ったら、コーヒー 1 杯が最高の励みになります。',
    roles: ['コア開発者', 'コア開発者', 'コアメンテナー', 'コアメンテナー', 'コアメンテナー・セキュリティ', 'コアメンテナー'],
  },
  closing: {
    eyebrow: 'はじめよう',
    h2: 'サーバー運用の面倒は、palserver GUI に任せて。',
    lead: '完全無料・オープンソース。気に入ったら GitHub でスターを、Discord で気軽にお話ししましょう。',
    ctaDownload: '無料ダウンロード',
    notePre: '自分で見るのは大変?当社は ',
    noteLink: 'ゲームサーバー運用代行サービス',
    notePost: ' も提供しています——バージョン更新・バックアップ・クラッシュ復旧はお任せください。',
  },
  footer: {
    madePre: '制作:',
    madeMid: ' とコアチームが愛を込めて · ',
    license: 'palserver GUI 2.0 · オープンソース・無料 · 非商用限定(PolyForm Noncommercial)、営利利用は不可',
  },
  langLabel: '言語',
};

const dictionaries: Record<Locale, Dictionary> = { zh, en, ja };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
