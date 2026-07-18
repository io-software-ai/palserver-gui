/**
 * palserver 匿名使用統計收集端(Cloudflare Worker + D1)。
 *
 *   POST /api/event  — agent 回報匿名事件(見下方 EVENT_TYPES)
 *   GET  /api/stats  — 公開的全球彙總數字(前端與任何人都能查)
 *
 * 隱私原則:不記錄 IP、不存任何可識別個人的資料;玩家識別碼只收單向雜湊。
 * 詳見 repo 根目錄的 PRIVACY.md。
 */

import { ADMIN_HTML } from "./admin-page";

export interface Env {
  DB: D1Database;
  GITHUB_REPO: string;
  /** 選填(wrangler secret put GITHUB_TOKEN):GitHub API 匿名請求常被限流,
   * 放一個唯讀 fine-grained token 可穩定抓下載數。 */
  GITHUB_TOKEN?: string;
  /** 發/管理贊助者識別碼的管理密鑰(wrangler secret put ADMIN_TOKEN)。
   * 沒設時 /api/license/issue 與 /reset 一律拒絕。 */
  ADMIN_TOKEN?: string;
  /** Buy Me a Coffee webhook 簽章密鑰(wrangler secret put BMC_WEBHOOK_SECRET)。 */
  BMC_WEBHOOK_SECRET?: string;
  /** Brevo(app.brevo.com)交易信 API key(wrangler secret put BREVO_API_KEY);沒設就不寄碼(仍會建碼)。 */
  BREVO_API_KEY?: string;
  /** 寄件信箱(需先在 Brevo 驗證寄件者/網域),預設 palserver-gui@iosoftware.ai。 */
  BREVO_FROM_EMAIL?: string;
  /** 寄件者顯示名稱,預設 palserver GUI。 */
  BREVO_FROM_NAME?: string;
}

const EVENT_TYPES = ["hello", "instance_created", "server_started", "players_seen"] as const;
type EventType = (typeof EVENT_TYPES)[number];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** map/publish、map/unpublish 是伺服器對伺服器端點(agent 直連,從不被瀏覽器呼叫),
 *  不帶 Access-Control-Allow-Origin,避免任意網頁能用受害者瀏覽器發request。 */
const NO_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** cors=false 時不附加 Access-Control-Allow-Origin 等標頭(見上)。預設 true 維持既有端點行為不變。 */
const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}, cors = true) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(cors ? CORS_HEADERS : {}), ...extraHeaders },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      const noCors = url.pathname === "/api/map/publish" || url.pathname === "/api/map/unpublish";
      return new Response(null, { status: 204, headers: noCors ? NO_CORS_HEADERS : CORS_HEADERS });
    }
    if (req.method === "POST" && url.pathname === "/api/event") return handleEvent(req, env);
    if (req.method === "GET" && url.pathname === "/api/stats") return handleStats(env);
    // 公開地圖快照
    if (req.method === "POST" && url.pathname === "/api/map/publish") return handleMapPublish(req, env);
    if (req.method === "GET" && url.pathname === "/api/map/snapshot") return handleMapSnapshot(req, env);
    if (req.method === "POST" && url.pathname === "/api/map/unpublish") return handleMapUnpublish(req, env);
    // 贊助者識別碼(先行版授權)
    if (req.method === "POST" && url.pathname === "/api/license/activate") return handleLicenseActivate(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/deactivate") return handleLicenseDeactivate(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/issue") return handleLicenseIssue(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/list") return handleLicenseList(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/reset") return handleLicenseReset(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/delete") return handleLicenseDelete(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/bmc-webhook") return handleBmcWebhook(req, env);
    // 管理後台(發碼 / 管理);頁面本身公開,操作靠頁內輸入 ADMIN_TOKEN。
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

interface EventBody {
  installId?: unknown;
  type?: unknown;
  version?: unknown;
  platform?: unknown;
  players?: unknown;
}

async function handleEvent(req: Request, env: Env): Promise<Response> {
  let body: EventBody;
  try {
    body = (await req.json()) as EventBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const installId = typeof body.installId === "string" ? body.installId.slice(0, 64) : "";
  const type = body.type as EventType;
  if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(installId)) return json({ error: "bad installId" }, 400);
  if (!EVENT_TYPES.includes(type)) return json({ error: "bad type" }, 400);
  const version = typeof body.version === "string" ? body.version.slice(0, 64) : null;
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 32) : null;
  const now = new Date().toISOString();

  // 任何事件都視為該安裝「活著」:去重後即為管理者總數。
  await env.DB.prepare(
    `INSERT INTO installs (id, first_seen, last_seen, version, platform) VALUES (?1, ?2, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET last_seen = ?2, version = ?3, platform = ?4`,
  )
    .bind(installId, now, version, platform)
    .run();

  if (type === "instance_created" || type === "server_started") {
    await env.DB.prepare(
      `INSERT INTO counters (key, value) VALUES (?1, 1)
       ON CONFLICT(key) DO UPDATE SET value = value + 1`,
    )
      .bind(type)
      .run();
  }

  if (type === "players_seen") {
    const players = (Array.isArray(body.players) ? body.players : [])
      .filter((p): p is string => typeof p === "string" && /^[0-9a-f]{16,64}$/i.test(p))
      .slice(0, 200);
    if (players.length) {
      const stmt = env.DB.prepare("INSERT OR IGNORE INTO players (hash, first_seen) VALUES (?1, ?2)");
      await env.DB.batch(players.map((p) => stmt.bind(p.toLowerCase(), now)));
    }
  }

  return json({ ok: true });
}

async function handleStats(env: Env): Promise<Response> {
  const [admins, players, counters] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>(),
    env.DB.prepare("SELECT key, value FROM counters").all<{ key: string; value: number }>(),
  ]);
  const counter = (key: string) => counters.results.find((c) => c.key === key)?.value ?? 0;

  return json({
    /** GUI 本體在 GitHub Releases 的下載總數(抓不到時為 null)。 */
    downloads: await githubDownloads(env),
    /** 管理者總數 = 不重複的匿名安裝數(重複下載/重開只算一個)。 */
    admins: admins?.n ?? 0,
    /** 全球不重複玩家數(單向雜湊去重)。 */
    players: players?.n ?? 0,
    instancesCreated: counter("instance_created"),
    serverStarts: counter("server_started"),
  });
}

/** GitHub Releases 下載總數,D1 快取 15 分鐘;抓失敗時回傳舊值(或 null)。 */
async function githubDownloads(env: Env): Promise<number | null> {
  const CACHE_KEY = "gh_downloads";
  const TTL_MS = 15 * 60 * 1000;
  const cachedRow = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1")
    .bind(CACHE_KEY)
    .first<{ value: string }>();
  const cached = cachedRow ? (JSON.parse(cachedRow.value) as { total: number; at: number }) : null;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.total;

  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases?per_page=100`, {
      headers: {
        "User-Agent": "palserver-stats",
        Accept: "application/vnd.github+json",
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const releases = (await res.json()) as { assets?: { download_count?: number }[] }[];
    const total = releases
      .flatMap((r) => r.assets ?? [])
      .reduce((sum, a) => sum + (a.download_count ?? 0), 0);
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = ?2`,
    )
      .bind(CACHE_KEY, JSON.stringify({ total, at: Date.now() }))
      .run();
    return total;
  } catch {
    return cached?.total ?? null;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 公開地圖快照
 *  - POST /api/map/publish   {id, key, snapshot} — agent 每 60 秒推送(伺服器端呼叫,免 CORS)
 *  - GET  /api/map/snapshot  ?id=...             — 公開讀取,viewer 頁用(開放 CORS)
 *  - POST /api/map/unpublish {id, key}           — 服主下架
 * id = shareId,首次出現即註冊(存 key 的 SHA-256 雜湊,不存明碼);之後同 id 須帶對的
 * key 才能覆寫或下架。snapshot 原樣以 JSON 字串存,GET 回傳時還原成物件。
 *
 * 濫用防護:
 *  - 新 id 註冊(還沒被人用過的 id)才會計入 per-IP 節流與總量上限,已存在 id 的更新/
 *    下架不受影響(那條路徑已經有 key 驗證與 10 秒節流擋著)。
 *  - unpublish 是「墓碑」(revoked=1 + 清空 snapshot),不是真的刪列 —— 避免任何人(含
 *    拿舊 key 的殘留背景程序)再對同一個已下架的 id 重新 publish,把它當「首次註冊」復活。
 * ──────────────────────────────────────────────────────────────────────── */

const MAP_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const MAP_SNAPSHOT_MAX_BYTES = 131072;
const MAP_PUBLISH_MIN_INTERVAL_MS = 10_000;
/** 同一個 IP 24 小時內最多能註冊幾個「新」id(更新既有 id 不算)。 */
const MAP_REG_RATE_LIMIT = 10;
const MAP_REG_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** map_reg 節流紀錄的保留期限,超過就在下一次新註冊時順手清掉。 */
const MAP_REG_RETENTION_MS = 48 * 60 * 60 * 1000;
/** 全站同時存在的地圖分享數上限,超過就拒絕新註冊(更新既有 id 不受影響)。 */
const MAP_SHARES_CAPACITY = 50_000;
/** 超過這麼久沒更新的快照視為過期,在新註冊路徑順手清掉(含已撤銷的墓碑列)。 */
const MAP_SHARES_TTL_MS = 60 * 24 * 60 * 60 * 1000;

interface MapShareRow {
  id: string;
  key_hash: string;
  updated_at: number;
  snapshot: string;
  revoked: number;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleMapPublish(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown; key?: unknown; snapshot?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid json" }, 400, {}, false);
  }
  const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
  const key = typeof body.key === "string" ? body.key.slice(0, 256) : "";
  if (!MAP_ID_RE.test(id)) return json({ error: "bad id" }, 400, {}, false);
  if (!key) return json({ error: "bad key" }, 400, {}, false);
  if (typeof body.snapshot !== "object" || body.snapshot === null) {
    return json({ error: "bad snapshot" }, 400, {}, false);
  }

  const snapshotJson = JSON.stringify(body.snapshot);
  if (new TextEncoder().encode(snapshotJson).length > MAP_SNAPSHOT_MAX_BYTES) {
    return json({ error: "snapshot too large" }, 413, {}, false);
  }

  const now = Date.now();
  const existing = await env.DB.prepare("SELECT key_hash, updated_at, revoked FROM map_shares WHERE id = ?1")
    .bind(id)
    .first<Pick<MapShareRow, "key_hash" | "updated_at" | "revoked">>();

  if (!existing) {
    // 新 id:先擋濫用註冊,再寫入。
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    const ipHash = await sha256Hex(ip);
    const regCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM map_reg WHERE ip_hash = ?1 AND created_at >= ?2",
    )
      .bind(ipHash, now - MAP_REG_RATE_WINDOW_MS)
      .first<{ n: number }>();
    if ((regCount?.n ?? 0) >= MAP_REG_RATE_LIMIT) {
      return json({ error: "rate-limited" }, 429, {}, false);
    }

    const totalCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM map_shares").first<{ n: number }>();
    if ((totalCount?.n ?? 0) >= MAP_SHARES_CAPACITY) {
      return json({ error: "capacity" }, 503, {}, false);
    }

    // 註冊此 id,只存 key 的雜湊。
    const keyHash = await sha256Hex(key);
    await env.DB.prepare(`INSERT INTO map_shares (id, key_hash, updated_at, snapshot) VALUES (?1, ?2, ?3, ?4)`)
      .bind(id, keyHash, now, snapshotJson)
      .run();
    await env.DB.prepare("INSERT INTO map_reg (ip_hash, created_at) VALUES (?1, ?2)").bind(ipHash, now).run();
    // 頻率低的路徑,順手清過期資料(節流紀錄、逾期未更新的快照與已撤銷的墓碑列)。
    await env.DB.prepare("DELETE FROM map_reg WHERE created_at < ?1").bind(now - MAP_REG_RETENTION_MS).run();
    await env.DB.prepare("DELETE FROM map_shares WHERE updated_at < ?1").bind(now - MAP_SHARES_TTL_MS).run();
    return json({ ok: true }, 200, {}, false);
  }

  // 已撤銷的墓碑:不論 key 對不對一律拒絕,擋住舊 key 重新註冊復活。
  if (existing.revoked) return json({ error: "revoked" }, 410, {}, false);

  const keyHash = await sha256Hex(key);
  if (!timingSafeEqual(keyHash, existing.key_hash)) return json({ error: "bad-key" }, 401, {}, false);
  if (now - existing.updated_at < MAP_PUBLISH_MIN_INTERVAL_MS) {
    return json({ error: "too many requests" }, 429, {}, false);
  }

  await env.DB.prepare("UPDATE map_shares SET updated_at = ?1, snapshot = ?2 WHERE id = ?3")
    .bind(now, snapshotJson, id)
    .run();
  return json({ ok: true }, 200, {}, false);
}

/** 公開讀取,viewer 頁用:開放 CORS,15 秒可快取。 */
async function handleMapSnapshot(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") ?? "").slice(0, 64);
  if (!MAP_ID_RE.test(id)) return json({ error: "bad id" }, 400);

  const row = await env.DB.prepare("SELECT updated_at, snapshot, revoked FROM map_shares WHERE id = ?1")
    .bind(id)
    .first<Pick<MapShareRow, "updated_at" | "snapshot" | "revoked">>();
  if (!row || row.revoked) return json({ error: "not found" }, 404);

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.snapshot);
  } catch {
    snapshot = null;
  }
  return json({ updatedAt: row.updated_at, snapshot }, 200, { "Cache-Control": "public, max-age=15" });
}

async function handleMapUnpublish(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown; key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid json" }, 400, {}, false);
  }
  const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
  const key = typeof body.key === "string" ? body.key.slice(0, 256) : "";
  if (!MAP_ID_RE.test(id) || !key) return json({ error: "bad request" }, 400, {}, false);

  const row = await env.DB.prepare("SELECT key_hash FROM map_shares WHERE id = ?1")
    .bind(id)
    .first<Pick<MapShareRow, "key_hash">>();
  if (!row) return json({ error: "not found" }, 404, {}, false);

  const keyHash = await sha256Hex(key);
  if (!timingSafeEqual(keyHash, row.key_hash)) return json({ error: "bad-key" }, 401, {}, false);

  // 墓碑,不是真的刪列:擋住之後任何人(含拿舊 key 的殘留背景程序)對同 id 重新
  // publish 時被當「首次註冊」復活這個 id(見 handleMapPublish 的 revoked 檢查)。
  await env.DB.prepare("UPDATE map_shares SET revoked = 1, snapshot = '' WHERE id = ?1").bind(id).run();
  return json({ ok: true }, 200, {}, false);
}

/* ────────────────────────────────────────────────────────────────────────
 * 贊助者識別碼(先行版授權)
 *  - /api/license/activate   {code, machineId} — 驗證 + 首次啟用綁機器(公開)
 *  - /api/license/deactivate {code, machineId} — 自助解綁:只有目前綁定的那台能解(公開)
 *  - /api/license/issue      {tier?, features?, sponsor?, expiresAt?} — 發碼(管理)
 *  - /api/license/reset      {code} — 解除綁定,讓贊助者換機(管理,救援用)
 * 管理端點需 header `X-Admin-Token: <ADMIN_TOKEN>`。
 * ──────────────────────────────────────────────────────────────────────── */

interface LicenseRow {
  code: string;
  tier: string;
  features: string;
  sponsor: string | null;
  created_at: string;
  expires_at: string | null;
  bound_to: string | null;
  activated_at: string | null;
  /** 試用碼:啟用當下才起算 N 天(expires_at 首次啟用時才寫入)。null = 非試用。 */
  trial_days: number | null;
  email: string | null;
  source: string;
}

const isAdmin = (req: Request, env: Env) =>
  !!env.ADMIN_TOKEN && req.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;

/** 好念的識別碼:PAL-XXXX-XXXX-XXXX,字母表排除易混字(0/O/1/I）。 */
function generateCode(): string {
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return "PAL-" + [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

async function handleLicenseActivate(req: Request, env: Env): Promise<Response> {
  let body: { code?: unknown; machineId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ valid: false, reason: "invalid" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const machineId = typeof body.machineId === "string" ? body.machineId.slice(0, 64) : "";
  if (!code || !machineId) return json({ valid: false, reason: "invalid" }, 400);

  const row = await env.DB.prepare("SELECT * FROM licenses WHERE code = ?1").bind(code).first<LicenseRow>();
  if (!row) return json({ valid: false, reason: "invalid" });

  const now = new Date().toISOString();
  if (row.expires_at && now > row.expires_at) {
    return json({ valid: false, reason: "expired", tier: row.tier });
  }
  let expiresAt = row.expires_at;
  if (!row.bound_to) {
    // 首次啟用:綁定這台機器。試用碼(trial_days)在這一刻才起算到期,
    // 這樣活動發出去的碼是「兌換後 N 天」而不是「發碼後 N 天」。
    if (row.trial_days && !expiresAt) {
      expiresAt = new Date(Date.now() + row.trial_days * 86400_000).toISOString();
    }
    await env.DB.prepare(
      "UPDATE licenses SET bound_to = ?1, activated_at = ?2, expires_at = ?3 WHERE code = ?4",
    )
      .bind(machineId, now, expiresAt, code)
      .run();
  } else if (row.bound_to !== machineId) {
    return json({ valid: false, reason: "bound-to-another" });
  }
  return json({
    valid: true,
    tier: row.tier,
    features: JSON.parse(row.features) as string[],
    expiresAt,
  });
}

/** 自助解綁(換機用):要同時持有 code 與「目前綁定的 machineId」才能解,
 *  所以只有綁定中的那台 agent 做得到 —— 不需要管理員。冪等:沒綁過也回 ok。
 *  換機流程:舊機在 GUI 移除識別碼(agent 會呼叫這裡)→ 新機貼碼重新啟用。 */
async function handleLicenseDeactivate(req: Request, env: Env): Promise<Response> {
  let body: { code?: unknown; machineId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, reason: "invalid" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const machineId = typeof body.machineId === "string" ? body.machineId.slice(0, 64) : "";
  if (!code || !machineId) return json({ ok: false, reason: "invalid" }, 400);

  const row = await env.DB.prepare("SELECT bound_to FROM licenses WHERE code = ?1")
    .bind(code)
    .first<{ bound_to: string | null }>();
  if (!row) return json({ ok: false, reason: "invalid" });
  if (!row.bound_to) return json({ ok: true, note: "not-bound" });
  if (row.bound_to !== machineId) return json({ ok: false, reason: "bound-to-another" });

  // 保留 activated_at:試用碼的效期在首次啟用時已寫入 expires_at,換機不重算。
  await env.DB.prepare("UPDATE licenses SET bound_to = NULL WHERE code = ?1 AND bound_to = ?2")
    .bind(code, machineId)
    .run();
  return json({ ok: true });
}

async function handleLicenseIssue(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  let body: {
    tier?: unknown;
    features?: unknown;
    sponsor?: unknown;
    expiresAt?: unknown;
    trialDays?: unknown;
    count?: unknown;
    source?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const tier = typeof body.tier === "string" ? body.tier.slice(0, 32) : "sponsor";
  const features = Array.isArray(body.features)
    ? body.features.filter((f): f is string => typeof f === "string").slice(0, 32)
    : ["custom-pal"];
  const sponsor = typeof body.sponsor === "string" ? body.sponsor.slice(0, 200) : null;
  const source = typeof body.source === "string" ? body.source.slice(0, 32) : "manual";
  // 效期二選一:trialDays(啟用後 N 天,expires_at 先留空)或 expiresAt(固定到期日)。
  const trialDays =
    typeof body.trialDays === "number" && body.trialDays > 0
      ? Math.min(Math.floor(body.trialDays), 3650)
      : null;
  const expiresAt = !trialDays && typeof body.expiresAt === "string" ? body.expiresAt.slice(0, 32) : null;
  const count = Math.min(Math.max(Math.floor(Number(body.count) || 1), 1), 500);
  const now = new Date().toISOString();

  const codes: string[] = [];
  for (let n = 0; n < count; n++) {
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      const code = generateCode();
      try {
        await env.DB.prepare(
          `INSERT INTO licenses (code, tier, features, sponsor, created_at, expires_at, trial_days, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
          .bind(code, tier, JSON.stringify(features), sponsor, now, expiresAt, trialDays, source)
          .run();
        codes.push(code);
        ok = true;
      } catch {
        /* 撞主鍵,換一個 */
      }
    }
    if (!ok) return json({ error: "could not allocate code", codes }, 500);
  }
  // code(單數)保留給既有 CLI(manage.mjs)相容。
  return json({ codes, count: codes.length, code: codes[0], tier, features, sponsor, expiresAt, trialDays });
}

/** 列出識別碼(管理用)。可用 filter 對 sponsor 標籤做子字串過濾。 */
async function handleLicenseList(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  let body: { filter?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const filter = typeof body.filter === "string" ? body.filter.trim() : "";
  const limit = Math.min(Math.max(Math.floor(Number(body.limit) || 500), 1), 2000);
  const stmt = filter
    ? env.DB.prepare(
        "SELECT * FROM licenses WHERE sponsor LIKE ?1 ORDER BY created_at DESC LIMIT ?2",
      ).bind(`%${filter}%`, limit)
    : env.DB.prepare("SELECT * FROM licenses ORDER BY created_at DESC LIMIT ?1").bind(limit);
  const rows = await stmt.all<LicenseRow>();
  const licenses = (rows.results ?? []).map((r) => ({
    code: r.code,
    tier: r.tier,
    features: JSON.parse(r.features) as string[],
    sponsor: r.sponsor,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    trialDays: r.trial_days,
    activatedAt: r.activated_at,
    bound: !!r.bound_to,
    source: r.source,
    email: r.email,
  }));
  return json({ licenses, count: licenses.length });
}

/** 撤銷(刪除)一張識別碼。啟用中的機器下次重驗就會失效。 */
async function handleLicenseDelete(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  let body: { code?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return json({ error: "missing code" }, 400);
  const res = await env.DB.prepare("DELETE FROM licenses WHERE code = ?1").bind(code).run();
  return json({ deleted: res.meta.changes ?? 0 });
}

async function handleLicenseReset(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  let body: { code?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return json({ error: "missing code" }, 400);
  const res = await env.DB.prepare("UPDATE licenses SET bound_to = NULL, activated_at = NULL WHERE code = ?1")
    .bind(code)
    .run();
  return json({ ok: true, reset: res.meta.changes ?? 0 });
}

/* ────────────────────────────────────────────────────────────────────────
 * Buy Me a Coffee 月費會員 webhook -> 自動發碼/續期,並用 Resend 把碼 email 給贊助者。
 *  - membership.started / updated(續訂):依 email 找/建一張碼,expires_at 往後推。
 *    新建立才寄 email(重試/續訂不重寄)。
 *  - membership.cancelled / paused:不再續期,現有效期自然到期後鎖上。
 * 簽章:header x-signature-sha256 = HMAC-SHA256(rawBody, BMC_WEBHOOK_SECRET) 的 hex。
 * ──────────────────────────────────────────────────────────────────────── */

const RENEW_GRACE_DAYS = 33; // 月費 + 幾天寬限:每次續訂事件把效期推到這麼久之後

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定時比較,避免時序側通道。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 從 BMC 的 data 物件裡盡量撈出 email(欄位名各版本略有差異)。 */
function pickEmail(data: Record<string, unknown>): string | null {
  const cands = [
    data.supporter_email,
    data.payer_email,
    data.email,
    (data.supporter as Record<string, unknown> | undefined)?.email,
    (data.member as Record<string, unknown> | undefined)?.email,
  ];
  for (const c of cands) {
    if (typeof c === "string" && /.+@.+\..+/.test(c)) return c.toLowerCase();
  }
  return null;
}

/** 寄碼給贊助者。回傳寄信結果(不 throw:寄信失敗不影響發碼),讓上層能把
 *  成功/失敗與原因回報出來,方便排查(否則 Brevo 拒絕也看不到)。 */
type Lang = "zh" | "en" | "ja";

/** 贊助碼信件的三語文案。html(code) 產生信件內文。 */
const EMAIL_I18N: Record<Lang, { subject: string; html: (code: string) => string }> = {
  zh: {
    subject: "你的 palserver GUI 先行版識別碼",
    html: (code) => `
    <p>感謝你的贊助!以下是你的 palserver GUI 先行版識別碼:</p>
    <p style="font-size:20px;font-weight:800;font-family:monospace">${code}</p>
    <p>在 GUI 的「設定 → 贊助者識別碼」貼上即可解鎖先行版功能。<br>
    一組識別碼同時只能綁定一台伺服器;要換機時,先在舊伺服器移除識別碼,再到新伺服器貼上即可。<br>
    月費有效期間持續解鎖,取消後於當期到期時停用。</p>`,
  },
  en: {
    subject: "Your palserver GUI early-access code",
    html: (code) => `
    <p>Thank you for your support! Here is your palserver GUI early-access code:</p>
    <p style="font-size:20px;font-weight:800;font-family:monospace">${code}</p>
    <p>Paste it into <b>Settings → Sponsor code</b> in the GUI to unlock the early-access features.<br>
    One code binds to a single server at a time — to move it, remove the code on the old server first, then paste it on the new one.<br>
    It stays unlocked while your membership is active and stops at the end of the period after you cancel.</p>`,
  },
  ja: {
    subject: "palserver GUI 先行アクセスコード",
    html: (code) => `
    <p>ご支援ありがとうございます!palserver GUI の先行アクセスコードはこちらです:</p>
    <p style="font-size:20px;font-weight:800;font-family:monospace">${code}</p>
    <p>GUI の「設定 → スポンサーコード」に貼り付けると先行アクセス機能が解除されます。<br>
    1つのコードは同時にサーバー1台のみに紐づきます。別のサーバーへ移す場合は、先に旧サーバーでコードを削除してから新しいサーバーで貼り付けてください。<br>
    メンバーシップが有効な間は解除され、解約後は当期の終了時に無効になります。</p>`,
  },
};

/** 從 BMC payload 盡量判斷語言(zh/ja/en),判不出來 fallback 英文。 */
function pickLang(data: Record<string, unknown>): Lang {
  const cands = [
    data.supporter_locale,
    data.locale,
    data.language,
    data.lang,
    data.country,
    data.supporter_country,
    (data.supporter as Record<string, unknown> | undefined)?.locale,
    (data.member as Record<string, unknown> | undefined)?.locale,
  ];
  const s = cands.find((c) => typeof c === "string");
  const v = typeof s === "string" ? s.toLowerCase() : "";
  if (/\b(zh|tw|hk|cn|mo|hant|hans)\b|zh[-_]|taiwan|hong|china/.test(v)) return "zh";
  if (/\b(ja|jp)\b|ja[-_]|japan/.test(v)) return "ja";
  return "en";
}

async function sendCodeEmail(
  env: Env,
  to: string,
  code: string,
  lang: Lang = "en",
): Promise<{ sent: boolean; error?: string }> {
  if (!env.BREVO_API_KEY) return { sent: false, error: "BREVO_API_KEY 未設定(worker 上沒有這個 secret)" };
  const tpl = EMAIL_I18N[lang] ?? EMAIL_I18N.en;
  try {
    // Brevo 交易信 API(https://developers.brevo.com/reference/sendtransacemail)。
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: {
          name: env.BREVO_FROM_NAME ?? "palserver GUI",
          email: env.BREVO_FROM_EMAIL ?? "palserver-gui@iosoftware.ai",
        },
        to: [{ email: to }],
        subject: tpl.subject,
        htmlContent: tpl.html(code),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { sent: false, error: `Brevo HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

async function handleBmcWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  // 驗簽章:沒設密鑰一律拒絕(避免誤開後門)。
  if (!env.BMC_WEBHOOK_SECRET) return json({ error: "webhook not configured" }, 503);
  const provided = req.headers.get("x-signature-sha256") ?? "";
  const expected = await hmacHex(env.BMC_WEBHOOK_SECRET, raw);
  if (!timingSafeEqual(provided, expected)) return json({ error: "bad signature" }, 401);

  let evt: { type?: string; data?: Record<string, unknown> };
  try {
    evt = JSON.parse(raw) as typeof evt;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const type = String(evt.type ?? "");
  const data = (evt.data ?? {}) as Record<string, unknown>;

  const active = /(membership|recurring_donation)\.(started|updated)$/.test(type);
  const inactive = /(membership|recurring_donation)\.(cancelled|paused)$/.test(type);
  if (!active && !inactive) return json({ ok: true, ignored: type });

  const email = pickEmail(data);
  if (!email) return json({ ok: true, note: "no email in payload" });

  const now = new Date();
  if (inactive) {
    // 不動效期:當期到期後 agent 重驗就會鎖上(等於「繳到當期為止」)。
    return json({ ok: true, type, email, action: "let-expire" });
  }

  // active:找/建這個 email 的碼,把效期推到 now + 寬限。
  const expiresAt = new Date(now.getTime() + RENEW_GRACE_DAYS * 86400_000).toISOString();
  const existing = await env.DB.prepare("SELECT code FROM licenses WHERE email = ?1 LIMIT 1")
    .bind(email)
    .first<{ code: string }>();

  if (existing) {
    await env.DB.prepare("UPDATE licenses SET expires_at = ?1 WHERE code = ?2")
      .bind(expiresAt, existing.code)
      .run();
    return json({ ok: true, type, email, action: "renewed", code: existing.code });
  }

  // 新贊助者:建碼 + 寄信。BMC 對同一次訂閱會連發多個事件(membership.started 與
  // recurring_donation.started、或逾時重送),並發時上面的 SELECT 都撈不到 →
  // 全靠 email 的部分唯一索引擋:只有一個 INSERT 真的成功,其餘走 ON CONFLICT
  // 變成續期。RETURNING 的 code 若不是這次生成的,代表碼已由別的請求建立,不重寄信。
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      const row = await env.DB.prepare(
        `INSERT INTO licenses (code, tier, features, sponsor, created_at, expires_at, email, source)
         VALUES (?1, 'sponsor', ?2, ?3, ?4, ?5, ?6, 'bmc')
         ON CONFLICT(email) WHERE email IS NOT NULL DO UPDATE SET expires_at = excluded.expires_at
         RETURNING code`,
      )
        .bind(code, JSON.stringify(["custom-pal"]), email, now.toISOString(), expiresAt, email)
        .first<{ code: string }>();
      if (!row) throw new Error("insert returned no row");
      if (row.code !== code) {
        return json({ ok: true, type, email, action: "renewed", code: row.code });
      }
      const emailed = await sendCodeEmail(env, email, code, pickLang(data));
      return json({
        ok: true,
        type,
        email,
        action: "issued",
        code,
        emailed: emailed.sent,
        ...(emailed.error ? { emailError: emailed.error } : {}),
      });
    } catch {
      /* 撞碼(code 主鍵)重試 */
    }
  }
  return json({ error: "could not allocate code" }, 500);
}
