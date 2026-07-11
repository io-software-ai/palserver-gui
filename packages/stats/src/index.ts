/**
 * palserver 匿名使用統計收集端(Cloudflare Worker + D1)。
 *
 *   POST /api/event  — agent 回報匿名事件(見下方 EVENT_TYPES)
 *   GET  /api/stats  — 公開的全球彙總數字(前端與任何人都能查)
 *
 * 隱私原則:不記錄 IP、不存任何可識別個人的資料;玩家識別碼只收單向雜湊。
 * 詳見 repo 根目錄的 PRIVACY.md。
 */

export interface Env {
  DB: D1Database;
  GITHUB_REPO: string;
  /** 選填(wrangler secret put GITHUB_TOKEN):GitHub API 匿名請求常被限流,
   * 放一個唯讀 fine-grained token 可穩定抓下載數。 */
  GITHUB_TOKEN?: string;
  /** 發/管理贊助者識別碼的管理密鑰(wrangler secret put ADMIN_TOKEN)。
   * 沒設時 /api/license/issue 與 /reset 一律拒絕。 */
  ADMIN_TOKEN?: string;
}

const EVENT_TYPES = ["hello", "instance_created", "server_started", "players_seen"] as const;
type EventType = (typeof EVENT_TYPES)[number];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method === "POST" && url.pathname === "/api/event") return handleEvent(req, env);
    if (req.method === "GET" && url.pathname === "/api/stats") return handleStats(env);
    // 贊助者識別碼(先行版授權)
    if (req.method === "POST" && url.pathname === "/api/license/activate") return handleLicenseActivate(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/issue") return handleLicenseIssue(req, env);
    if (req.method === "POST" && url.pathname === "/api/license/reset") return handleLicenseReset(req, env);
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
 * 贊助者識別碼(先行版授權)
 *  - /api/license/activate {code, machineId} — 驗證 + 首次啟用綁機器(公開)
 *  - /api/license/issue    {tier?, features?, sponsor?, expiresAt?} — 發碼(管理)
 *  - /api/license/reset    {code} — 解除綁定,讓贊助者換機(管理)
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
  if (!row.bound_to) {
    // 首次啟用:綁定這台機器。
    await env.DB.prepare("UPDATE licenses SET bound_to = ?1, activated_at = ?2 WHERE code = ?3")
      .bind(machineId, now, code)
      .run();
  } else if (row.bound_to !== machineId) {
    return json({ valid: false, reason: "bound-to-another" });
  }
  return json({
    valid: true,
    tier: row.tier,
    features: JSON.parse(row.features) as string[],
    expiresAt: row.expires_at,
  });
}

async function handleLicenseIssue(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  let body: { tier?: unknown; features?: unknown; sponsor?: unknown; expiresAt?: unknown };
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
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt.slice(0, 32) : null;
  const now = new Date().toISOString();

  // 極小機率撞碼就重試幾次。
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      await env.DB.prepare(
        `INSERT INTO licenses (code, tier, features, sponsor, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(code, tier, JSON.stringify(features), sponsor, now, expiresAt)
        .run();
      return json({ code, tier, features, sponsor, expiresAt });
    } catch {
      /* 撞主鍵,換一個 */
    }
  }
  return json({ error: "could not allocate code" }, 500);
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
