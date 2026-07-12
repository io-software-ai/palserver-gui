/**
 * RCON command catalog.
 *
 * `builtin` — the dedicated server's own console commands
 *   (docs.palworldgame.com/settings-and-operation/commands)
 * `paldefender` — added by the PalDefender plugin, RCON-capable subset only
 *   (ultimeit.github.io/PalDefender/Commands/); chat-only commands such as
 *   /giveme or /godmode are deliberately omitted since RCON can't run them.
 *
 * When PalDefender is installed the agent asks the server for its real list
 * via /getrconcmds and filters this catalog by it, so a plugin update that
 * adds or drops a command doesn't strand the UI.
 */

export type CommandSource = "builtin" | "paldefender";

export type CommandCategory =
  | "server"
  | "players"
  | "moderation"
  | "items"
  | "pals"
  | "tech"
  | "bases"
  | "world";

export interface CommandArg {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** 用玩家選單渲染此參數(可挑線上/曾見過的玩家,也可自由輸入 UserId / 座標)。
   *  讓一個指令能有多個玩家參數(name 各異),例如 tp 的來源玩家 + 目標玩家。 */
  player?: boolean;
}

export interface CommandSpec {
  name: string;
  source: CommandSource;
  category: CommandCategory;
  label: string;
  args: CommandArg[];
  /** Destructive or irreversible — the UI confirms before running. */
  dangerous?: boolean;
}

const userId = (label = "玩家 UserId"): CommandArg => ({
  name: "userid",
  label,
  required: true,
  placeholder: "steam_7656119…",
});

export const COMMANDS: CommandSpec[] = [
  // ── built-in ─────────────────────────────────────────────────────────
  { name: "Info", source: "builtin", category: "server", label: "顯示伺服器資訊", args: [] },
  { name: "ShowPlayers", source: "builtin", category: "players", label: "列出所有在線玩家", args: [] },
  { name: "Save", source: "builtin", category: "server", label: "儲存世界資料", args: [] },
  {
    name: "Broadcast",
    source: "builtin",
    category: "server",
    label: "廣播訊息(內建指令不支援空白字元)",
    args: [{ name: "message", label: "訊息", required: true, placeholder: "Hello_everyone" }],
  },
  {
    name: "Shutdown",
    source: "builtin",
    category: "server",
    label: "倒數後關閉伺服器",
    dangerous: true,
    args: [
      { name: "seconds", label: "延遲秒數", required: true, placeholder: "60" },
      { name: "message", label: "通知訊息", required: false, placeholder: "Server_restarting" },
    ],
  },
  { name: "DoExit", source: "builtin", category: "server", label: "立即強制停止伺服器", args: [], dangerous: true },
  { name: "KickPlayer", source: "builtin", category: "moderation", label: "踢出玩家", args: [userId()] },
  { name: "BanPlayer", source: "builtin", category: "moderation", label: "封鎖玩家", args: [userId()], dangerous: true },
  { name: "UnBanPlayer", source: "builtin", category: "moderation", label: "解除封鎖", args: [userId()] },
  // 官方 TeleportToPlayer / TeleportToMe 需要「遊戲內執行者(admin 角色)」,純 RCON
  // 沒有這個角色,套用無效(同 giveme/godmode 被省略的理由)。玩家間傳送改用
  // PalDefender 的 tp(第一參數就是來源玩家,不依賴執行者)。

  // ── PalDefender ──────────────────────────────────────────────────────
  { name: "version", source: "paldefender", category: "server", label: "顯示遊戲與 PalDefender 版本", args: [] },
  { name: "reloadcfg", source: "paldefender", category: "server", label: "重新載入設定與封鎖名單", args: [] },
  {
    name: "pgbroadcast",
    source: "paldefender",
    category: "server",
    label: "廣播訊息(支援空白字元)",
    args: [{ name: "message", label: "訊息", required: true, placeholder: "伺服器將在 5 分鐘後重啟" }],
  },
  {
    name: "alert",
    source: "paldefender",
    category: "server",
    label: "發送醒目警示訊息",
    args: [{ name: "message", label: "訊息", required: true }],
  },
  {
    name: "setadmin",
    source: "paldefender",
    category: "moderation",
    label: "授予/取消管理員權限",
    args: [userId()],
  },
  {
    name: "addadminip",
    source: "paldefender",
    category: "moderation",
    label: "將 IP 加入管理員白名單",
    args: [{ name: "ip", label: "IP 位址", required: true, placeholder: "100.64.0.1" }],
  },
  { name: "getpos", source: "paldefender", category: "players", label: "查詢玩家座標", args: [{ ...userId(), required: false }] },
  { name: "getip", source: "paldefender", category: "moderation", label: "查詢玩家 IP", args: [userId()] },
  {
    name: "kick",
    source: "paldefender",
    category: "moderation",
    label: "踢出玩家(可附原因)",
    args: [userId(), { name: "reason", label: "原因", required: false }],
  },
  {
    name: "ban",
    source: "paldefender",
    category: "moderation",
    label: "封鎖玩家(可附原因)",
    dangerous: true,
    args: [userId(), { name: "reason", label: "原因", required: false }],
  },
  {
    name: "ipban",
    source: "paldefender",
    category: "moderation",
    label: "IP 封鎖玩家",
    dangerous: true,
    args: [userId(), { name: "reason", label: "原因", required: false }],
  },
  {
    name: "unban",
    source: "paldefender",
    category: "moderation",
    label: "解除封鎖 UserId",
    args: [userId()],
  },
  {
    name: "banip",
    source: "paldefender",
    category: "moderation",
    label: "封鎖 IP",
    dangerous: true,
    args: [{ name: "ip", label: "IP 位址", required: true }],
  },
  { name: "unbanip", source: "paldefender", category: "moderation", label: "解除 IP 封鎖", args: [{ name: "ip", label: "IP 位址", required: true }] },
  { name: "whitelist_add", source: "paldefender", category: "moderation", label: "加入白名單", args: [userId()] },
  { name: "whitelist_remove", source: "paldefender", category: "moderation", label: "移出白名單", args: [userId()] },
  { name: "whitelist_get", source: "paldefender", category: "moderation", label: "列出白名單", args: [] },
  {
    name: "renameplayer",
    source: "paldefender",
    category: "players",
    label: "重新命名玩家",
    args: [userId(), { name: "name", label: "新暱稱", required: true }],
  },
  {
    name: "settime",
    source: "paldefender",
    category: "world",
    label: "設定世界時間",
    args: [{ name: "hour", label: "時間", required: true, placeholder: "0-23 / day / night" }],
  },
  {
    // PalDefender tp:第一參數=來源玩家,第二=目標玩家或座標(x y z)。
    //   tp <來源> <目標玩家>      → 把來源玩家傳到目標玩家所在
    //   tp <來源> <x> <y> <z>     → 把來源玩家傳到座標(空白分隔,直接打進目標欄)
    name: "tp",
    source: "paldefender",
    category: "players",
    label: "傳送玩家到玩家 / 座標",
    args: [
      { name: "source", label: "要傳送的玩家", required: true, player: true },
      {
        name: "target",
        label: "目標玩家 / 座標",
        required: true,
        player: true,
        placeholder: "選玩家,或輸入座標 x y z(如 100 50 200)",
      },
    ],
  },
  {
    name: "give_exp",
    source: "paldefender",
    category: "players",
    label: "給予經驗值",
    args: [userId(), { name: "amount", label: "數量", required: true, placeholder: "1000" }],
  },
  {
    name: "givestats",
    source: "paldefender",
    category: "players",
    label: "給予狀態點數",
    args: [userId(), { name: "count", label: "點數", required: false, placeholder: "1" }],
  },
  {
    name: "give",
    source: "paldefender",
    category: "items",
    label: "給予道具",
    args: [
      userId(),
      { name: "itemid", label: "道具 ID", required: true, placeholder: "Wood" },
      { name: "amount", label: "數量", required: false, placeholder: "1" },
    ],
  },
  {
    name: "delitem",
    source: "paldefender",
    category: "items",
    label: "移除道具",
    args: [
      userId(),
      { name: "itemid", label: "道具 ID", required: true },
      { name: "amount", label: "數量", required: false, placeholder: "1" },
    ],
  },
  {
    name: "clearinv",
    source: "paldefender",
    category: "items",
    label: "清空玩家背包",
    dangerous: true,
    args: [userId(), { name: "container", label: "容器(選填)", required: false }],
  },
  {
    name: "give_relic",
    source: "paldefender",
    category: "items",
    label: "給予靈魂雕像",
    args: [userId(), { name: "amount", label: "數量", required: true, placeholder: "1" }],
  },
  {
    name: "givepal",
    source: "paldefender",
    category: "pals",
    label: "給予帕魯",
    args: [
      userId(),
      { name: "palid", label: "帕魯 ID", required: true, placeholder: "Lamball" },
      { name: "level", label: "等級", required: false, placeholder: "1" },
    ],
  },
  {
    name: "spawnpal",
    source: "paldefender",
    category: "pals",
    label: "生成野生帕魯",
    args: [
      { name: "palid", label: "帕魯 ID", required: true },
      { name: "coords", label: "座標與等級(選填)", required: false, placeholder: "x y z level" },
    ],
  },
  {
    name: "giveegg",
    source: "paldefender",
    category: "pals",
    label: "給予帕魯蛋",
    args: [
      userId(),
      { name: "eggid", label: "蛋 ID", required: true },
      { name: "palid", label: "帕魯 ID", required: true },
      { name: "level", label: "等級", required: false },
    ],
  },
  { name: "exportpals", source: "paldefender", category: "pals", label: "匯出玩家的帕魯", args: [{ ...userId(), required: false }] },
  {
    name: "deletepals",
    source: "paldefender",
    category: "pals",
    label: "依條件刪除帕魯",
    dangerous: true,
    args: [userId(), { name: "filter", label: "篩選條件", required: true }],
  },
  {
    name: "learntech",
    source: "paldefender",
    category: "tech",
    label: "解鎖科技(all = 全部)",
    args: [userId(), { name: "techid", label: "科技 ID", required: true, placeholder: "all" }],
  },
  {
    name: "unlearntech",
    source: "paldefender",
    category: "tech",
    label: "鎖回科技(all = 全部)",
    args: [userId(), { name: "techid", label: "科技 ID", required: true, placeholder: "all" }],
  },
  {
    name: "givetechpoints",
    source: "paldefender",
    category: "tech",
    label: "給予科技點數",
    args: [userId(), { name: "amount", label: "數量", required: false, placeholder: "1" }],
  },
  {
    name: "givebosstechpoints",
    source: "paldefender",
    category: "tech",
    label: "給予古代科技點數",
    args: [userId(), { name: "amount", label: "數量", required: false, placeholder: "1" }],
  },
  { name: "gettechids", source: "paldefender", category: "tech", label: "列出所有科技 ID", args: [] },
  { name: "getskinids", source: "paldefender", category: "pals", label: "列出所有帕魯造型 ID", args: [] },
  {
    name: "getnearestbase",
    source: "paldefender",
    category: "bases",
    label: "查詢最近的據點擁有者",
    args: [{ name: "coords", label: "座標(選填)", required: false, placeholder: "x y z" }],
  },
  {
    name: "killnearestbase",
    source: "paldefender",
    category: "bases",
    label: "摧毀最近的據點",
    dangerous: true,
    args: [{ name: "coords", label: "座標(選填)", required: false, placeholder: "x y z" }],
  },
  {
    name: "setguildleader",
    source: "paldefender",
    category: "bases",
    label: "指定公會會長",
    args: [userId()],
  },
  { name: "exportguilds", source: "paldefender", category: "bases", label: "匯出所有公會為 JSON", args: [] },
];

export const COMMAND_CATEGORY_LABELS: Record<CommandCategory, string> = {
  server: "伺服器",
  players: "玩家",
  moderation: "管理與封鎖",
  items: "道具",
  pals: "帕魯",
  tech: "科技",
  bases: "據點與公會",
  world: "世界",
};

/** Build the wire command string, quoting nothing — Palworld's parser is
 * whitespace-separated and does not understand quotes. */
export function buildCommand(spec: CommandSpec, values: Record<string, string>): string {
  const parts = [spec.name];
  for (const arg of spec.args) {
    const value = values[arg.name]?.trim();
    if (value) parts.push(value);
  }
  return parts.join(" ");
}

export interface RconCommandsResponse {
  /** false when RCON is off / no admin password (with `reason`). */
  available: boolean;
  reason?: string;
  paldefender: boolean;
  commands: CommandSpec[];
}
