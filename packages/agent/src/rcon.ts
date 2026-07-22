import net from "node:net";
import type { InstanceRecord } from "./store.js";

/**
 * Minimal Source RCON client (the protocol Palworld's dedicated server
 * speaks on RCONPort). Each call opens a connection, authenticates with the
 * admin password, runs one command and closes — commands are infrequent and
 * a pooled connection would have to survive server restarts.
 *
 * Packet: int32 size | int32 id | int32 type | body\0 | \0   (all little-endian)
 */
const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXEC = 2;
const TYPE_RESPONSE = 0;

const CONNECT_TIMEOUT_MS = 4000;
/** Responses can span several packets; this is how long we wait for more
 * after the first one arrives. */
const DRAIN_MS = 250;

type RconBase64Resolver = (rec: InstanceRecord) => boolean | Promise<boolean>;
let resolveBase64: RconBase64Resolver | null = null;

/** PalDefender stores the protocol mode in Config.json. Routes install a
 * resolver once their instance context is available. */
export function setRconBase64Resolver(resolver: RconBase64Resolver): void {
  resolveBase64 = resolver;
}

class RconError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const size = 4 + 4 + payload.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt8(0, 12 + payload.length);
  buf.writeUInt8(0, 13 + payload.length);
  return buf;
}

export function decodeRconBase64(body: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return body;
  const decoded = Buffer.from(body, "base64").toString("utf8");
  return decoded.includes("\uFFFD") ? body : decoded;
}

interface Packet {
  id: number;
  type: number;
  body: string;
}

/** Pull as many whole packets as `buffer` holds; returns the unconsumed tail. */
function decode(buffer: Buffer, out: Packet[]): Buffer<ArrayBufferLike> {
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (buffer.length - offset - 4 < size) break;
    out.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.toString("utf8", offset + 12, offset + 4 + size - 2),
    });
    offset += 4 + size;
  }
  return buffer.subarray(offset);
}

export function requireRcon(rec: InstanceRecord): void {
  if (!rec.settings.RCONEnabled) {
    throw new RconError("RCON 未啟用 — 請到世界設定開啟 RCONEnabled 並重啟伺服器", 409);
  }
  if (!rec.settings.AdminPassword) {
    throw new RconError("尚未設定管理員密碼 — 請到世界設定填入 AdminPassword 並重啟", 409);
  }
}

/** Resolve the RCON host: k8s uses Service DNS, docker/native use localhost. */
function rconHost(rec: InstanceRecord): string {
  if (rec.backend === "k8s" && rec.k8sServiceName && rec.k8sNamespace) {
    return `${rec.k8sServiceName}.${rec.k8sNamespace}`;
  }
  return "127.0.0.1";
}

/** `async` so a disabled-RCON instance rejects instead of throwing
 * synchronously — callers attach .catch() and would otherwise be bypassed. */
export async function rconExec(
  rec: InstanceRecord,
  command: string,
  options?: { base64?: boolean },
): Promise<string> {
  requireRcon(rec);
  const port = Number(rec.settings.RCONPort);
  const password = String(rec.settings.AdminPassword);
  const useBase64 = options?.base64 ?? (resolveBase64 ? await resolveBase64(rec) : false);

  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: rconHost(rec), port });
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const packets: Packet[] = [];
    let authed = false;
    let drainTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (err: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    socket.on("connect", () => socket.write(encodeRconPacket(1, TYPE_AUTH, password)));

    socket.on("data", (chunk) => {
      tail = decode(Buffer.concat([tail, chunk]), packets);

      if (!authed) {
        const auth = packets.find((p) => p.type === TYPE_AUTH_RESPONSE);
        if (!auth) return;
        if (auth.id === -1) {
          finish(new RconError("RCON 認證失敗 — 管理員密碼可能不符", 401));
          return;
        }
        authed = true;
        packets.length = 0;
        const body = useBase64 ? Buffer.from(command, "utf8").toString("base64") : command;
        socket.write(encodeRconPacket(2, TYPE_EXEC, body));
        return;
      }

      // Collect response packets, then settle once they stop arriving.
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        const rawBody = packets
          .filter((p) => p.type === TYPE_RESPONSE)
          .map((p) => p.body)
          .join("")
          .trim();
        const body = useBase64 ? decodeRconBase64(rawBody) : rawBody;
        finish(null, body);
      }, DRAIN_MS);
    });

    socket.on("timeout", () =>
      finish(
        new RconError(
          authed ? "RCON 指令逾時" : "無法連線到 RCON — 伺服器可能未在運作中",
          503,
        ),
      ),
    );
    socket.on("error", () =>
      finish(new RconError("無法連線到 RCON — 伺服器可能未在運作中", 503)),
    );
    socket.on("close", () => {
      if (!settled) finish(authed ? null : new RconError("RCON 連線被關閉", 503));
    });
  });
}

/**
 * PalDefender exposes /getrconcmds, which lists exactly the commands this
 * server accepts. Returns null when unavailable so callers fall back to the
 * static catalog.
 */
export async function fetchServerCommands(rec: InstanceRecord): Promise<string[] | null> {
  try {
    const body = await rconExec(rec, "getrconcmds");
    const names = body
      .split(/[\s,]+/)
      .map((s) => s.replace(/^\//, "").trim())
      .filter((s) => /^[a-z_]{2,}$/i.test(s));
    return names.length > 0 ? [...new Set(names)] : null;
  } catch {
    return null;
  }
}
