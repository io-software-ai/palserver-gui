import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  PdPal,
  PdItemSlot,
  PdGuild,
  PdGuildList,
  PdPlayerList,
  PdPlayerSummary,
  PdRestStatus,
  PlayerDetail,
  PlayerProgression,
  PlayerTechs,
} from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";
import { rconExec } from "./rcon.js";

/**
 * Proxy to PalDefender's own REST API (v1/pdapi on port 17993), which exposes
 * per-player pals and inventory that the game's built-in REST API can't.
 *
 * Token handling: the agent manages its own bearer token file under
 * RESTAPI/Tokens/palserver-gui.json (a full-permission token, since it only
 * runs on localhost and is never exposed to the browser). If the file is
 * missing it's created and `reloadcfg` is issued so PalDefender picks it up.
 * As with everything else, the browser only ever talks to the agent.
 */

const TOKEN_FILE = "palserver-gui.json";

function pdDir(rec: InstanceRecord, ctx: DriverContext): string | null {
  const win64 = path.join(serverRoot(rec, ctx), "Pal", "Binaries", "Win64");
  for (const name of ["PalDefender", "palguard"]) {
    const dir = path.join(win64, name);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function restConfig(dir: string): { enabled: boolean; port: number } {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "RESTAPI", "RESTConfig.json"), "utf8"));
    return { enabled: cfg.Enabled === true, port: Number(cfg.Port) || 17993 };
  } catch {
    return { enabled: false, port: 17993 };
  }
}

/** Read our token, creating it (and reloading PalDefender) if absent. */
async function ensureToken(rec: InstanceRecord, dir: string): Promise<string> {
  const tokensDir = path.join(dir, "RESTAPI", "Tokens");
  const file = path.join(tokensDir, TOKEN_FILE);
  if (fs.existsSync(file)) {
    const token = JSON.parse(fs.readFileSync(file, "utf8")).Token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  fs.mkdirSync(tokensDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(
    file,
    JSON.stringify({ Name: "palserver GUI", Token: token, Permissions: ["REST.*"] }, null, 4),
  );
  // Tell PalDefender to reload so the new token is accepted without a restart.
  await rconExec(rec, "reloadcfg").catch(() => {});
  return token;
}

export function getPdRestStatus(rec: InstanceRecord, ctx: DriverContext): PdRestStatus {
  if (rec.backend !== "native") {
    return { installed: false, configExists: false, enabled: false, hasToken: false, reason: "玩家細節僅支援原生模式的實例" };
  }
  const dir = pdDir(rec, ctx);
  if (!dir) {
    return { installed: false, configExists: false, enabled: false, hasToken: false, reason: "尚未安裝 PalDefender" };
  }
  const configFile = path.join(dir, "RESTAPI", "RESTConfig.json");
  const configExists = fs.existsSync(configFile);
  if (!configExists) {
    return {
      installed: true, configExists: false, enabled: false, hasToken: false,
      reason: "PalDefender 尚未生成 REST 設定 — 啟動一次伺服器即會產生",
    };
  }
  const { enabled } = restConfig(dir);
  if (!enabled) {
    return {
      installed: true, configExists: true, enabled: false, hasToken: false,
      reason: "PalDefender REST API 未啟用 — 啟用後即可查看玩家的帕魯與背包",
    };
  }
  const hasToken = fs.existsSync(path.join(dir, "RESTAPI", "Tokens", TOKEN_FILE));
  return { installed: true, configExists: true, enabled: true, hasToken };
}

/** Set Enabled in RESTConfig.json (preserving the rest of the file). */
export function setPdRestEnabled(rec: InstanceRecord, ctx: DriverContext, enabled: boolean): void {
  const dir = pdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const file = path.join(dir, "RESTAPI", "RESTConfig.json");
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error("找不到 RESTConfig.json — 請先啟動一次伺服器"), { statusCode: 409 });
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw Object.assign(new Error("RESTConfig.json 格式損壞"), { statusCode: 409 });
  }
  cfg.Enabled = enabled;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 4));
}

/** Create the agent's bearer token file if missing (and reloadcfg). Returns
 * whether the token now exists. Lets the UI provision access without the raw
 * editor; regenerate=true rotates it. */
export async function provisionPdToken(
  rec: InstanceRecord,
  ctx: DriverContext,
  regenerate: boolean,
): Promise<boolean> {
  const dir = pdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const file = path.join(dir, "RESTAPI", "Tokens", TOKEN_FILE);
  if (regenerate) fs.rmSync(file, { force: true });
  await ensureToken(rec, dir);
  return fs.existsSync(file);
}

/** Map PalDefender's error codes to something a manager can act on. */
const PD_ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "存取權杖尚未生效 — 請重啟伺服器一次(或確認 RCON 已啟用,讓 agent 能自動載入權杖)",
  MISSING_PERMISSION: "存取權杖權限不足",
  // PalDefender 1.8.0 起 /player、/pals、/items 都支援離線玩家,所以查不到通常代表這個
  // 玩家從未加入過,或 PalDefender 版本過舊(1.8 之前只能查在線)。
  PLAYER_NOT_FOUND: "找不到這個玩家 —— 可能從未加入過此伺服器,或你的 PalDefender 版本過舊(需 1.8.0 以上才能查詢離線玩家,請更新 PalDefender)。",
  PLAYER_ACCOUNT_NOT_FOUND: "找到玩家但無法載入其存檔資料",
  REQUEST_TIMEOUT: "PalDefender 回應逾時,請稍後再試",
  REQUEST_FAILED: "PalDefender 處理請求時發生錯誤",
};

class PdRestError extends Error {}

async function pdFetch<T>(
  rec: InstanceRecord,
  dir: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const { port } = restConfig(dir);
  const token = await ensureToken(rec, dir);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/pdapi${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new PdRestError("無法連線到 PalDefender REST API — 伺服器可能未在運作中");
  }
  if (!res.ok) {
    // A PalDefender error body carries Error.Code; a bare 404 (no such body)
    // means the pdapi route itself is missing — likely this PalDefender
    // version predates the player-detail API, or the token isn't loaded yet.
    const body = await res.json().catch(() => null);
    const code = (body as { Error?: { Code?: string } })?.Error?.Code;
    if (code) throw new PdRestError(PD_ERROR_MESSAGES[code] ?? `PalDefender 回應錯誤(${code})`);
    if (res.status === 404) {
      throw new PdRestError(
        "PalDefender 沒有這個 API 端點 — 你的 PalDefender 版本可能尚未支援玩家細節,或設定/權杖變更後需要「重啟伺服器一次」讓它生效。",
      );
    }
    if (res.status === 401) throw new PdRestError(PD_ERROR_MESSAGES.INVALID_TOKEN);
    throw new PdRestError(`PalDefender 回應 HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function collectPals(pals: Record<string, unknown> | undefined, location: PdPal["location"]): PdPal[] {
  if (!pals || typeof pals !== "object") return [];
  return Object.entries(pals).map(([instanceId, raw]) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    return {
      instanceId,
      palId: String(p.PalID ?? ""),
      nickname: String(p.Nickname ?? ""),
      gender: String(p.Gender ?? ""),
      level: Number(p.Level ?? 0),
      shiny: Boolean(p.Shiny),
      location,
    };
  });
}

function collectItems(inventory: Record<string, unknown> | undefined): PdItemSlot[] {
  if (!inventory || typeof inventory !== "object") return [];
  const out: PdItemSlot[] = [];
  for (const [container, raw] of Object.entries(inventory)) {
    const slots = (raw as { Slots?: Record<string, unknown> })?.Slots;
    if (!slots) continue;
    for (const slot of Object.values(slots)) {
      const s = (slot ?? {}) as Record<string, unknown>;
      const itemId = String(s.ItemID ?? "");
      if (itemId) out.push({ itemId, count: Number(s.Count ?? 0), container });
    }
  }
  return out;
}

/** 統一玩家名冊(PalDefender 1.8+ /players,含離線玩家)。 */
export async function getPdPlayers(rec: InstanceRecord, ctx: DriverContext): Promise<PdPlayerList> {
  const status = getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    return { available: false, reason: status.reason, onlineCount: 0, totalCount: 0, players: [] };
  }
  const dir = pdDir(rec, ctx)!;
  try {
    const res = await pdFetch<{ Meta?: Record<string, unknown>; Players?: Record<string, unknown>[] }>(
      rec,
      dir,
      "/players",
    );
    const players: PdPlayerSummary[] = (res.Players ?? []).map((raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      return {
        name: String(p.Name ?? ""),
        userId: String(p.UserId ?? ""),
        playerUid: String(p.PlayerUID ?? ""),
        guildName: String(p.GuildName ?? ""),
        online: String(p.Status ?? "").toLowerCase() === "online",
        ip: String(p.IP ?? ""),
      };
    });
    return {
      available: true,
      onlineCount: Number(res.Meta?.OnlineCount ?? players.filter((p) => p.online).length),
      totalCount: Number(res.Meta?.PlayerCount ?? players.length),
      players,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      onlineCount: 0,
      totalCount: 0,
      players: [],
    };
  }
}

/** 公會 + 據點(PalDefender /guilds)。前端拿據點的 world_pos 走 savToMap 畫到地圖。 */
export async function getPdGuilds(rec: InstanceRecord, ctx: DriverContext): Promise<PdGuildList> {
  const status = getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    return { available: false, reason: status.reason, guilds: [] };
  }
  const dir = pdDir(rec, ctx)!;
  try {
    const res = await pdFetch<{ Guilds?: Record<string, Record<string, unknown>> }>(rec, dir, "/guilds");
    const guilds: PdGuild[] = Object.entries(res.Guilds ?? {}).map(([id, raw]) => {
      const g = (raw ?? {}) as Record<string, unknown>;
      const admin = (g.admin ?? {}) as Record<string, unknown>;
      const camps = Array.isArray(g.camps) ? (g.camps as Record<string, unknown>[]) : [];
      return {
        id,
        name: String(g.name ?? ""),
        level: Number(g.Level ?? 0),
        adminName: String(admin.name ?? ""),
        memberCount: Number(g.member_count ?? (Array.isArray(g.members) ? g.members.length : 0)),
        members: Array.isArray(g.members) ? g.members.map(String) : [],
        bases: camps
          .map((c) => {
            const world = ((c ?? {}).world_pos ?? {}) as Record<string, unknown>;
            return { id: String((c ?? {}).id ?? ""), worldX: Number(world.x), worldY: Number(world.y) };
          })
          .filter((b) => Number.isFinite(b.worldX) && Number.isFinite(b.worldY)),
      };
    });
    return { available: true, guilds };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err), guilds: [] };
  }
}

/** 已解鎖科技(/techs);取不到就回 null,不擋玩家詳情主體。 */
async function fetchTechs(rec: InstanceRecord, dir: string, identifier: string): Promise<PlayerTechs | null> {
  try {
    const res = await pdFetch<{ Meta?: Record<string, unknown>; Techs?: { Unlocked?: unknown[] } }>(
      rec,
      dir,
      `/techs/${encodeURIComponent(identifier)}`,
    );
    return {
      unlocked: (res.Techs?.Unlocked ?? []).map(String),
      unlockedCount: Number(res.Meta?.UnlockedCount ?? (res.Techs?.Unlocked ?? []).length),
      totalCount: Number(res.Meta?.TotalCount ?? 0),
    };
  } catch {
    return null;
  }
}

/** 進度概要(/progression);取不到就回 null。 */
async function fetchProgression(
  rec: InstanceRecord,
  dir: string,
  identifier: string,
): Promise<PlayerProgression | null> {
  try {
    const res = await pdFetch<{ Progression?: Record<string, Record<string, unknown>> }>(
      rec,
      dir,
      `/progression/${encodeURIComponent(identifier)}`,
    );
    const prog = res.Progression ?? {};
    const player = prog.Player ?? {};
    const currencies = prog.Currencies ?? {};
    const bosses = prog.Bosses ?? {};
    const captures = prog.Captures ?? {};
    const countKeys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).length : 0);
    return {
      level: Number(player.level ?? 0),
      exp: Number(player.exp ?? 0),
      unusedStatusPoints: Number(player.unusedStatusPoints ?? 0),
      technologyPoints: Number(currencies.technologyPoints ?? 0),
      ancientTechnologyPoints: Number(currencies.ancientTechnologyPoints ?? 0),
      bossesDefeated: Number(bosses.totalBossDefeatCount ?? 0),
      palsCaptured: Number(captures.tribeCaptureCount ?? countKeys(captures.palCaptureCounts)),
    };
  } catch {
    return null;
  }
}

/**
 * 給玩家一顆(客製)帕魯蛋 —— 走 PalDefender REST /give/paleggs/{player},
 * 因為 RCON 的 giveegg_j 沒有目標玩家參數。PalTemplate 用呼叫端已寫好的範本檔名
 * (含 .json),完整詞條 / 體質 / 靈魂都保留。回傳實際給了幾顆。
 */
export async function givePalEgg(
  rec: InstanceRecord,
  ctx: DriverContext,
  userId: string,
  eggId: string,
  templateFile: string,
  level?: number,
): Promise<number> {
  const status = getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    throw Object.assign(new Error(`帕魯蛋需要 PalDefender REST API:${status.reason}`), {
      statusCode: 409,
    });
  }
  const dir = pdDir(rec, ctx)!;
  const egg: Record<string, unknown> = { EggID: eggId, PalTemplate: templateFile };
  if (level != null) egg.Level = level;
  const res = await pdFetch<{ Granted?: { PalEggs?: number } }>(
    rec,
    dir,
    `/give/paleggs/${encodeURIComponent(userId)}`,
    { PalEggs: [egg] },
  );
  return Number(res.Granted?.PalEggs ?? 0);
}

export async function getPlayerDetail(
  rec: InstanceRecord,
  ctx: DriverContext,
  identifier: string,
): Promise<PlayerDetail> {
  const status = getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    return {
      available: false,
      reason: status.reason,
      name: "",
      playerUid: "",
      userId: "",
      guildName: "",
      pals: [],
      teamCount: 0,
      palboxCount: 0,
      items: [],
      techs: null,
      progression: null,
    };
  }
  const dir = pdDir(rec, ctx)!;

  try {
    // 科技/進度是加分項:單獨失敗(端點不存在/舊版)不該擋掉帕魯與背包,故用 best-effort。
    const [player, palsRes, itemsRes, techs, progression] = await Promise.all([
      pdFetch<{ Player?: Record<string, unknown> }>(rec, dir, `/player/${encodeURIComponent(identifier)}`),
      pdFetch<{ Meta?: Record<string, unknown>; Pals?: Record<string, unknown> }>(rec, dir, `/pals/${encodeURIComponent(identifier)}`),
      pdFetch<{ Inventory?: Record<string, unknown> }>(rec, dir, `/items/${encodeURIComponent(identifier)}`),
      fetchTechs(rec, dir, identifier),
      fetchProgression(rec, dir, identifier),
    ]);

    const p = player.Player ?? {};
    const pals = palsRes.Pals ?? {};
    return {
      available: true,
      name: String(p.Name ?? ""),
      playerUid: String(p.PlayerUID ?? ""),
      userId: String(p.UserId ?? ""),
      guildName: String(p.GuildName ?? ""),
      pals: [
        ...collectPals(pals.Team as Record<string, unknown>, "team"),
        ...collectPals(pals.Palbox as Record<string, unknown>, "palbox"),
      ],
      teamCount: Number(palsRes.Meta?.TeamCount ?? 0),
      palboxCount: Number(palsRes.Meta?.PalboxCount ?? 0),
      items: collectItems(itemsRes.Inventory as Record<string, unknown>),
      techs,
      progression,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      name: "",
      playerUid: "",
      userId: "",
      guildName: "",
      pals: [],
      teamCount: 0,
      palboxCount: 0,
      items: [],
      techs: null,
      progression: null,
    };
  }
}
