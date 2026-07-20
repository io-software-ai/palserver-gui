import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  PdPal,
  PdItemSlot,
  PdGuild,
  PdGuildList,
  PdGuildDetail,
  PdPlayerList,
  PdPlayerSummary,
  PdRestStatus,
  PlayerDetail,
  PlayerProgression,
  PlayerTechs,
} from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import { serverPlatform } from "./platform.js";
import { serverRoot } from "./native.js";
import { rconExec } from "./rcon.js";
import * as dockerOps from "./docker.js";
import { execInPod, readFileInPod, writeFileBytesInPod } from "./k8s-files.js";

const PD_PORT_BASE = 17993;

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
const PD_DIR_NAMES = ["PalDefender", "palguard"];
/** Container/Pod 內的 PD 目錄相對路徑（resolvePodPath 會加 /palworld 前綴）。 */
const PD_REL_DIR = "Pal/Binaries/Win64";
const REST_CONFIG_REL = "RESTAPI/RESTConfig.json";

// ── Container/Pod file helpers (docker = execInContainer, k8s = execInPod) ──

async function readFileInRuntime(rec: InstanceRecord, absPath: string): Promise<string | null> {
  if (rec.backend === "native") {
    try { return fs.readFileSync(absPath, "utf8"); } catch { return null; }
  }
  if (rec.backend === "docker") {
    try { return await dockerOps.execInContainer(rec, ["cat", absPath]); } catch { return null; }
  }
  // k8s: resolvePodPath 限制 /palworld 前綴，用 execInPod 繞過
  try { return await execInPod(rec, ["cat", absPath]); } catch { return null; }
}

async function writeFileInRuntime(rec: InstanceRecord, absPath: string, content: string): Promise<void> {
  if (rec.backend === "native") {
    fs.writeFileSync(absPath, content);
    return;
  }
  if (rec.backend === "docker") {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await dockerOps.execInContainer(rec, ["sh", "-c", `echo '${b64}' | base64 -d > '${absPath}'`]);
    return;
  }
  // k8s: writeFileBytesInPod 走 resolvePodPath（/palworld 前綴）
  if (absPath.startsWith("/palworld/")) {
    await writeFileBytesInPod(rec, absPath.replace(/^\/palworld\//, ""), Buffer.from(content, "utf8"));
  } else {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await execInPod(rec, ["sh", "-c", `echo '${b64}' | base64 -d > '${absPath}'`]);
  }
}

async function existsInRuntime(rec: InstanceRecord, absPath: string): Promise<boolean> {
  if (rec.backend === "native") return fs.existsSync(absPath);
  if (rec.backend === "docker") {
    try { await dockerOps.execInContainer(rec, ["test", "-e", absPath]); return true; } catch { return false; }
  }
  try { await execInPod(rec, ["test", "-e", absPath]); return true; } catch { return false; }
}

async function mkdirInRuntime(rec: InstanceRecord, absPath: string): Promise<void> {
  if (rec.backend === "native") { fs.mkdirSync(absPath, { recursive: true }); return; }
  if (rec.backend === "docker") { await dockerOps.execInContainer(rec, ["mkdir", "-p", absPath]); return; }
  await execInPod(rec, ["mkdir", "-p", absPath]);
}

/** PD 目錄的絕對路徑（native = host fs, docker/k8s = /palworld/...）。 */
function pdDirPath(rec: InstanceRecord, ctx: DriverContext): string {
  if (rec.backend === "native") {
    return path.join(serverRoot(rec, ctx), "Pal", "Binaries", "Win64");
  }
  return "/palworld/Pal/Binaries/Win64";
}

/** 偵測 PD 是否已安裝，回傳 PD 目錄絕對路徑（或 null）。 */
export async function getPdDir(rec: InstanceRecord, ctx: DriverContext): Promise<string | null> {
  const base = pdDirPath(rec, ctx);
  for (const name of PD_DIR_NAMES) {
    if (await existsInRuntime(rec, `${base}/${name}/RESTAPI/RESTConfig.json`)) return `${base}/${name}`;
    if (await existsInRuntime(rec, `${base}/${name}`)) return `${base}/${name}`;
  }
  return null;
}

/** 讀取單一實例的 PD REST port（從 RESTConfig.json）。 */
export async function readPdPort(rec: InstanceRecord, ctx: DriverContext): Promise<number | null> {
  const dir = await getPdDir(rec, ctx);
  if (!dir) return null;
  const { port } = await restConfig(rec, dir);
  return port;
}

/** 分配一個未佔用的 PD REST port。比對所有實例的 PD port + TCP port（REST/RCON）。 */
export async function nextPdRestPort(
  store: InstanceStore,
  ctxOf: (rec: InstanceRecord) => DriverContext,
): Promise<number> {
  const tcpUsed = store.usedTcpPorts();
  const pdUsed = new Set<number>();
  for (const rec of store.list()) {
    const port = await readPdPort(rec, ctxOf(rec)).catch(() => null);
    if (port) pdUsed.add(port);
  }
  let port = PD_PORT_BASE;
  while (tcpUsed.has(port) || pdUsed.has(port)) port++;
  return port;
}

async function restConfig(rec: InstanceRecord, dir: string): Promise<{ enabled: boolean; port: number }> {
  const file = `${dir}/RESTAPI/RESTConfig.json`;
  const raw = await readFileInRuntime(rec, file);
  if (!raw) return { enabled: false, port: 17993 };
  try {
    const cfg = JSON.parse(raw);
    return { enabled: cfg.Enabled === true, port: Number(cfg.Port) || 17993 };
  } catch {
    return { enabled: false, port: 17993 };
  }
}

/** Read our token, creating it (and reloading PalDefender) if absent. */
async function ensureToken(rec: InstanceRecord, dir: string): Promise<string> {
  const tokensDir = `${dir}/RESTAPI/Tokens`;
  const file = `${tokensDir}/${TOKEN_FILE}`;
  const existing = await readFileInRuntime(rec, file);
  if (existing) {
    try {
      const token = JSON.parse(existing).Token;
      if (typeof token === "string" && token.length > 0) return token;
    } catch { /* corrupt, recreate */ }
  }
  await mkdirInRuntime(rec, tokensDir);
  const token = crypto.randomBytes(32).toString("base64url");
  await writeFileInRuntime(rec, file,
    JSON.stringify({ Name: "palserver GUI", Token: token, Permissions: ["REST.*"] }, null, 4));
  await rconExec(rec, "reloadcfg").catch(() => {});
  return token;
}

export async function getPdRestStatus(rec: InstanceRecord, ctx: DriverContext): Promise<PdRestStatus> {
  if (serverPlatform(rec) !== "windows") {
    return { installed: false, configExists: false, enabled: false, hasToken: false, port: 17993, reason: "玩家細節僅支援 Windows 伺服器" };
  }
  const dir = await getPdDir(rec, ctx);
  if (!dir) {
    return { installed: false, configExists: false, enabled: false, hasToken: false, port: 17993, reason: "尚未安裝 PalDefender" };
  }
  const configFile = `${dir}/RESTAPI/RESTConfig.json`;
  const configExists = await existsInRuntime(rec, configFile);
  const { enabled, port } = await restConfig(rec, dir);
  if (!configExists) {
    return {
      installed: true, configExists: false, enabled: false, hasToken: false, port,
      reason: "PalDefender 尚未生成 REST 設定 — 啟動一次伺服器即會產生",
    };
  }
  if (!enabled) {
    return {
      installed: true, configExists: true, enabled: false, hasToken: false, port,
      reason: "PalDefender REST API 未啟用 — 啟用後即可查看玩家的帕魯與背包",
    };
  }
  const hasToken = await existsInRuntime(rec, `${dir}/RESTAPI/Tokens/${TOKEN_FILE}`);
  return { installed: true, configExists: true, enabled: true, hasToken, port };
}

/** Pre-configure REST API: create/overwrite RESTConfig.json with Enabled=true
 * and a unique port. Called right after installComponent so PD boots fully
 * configured on the next start — no manual enable/port/token steps needed. */
export async function preConfigureRestApi(rec: InstanceRecord, ctx: DriverContext, port: number): Promise<void> {
  const dir = await getPdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const restApiDir = `${dir}/RESTAPI`;
  // Read existing config if present (PD may have generated defaults on a previous boot).
  const configFile = `${restApiDir}/RESTConfig.json`;
  const existing = await readFileInRuntime(rec, configFile);
  let cfg: Record<string, unknown>;
  if (existing) {
    try { cfg = JSON.parse(existing); } catch { cfg = {}; }
  } else {
    cfg = {};
  }
  cfg.Enabled = true;
  cfg.Port = port;
  cfg.Address = cfg.Address ?? "0.0.0.0";
  // Ensure directory exists, then write.
  await mkdirInRuntime(rec, restApiDir);
  await writeFileInRuntime(rec, configFile, JSON.stringify(cfg, null, 4));
}

/** Set Port in RESTConfig.json (preserving the rest of the file). */
export async function setPdRestPort(rec: InstanceRecord, ctx: DriverContext, port: number): Promise<void> {
  const dir = await getPdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const file = `${dir}/RESTAPI/RESTConfig.json`;
  const raw = await readFileInRuntime(rec, file);
  if (!raw) throw Object.assign(new Error("找不到 RESTConfig.json — 請先啟動一次伺服器"), { statusCode: 409 });
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(raw); } catch { throw Object.assign(new Error("RESTConfig.json 格式損壞"), { statusCode: 409 }); }
  cfg.Port = port;
  await writeFileInRuntime(rec, file, JSON.stringify(cfg, null, 4));
}

/** Set Enabled in RESTConfig.json (preserving the rest of the file). */
export async function setPdRestEnabled(rec: InstanceRecord, ctx: DriverContext, enabled: boolean): Promise<void> {
  const dir = await getPdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const file = `${dir}/RESTAPI/RESTConfig.json`;
  const raw = await readFileInRuntime(rec, file);
  if (!raw) throw Object.assign(new Error("找不到 RESTConfig.json — 請先啟動一次伺服器"), { statusCode: 409 });
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(raw); } catch { throw Object.assign(new Error("RESTConfig.json 格式損壞"), { statusCode: 409 }); }
  cfg.Enabled = enabled;
  await writeFileInRuntime(rec, file, JSON.stringify(cfg, null, 4));
}

/** Create the agent's bearer token file if missing (and reloadcfg). Returns
 * whether the token now exists. Lets the UI provision access without the raw
 * editor; regenerate=true rotates it. */
export async function provisionPdToken(
  rec: InstanceRecord,
  ctx: DriverContext,
  regenerate: boolean,
): Promise<boolean> {
  const dir = await getPdDir(rec, ctx);
  if (!dir) throw Object.assign(new Error("尚未安裝 PalDefender"), { statusCode: 409 });
  const file = `${dir}/RESTAPI/Tokens/${TOKEN_FILE}`;
  if (regenerate) {
    if (rec.backend === "native") { fs.rmSync(file, { force: true }); }
    else if (rec.backend === "docker") { await dockerOps.execInContainer(rec, ["rm", "-f", file]); }
    else { await execInPod(rec, ["rm", "-f", file]); }
  }
  await ensureToken(rec, dir);
  return existsInRuntime(rec, file);
}

/** 強化版建立流程用:在「首次啟動前」預先鋪好 REST 設定與 GUI 權杖。
 * PalDefender 尚未跑過、連 PalDefender/ 目錄都還沒有,所以自己建目錄寫檔;
 * PalDefender 首次開機讀到 Enabled:true 就直接把 REST API 帶起來,缺的
 * 欄位由它自己補預設值。伺服器沒在跑,不需要(也無從)reloadcfg。 */
export function preprovisionPdRest(rec: InstanceRecord, ctx: DriverContext): void {
  const win64 = path.join(serverRoot(rec, ctx), "Pal", "Binaries", "Win64");
  // 沿用既有目錄名(palguard 舊安裝);沒有就用預設 PalDefender。此流程是 native
  // 強化版建立(首次啟動前),host fs 同步掃描即可 —— 等價於合併前 main 的 pdDir()
  // (該函式在 #36 重構成 runtime-aware 的 async getPdDir,不適用這個同步情境)。
  const existing = PD_DIR_NAMES.map((n) => path.join(win64, n)).find((p) => fs.existsSync(p));
  const dir = existing ?? path.join(win64, "PalDefender");
  const restDir = path.join(dir, "RESTAPI");
  fs.mkdirSync(restDir, { recursive: true });

  const cfgFile = path.join(restDir, "RESTConfig.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    /* 尚未生成或壞檔 → 重寫 */
  }
  cfg.Enabled = true;
  cfg.Port ??= 17993;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 4));

  const tokensDir = path.join(restDir, "Tokens");
  const tokenFile = path.join(tokensDir, TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) {
    fs.mkdirSync(tokensDir, { recursive: true });
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ Name: "palserver GUI", Token: token, Permissions: ["REST.*"] }, null, 4),
    );
  }
}

/** Map PalDefender's error codes to something a manager can act on. */
const PD_ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "存取權杖尚未生效 — 請重啟伺服器一次(或確認 RCON 已啟用,讓 agent 能自動載入權杖)",
  MISSING_PERMISSION: "存取權杖權限不足",
  PLAYER_NOT_FOUND: "找不到這個玩家 —— 可能從未加入過此伺服器,或你的 PalDefender 版本過舊(需 1.8.0 以上才能查詢離線玩家,請更新 PalDefender)。",
  PLAYER_ACCOUNT_NOT_FOUND: "找到玩家但無法載入其存檔資料",
  REQUEST_TIMEOUT: "PalDefender 回應逾時,請稍後再試",
  REQUEST_FAILED: "PalDefender 處理請求時發生錯誤",
};

class PdRestError extends Error {}

/** Resolve the PD REST host: k8s uses Service DNS, docker/native use localhost. */
function pdHost(rec: InstanceRecord): string {
  if (rec.backend === "k8s" && rec.k8sServiceName && rec.k8sNamespace) {
    return `${rec.k8sServiceName}.${rec.k8sNamespace}`;
  }
  return "127.0.0.1";
}

async function pdFetch<T>(
  rec: InstanceRecord,
  dir: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const { port } = await restConfig(rec, dir);
  const token = await ensureToken(rec, dir);
  let res: Response;
  try {
    res = await fetch(`http://${pdHost(rec)}:${port}/v1/pdapi${endpoint}`, {
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
    const palId = String(p.PalID ?? "");
    // BOSS 判定:PD 1.8+ 直接给 IsBoss;老版本或塔主从 palId 前缀 / 内部标记推断。
    const isBoss = Boolean(p.IsBoss ?? p.IsBOSS) || /^BOSS_/i.test(palId) || Boolean(p.IsTowerBoss ?? p.IsTower);
    const isTower = Boolean(p.IsTower ?? p.IsTowerBoss) && !isBoss;
    return {
      instanceId,
      palId,
      nickname: String(p.Nickname ?? ""),
      gender: String(p.Gender ?? ""),
      level: Number(p.Level ?? 0),
      shiny: Boolean(p.Shiny),
      location,
      ivs: readPalIvs(p),
      passives: readStringArray(p.Passives ?? p.PassiveSkillList ?? p.Traits),
      activeSkills: readStringArray(p.ActiveSkills ?? p.ActiveSkillList),
      rank: readNumber(p.Rank ?? p.CondensedRank),
      condensedPals: readNumber(p.CondensedPals ?? p.CondensedCount),
      souls: readSouls(p),
      isBoss,
      isTower,
    };
  });
}

/** 兼容 PD 不同版本的 IVs 字段名:IVs 对象、Talent_HP/Shot/Melee/Defense。 */
export function readPalIvs(p: Record<string, unknown>): PdPal["ivs"] | undefined {
  const obj = p.IVs;
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const out: NonNullable<PdPal["ivs"]> = {};
    if (readNumber(o.HP) != null) out.hp = readNumber(o.HP);
    if (readNumber(o.Health) != null && out.hp == null) out.hp = readNumber(o.Health);
    if (readNumber(o.Attack) != null) out.attack = readNumber(o.Attack);
    if (readNumber(o.Melee) != null && out.attack == null) out.attack = readNumber(o.Melee);
    if (readNumber(o.Defense) != null) out.defense = readNumber(o.Defense);
    if (readNumber(o.WorkSpeed) != null) out.workSpeed = readNumber(o.WorkSpeed);
    if (Object.keys(out).length) return out;
  }
  const hp = readNumber(p.Talent_HP ?? p.TalentHP ?? p.TalentHp);
  const atk = readNumber(p.Talent_Shot ?? p.TalentShot ?? p.TalentAttack ?? p.Talent_Melee ?? p.TalentMelee);
  const def = readNumber(p.Talent_Defense ?? p.TalentDefense);
  if (hp == null && atk == null && def == null) return undefined;
  return { hp: hp ?? undefined, attack: atk ?? undefined, defense: def ?? undefined };
}

function readSouls(p: Record<string, unknown>): PdPal["souls"] | undefined {
  const obj = p.Souls ?? p.PalSouls;
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const out: NonNullable<PdPal["souls"]> = {};
    if (readNumber(o.HP) != null) out.hp = readNumber(o.HP);
    if (readNumber(o.Attack) != null) out.attack = readNumber(o.Attack);
    if (readNumber(o.Defense) != null) out.defense = readNumber(o.Defense);
    if (readNumber(o.WorkSpeed) != null) out.workSpeed = readNumber(o.WorkSpeed);
    if (Object.keys(out).length) return out;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => String(v ?? "").trim()).filter(Boolean);
  return out.length ? out : undefined;
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
  const status = await getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    return { available: false, reason: status.reason, onlineCount: 0, totalCount: 0, players: [] };
  }
  const dir = (await getPdDir(rec, ctx))!;
  try {
    const res = await pdFetch<{ Meta?: Record<string, unknown>; Players?: Record<string, unknown>[] }>(
      rec,
      dir,
      "/players",
    );
    const players: PdPlayerSummary[] = (res.Players ?? []).map((raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      const world = (p.WorldLocation ?? {}) as Record<string, unknown>;
      const wx = Number(world.x);
      const wy = Number(world.y);
      return {
        name: String(p.Name ?? ""),
        userId: String(p.UserId ?? ""),
        playerUid: String(p.PlayerUID ?? ""),
        guildName: String(p.GuildName ?? ""),
        online: String(p.Status ?? "").toLowerCase() === "online",
        ip: String(p.IP ?? ""),
        worldX: Number.isFinite(wx) ? wx : undefined,
        worldY: Number.isFinite(wy) ? wy : undefined,
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

/** 公會 + 據點(PalDefender /guilds)。據點位置與公會名稱人人可見;detailed=false(非贊助者)
 * 時只把「成員名單 / 會長名」拿掉(那些屬於公會詳情,贊助者先行版),據點座標與公會名照給。
 * 前端拿據點的 world_pos 走 savToMap 畫到地圖;detailed 旗標讓前端決定點擊走 REST 詳情或存檔版。 */
export async function getPdGuilds(
  rec: InstanceRecord,
  ctx: DriverContext,
  detailed: boolean,
): Promise<PdGuildList> {
  const status = await getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    return { available: false, detailed, reason: status.reason, guilds: [] };
  }
  const dir = (await getPdDir(rec, ctx))!;
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
        // 會長名與成員名單屬公會詳情(贊助者先行);非贊助者不給,但據點/公會名/人數照顯示。
        adminName: detailed ? String(admin.name ?? "") : "",
        memberCount: Number(g.member_count ?? (Array.isArray(g.members) ? g.members.length : 0)),
        members: detailed && Array.isArray(g.members) ? g.members.map(String) : [],
        bases: camps
          .map((c) => {
            const world = ((c ?? {}).world_pos ?? {}) as Record<string, unknown>;
            return { id: String((c ?? {}).id ?? ""), worldX: Number(world.x), worldY: Number(world.y) };
          })
          .filter((b) => Number.isFinite(b.worldX) && Number.isFinite(b.worldY)),
      };
    });
    return { available: true, detailed, guilds };
  } catch (err) {
    return { available: false, detailed, reason: err instanceof Error ? err.message : String(err), guilds: [] };
  }
}

/** 單一公會詳情(PalDefender /guild/{id}):成員名單 + 據點(含等級/狀態)。贊助者功能。 */
export async function getPdGuild(
  rec: InstanceRecord,
  ctx: DriverContext,
  guildId: string,
): Promise<PdGuildDetail> {
  const empty = (reason?: string): PdGuildDetail => ({
    available: false,
    reason,
    id: guildId,
    name: "",
    level: 0,
    adminName: "",
    memberCount: 0,
    members: [],
    camps: [],
  });
  const status = await getPdRestStatus(rec, ctx);
  if (!status.enabled) return empty(status.reason);
  const dir = (await getPdDir(rec, ctx))!;
  try {
    const res = await pdFetch<{ Guild?: Record<string, unknown> }>(
      rec,
      dir,
      `/guild/${encodeURIComponent(guildId)}`,
    );
    const g = (res.Guild ?? {}) as Record<string, unknown>;
    const admin = (g.admin ?? {}) as Record<string, unknown>;
    const rawMembers = Array.isArray(g.members) ? (g.members as Record<string, unknown>[]) : [];
    const rawCamps = Array.isArray(g.camps) ? (g.camps as Record<string, unknown>[]) : [];
    return {
      available: true,
      id: guildId,
      name: String(g.name ?? ""),
      level: Number(g.Level ?? 0),
      adminName: String(admin.name ?? ""),
      memberCount: Number(g.member_count ?? rawMembers.length),
      members: rawMembers.map((m) => ({
        playerUid: String((m ?? {}).player_uid ?? ""),
        name: String((m ?? {}).player_name ?? ""),
        status: String((m ?? {}).status ?? ""),
      })),
      camps: rawCamps.map((c) => {
        const world = ((c ?? {}).world_pos ?? {}) as Record<string, unknown>;
        return {
          id: String((c ?? {}).id ?? ""),
          level: Number((c ?? {}).level ?? 0),
          worldX: Number(world.x),
          worldY: Number(world.y),
          state: String((c ?? {}).state ?? ""),
        };
      }),
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
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
  const status = await getPdRestStatus(rec, ctx);
  if (!status.enabled) {
    throw Object.assign(new Error(`帕魯蛋需要 PalDefender REST API:${status.reason}`), {
      statusCode: 409,
    });
  }
  const dir = (await getPdDir(rec, ctx))!;
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
  const status = await getPdRestStatus(rec, ctx);
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
  const dir = (await getPdDir(rec, ctx))!;

  try {
    const player = await pdFetch<{ Player?: Record<string, unknown> }>(
      rec,
      dir,
      `/player/${encodeURIComponent(identifier)}`,
    );

    let palsFailed = false;
    let itemsFailed = false;
    const [palsRes, itemsRes, techs, progression] = await Promise.all([
      pdFetch<{ Meta?: Record<string, unknown>; Pals?: Record<string, unknown> }>(rec, dir, `/pals/${encodeURIComponent(identifier)}`).catch(() => {
        palsFailed = true;
        return {} as { Meta?: Record<string, unknown>; Pals?: Record<string, unknown> };
      }),
      pdFetch<{ Inventory?: Record<string, unknown> }>(rec, dir, `/items/${encodeURIComponent(identifier)}`).catch(() => {
        itemsFailed = true;
        return {} as { Inventory?: Record<string, unknown> };
      }),
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
      palsUnavailable: palsFailed,
      itemsUnavailable: itemsFailed,
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
