import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { DATA_DIR } from "./env.js";

const TOKEN_FILE = path.join(DATA_DIR, "token");
const PAIR_FILE = path.join(DATA_DIR, "pair-code");

/**
 * 長 token:給 API 用的正式憑證,web 配對成功後存進瀏覽器。
 */
export function loadOrCreateToken(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// 好念、避免混淆字元(去掉 0/O、1/I)的配對碼字母表。
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * 配對碼:給遠端裝置初次登入用的短、好念憑證。玩家在網頁輸入(或點含配對碼的
 * 設定連結),agent 驗證後換發長 token 存進瀏覽器。存在 data-dir,可透過已登入
 * 的 UI 輪替。比長 token 好唸、可安全地印在終端機或貼給朋友。
 */
export function loadOrCreatePairingCode(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(PAIR_FILE)) {
    return fs.readFileSync(PAIR_FILE, "utf8").trim();
  }
  const code = generateCode();
  fs.writeFileSync(PAIR_FILE, code, { mode: 0o600 });
  return code;
}

/** 重新產生配對碼(輪替);舊碼即刻失效。 */
export function rotatePairingCode(): string {
  const code = generateCode();
  fs.writeFileSync(PAIR_FILE, code, { mode: 0o600 });
  return code;
}

/** 定值時間比對配對碼(大小寫、前後空白正規化)。 */
export function pairingCodeMatches(provided: string, actual: string): boolean {
  const a = Buffer.from(provided.trim().toUpperCase());
  const b = Buffer.from(actual.trim().toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 是否為本機(loopback)請求。同機開瀏覽器的玩家(單機自用最大宗情境)可免 token
 * 直接管理,零摩擦。多使用者主機若要關掉這個便利,設 PALSERVER_REQUIRE_TOKEN=1。
 */
export function isLoopback(ip?: string): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.")
  );
}

/** 是否為私有網段:本機或區域網路(192.168.x.x / 10.x.x.x / 172.16-31.x.x)。
 *  目錄瀏覽等高風險功能僅允許區網內使用。 */
export function isPrivateNetwork(ip: string): boolean {
  if (isLoopback(ip)) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const match = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const a = parseInt(match[1]);
  const b = parseInt(match[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 從請求取出 token:Authorization: Bearer,或(WebSocket 升級無法帶 header)?token= 。 */
export function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const query = (req.query as Record<string, string | undefined>)?.token;
  return bearer ?? query;
}

/** 定值時間比對 token。 */
export function tokenMatches(provided: string | undefined, token: string): boolean {
  if (!provided || provided.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

/** agent 的授權設定,傳給路由讓 /api/info、/api/pair 判斷授權狀態。 */
export interface AuthContext {
  token: string;
  pairingCode: string;
  /** true 時連本機也要 token(多使用者主機用 PALSERVER_REQUIRE_TOKEN=1 開啟)。 */
  requireToken: boolean;
}

export function makeAuthHook(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!tokenMatches(extractToken(req), token)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  };
}
