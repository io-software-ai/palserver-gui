#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { detectVpn } from "@palserver/shared";
import { DATA_DIR, HOST, PORT, AGENT_VERSION, REQUIRE_TOKEN, WEB_ORIGINS, TLS_ENABLED, OPEN_BROWSER, IS_PORTABLE_EXE } from "./env.js";
import {
  loadOrCreateToken,
  loadOrCreatePairingCode,
  makeAuthHook,
  isLoopback,
  type AuthContext,
} from "./auth.js";
import { loadOrCreateTlsCert } from "./tls.js";
import { InstanceStore } from "./store.js";
import { PresenceTracker } from "./presence.js";
import { BackupScheduler } from "./backup-scheduler.js";
import { RestartSupervisor } from "./supervisor.js";
import { fetchLatest } from "./version.js";
import { isInstalling, nativeDriver } from "./native.js";
import { dockerDriver } from "./docker.js";
import { k8sDriver } from "./k8s.js";
import { registerRoutes } from "./routes.js";
import { announceBoot, trackPlayers } from "./telemetry.js";
import { cleanupOldBinaries, startUpdateChecker, type UpdateOps } from "./self-update.js";
import { refreshLicense } from "./license.js";
import { startTray } from "./tray.js";

// 啟動流程包在 async main() 內,讓 entry 沒有頂層 await —— 這樣才能打包成
// CommonJS 供 Node SEA 免安裝執行檔使用(頂層 await 只能輸出 ESM)。
async function main() {
// Windows 免安裝執行檔:用系統匣圖示取代一直開著的主控台視窗。做法是「用隱藏視窗把自己重啟一份」,
// 原本這個帶主控台的實例就結束 —— cmd 視窗隨之關閉,背景那份(PALSERVER_TRAY_CHILD=1)負責跑
// agent 並顯示系統匣。設 PALSERVER_CONSOLE=1 可保留主控台除錯。
// 只在玩家雙擊的免安裝執行檔上做;開發模式(pnpm dev / tsx watch)不隱藏,否則會把互動終端
// 直接關掉,拿不到 token 也沒有 watch 重載 —— 那正是「start-agent 壞了」的原因。
if (
  process.platform === "win32" &&
  IS_PORTABLE_EXE &&
  !process.env.PALSERVER_TRAY_CHILD &&
  !process.env.PALSERVER_CONSOLE &&
  resolveWebDist() !== null
) {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, PALSERVER_TRAY_CHILD: "1" },
    });
    child.unref();
    process.stdout.write("\n  palserver GUI 已在背景啟動,系統匣(右下角)有圖示。這個視窗可以關閉。\n\n");
    process.exit(0);
  } catch {
    /* 重啟失敗就照常在這個主控台繼續跑 */
  }
}

const tls = TLS_ENABLED ? await loadOrCreateTlsCert() : null;
const scheme = tls ? "https" : "http";
const app = Fastify({
  // 只留警告與錯誤 —— 一般啟動與每次 API 請求的 JSON log 對雙擊使用的玩家是雜訊,
  // 乾淨的啟動說明改由 printStartupBanner() 印出。出問題時 warn/error 仍會顯示。
  logger: { level: "warn" },
  bodyLimit: 1024 * 1024 * 1024,
  ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
});
const token = loadOrCreateToken();
const pairingCode = loadOrCreatePairingCode();
const auth: AuthContext = { token, pairingCode, requireToken: REQUIRE_TOKEN };
const store = new InstanceStore();

// 上次自我更新換下來的舊執行檔(Windows 當下刪不掉)現在可以清了。
cleanupOldBinaries();

// File uploads stream straight to disk (see PUT /files/upload), so hand the
// raw request through instead of buffering it into a body.
app.addContentTypeParser("application/octet-stream", (_req, _payload, done) => done(null, undefined));

// CORS 白名單:同源(合一版,通常不送 Origin)、本機各埠(含 dev server)、以及
// 設定允許的公開 web 站。跨源資料仍受 token/loopback 保護,收緊再擋一層。
await app.register(cors, {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin / 非瀏覽器 / 原生 app
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      return cb(null, false);
    }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return cb(null, true);
    if (WEB_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
});
await app.register(websocket);

// Serve the built web UI when present.
const webDist = resolveWebDist();
if (webDist) {
  await app.register(fastifyStatic, {
    root: webDist,
    // index.html 不可快取,agent 更新後玩家瀏覽器才會立刻拿到新前端;
    // vite 產出的 JS/CSS 檔名帶雜湊,可交給瀏覽器長快取(靠 etag 重新驗證)。
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  });
}

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof ZodError) {
    reply.code(400).send({ error: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ") });
    return;
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  reply.code(status).send({ error: err.message });
});

app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  const routePath = req.url.split("?")[0];
  // 公開端點:偵測 agent(/api/info)與配對換發 token(/api/pair)本身不需授權。
  if (routePath === "/api/info" || routePath === "/api/pair") return;
  // 本機(loopback)免驗證,單機自用零摩擦;PALSERVER_REQUIRE_TOKEN=1 可關閉。
  if (!REQUIRE_TOKEN && isLoopback(req.ip)) return;
  await makeAuthHook(token)(req, reply);
});

// Warm the Steam version cache so the first instance listing already knows
// whether an update is available (it only ever reads the cache).
void fetchLatest().catch(() => {});

const presence = new PresenceTracker(store);
presence.start();

// 匿名使用統計(可關閉,見 PRIVACY.md):登記這次啟動,並把既有名冊上的玩家
// 補進全球玩家統計(只送單向雜湊;telemetry 模組自己會去重)。
announceBoot();
trackPlayers(store.list().flatMap((rec) => presence.knownPlayers(rec.id).map((p) => p.userId)));

const scheduler = new BackupScheduler(store, (rec) =>
  rec.backend === "native" ? nativeDriver : rec.backend === "k8s" ? k8sDriver : dockerDriver,
);
scheduler.start();

const supervisor = new RestartSupervisor(store, (rec) =>
  rec.backend === "native" ? nativeDriver : rec.backend === "k8s" ? k8sDriver : dockerDriver,
);
supervisor.start();

// 自我更新會整個換掉執行檔並重啟行程。遊戲伺服器是 detached 生成的、不受影響,
// 但 DepotDownloader 是 agent 的子行程 —— 安裝到一半重啟會把它砍掉。
const updateOps: UpdateOps = {
  canApply: () =>
    store.list().some((rec) => isInstalling(rec.id))
      ? "有伺服器正在安裝檔案,請等安裝完成再更新"
      : null,
  onRestart: () => app.close(),
  log: (msg) => app.log.info(`[update] ${msg}`),
};

registerRoutes(app, store, presence, scheduler, supervisor, auth, updateOps);

await app.listen({ host: HOST, port: PORT });

startUpdateChecker(updateOps);

// 贊助者識別碼:啟動時驗證一次,之後定期重驗(內部有 12h 節流;訂閱到期/取消會在此收斂)。
void refreshLicense(true).catch(() => {});
setInterval(() => void refreshLicense().catch(() => {}), 6 * 60 * 60 * 1000).unref();

app.log.info(`palserver-agent v${AGENT_VERSION} · data dir: ${DATA_DIR}`);

// 只有「合一版」(內含前端)自動開網頁才有意義;純 agent 版打開只會看到 API。
const willOpen = webDist !== null && OPEN_BROWSER;
printStartupBanner(scheme, PORT, pairingCode, webDist !== null, willOpen);
if (willOpen) openBrowser(`${scheme}://localhost:${PORT}`);

// 背景那份(主控台已隱藏)顯示系統匣圖示,作為「引擎運作中」的提示與控制入口。
if (process.env.PALSERVER_TRAY_CHILD) {
  const tray = startTray({ url: `${scheme}://localhost:${PORT}`, code: pairingCode });
  if (tray) {
    const stopTray = () => {
      try {
        tray.kill();
      } catch {
        /* 已結束 */
      }
    };
    process.on("exit", stopTray);
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
  }
}
}

// EADDRINUSE 幾乎都是「玩家又點了一次」:別噴一大坨堆疊,給一句友善說明並打開既有的介面。
void main().catch((err: NodeJS.ErrnoException) => {
  if (err?.code === "EADDRINUSE") {
    const url = `http://localhost:${PORT}`;
    process.stdout.write(
      `\n  palserver GUI 已經在執行了(埠 ${PORT} 已被使用),不用再開一個。\n` +
        `  直接打開管理介面即可:${url}\n\n`,
    );
    if (OPEN_BROWSER) openBrowser(url);
    process.exit(0);
  }
  process.stderr.write(`\n  palserver GUI agent 啟動失敗:${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});

/** 盡力打開系統預設瀏覽器到指定網址;headless / 無瀏覽器就安靜略過,絕不讓它拖垮啟動。 */
function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

/**
 * 找出要 serve 的 web/dist,支援三種執行情境:
 *  - PALSERVER_WEB_DIR 環境變數(明確指定)
 *  - 執行檔旁的 web/ 資料夾(免安裝 exe / SEA:release 內含 web/)
 *  - 相對於本模組的 ../../web/dist(開發時的 monorepo 佈局)
 * 都找不到就回 null(agent 只提供 API,不 serve 前端)。
 */
function resolveWebDist(): string | null {
  const candidates: string[] = [];
  if (process.env.PALSERVER_WEB_DIR) candidates.push(process.env.PALSERVER_WEB_DIR);
  candidates.push(path.join(path.dirname(process.execPath), "web"));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"));
  } catch {
    /* 打包成 CJS 時 import.meta.url 為空,略過此候選 */
  }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

/** 收集本機各網卡的 IPv4,標出可能是 VPN(Tailscale / Radmin / Hamachi)的位址。 */
function localAddresses(): { ip: string; vpn: string | null }[] {
  const out: { ip: string; vpn: string | null }[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push({ ip: a.address, vpn: detectVpn(a.address) });
    }
  }
  // VPN 位址排前面(最適合遠端連線)。
  return out.sort((a, b) => Number(!!b.vpn) - Number(!!a.vpn));
}

/**
 * 精簡的啟動說明:只留玩家真正需要的三行 —— 本機管理網址、邀朋友的設定連結、配對碼。
 * 完整的 token / 各網卡位址 / 授權條款都改到 GUI 內的設定頁與隨附檔案,不再洗版。
 */
function printStartupBanner(
  proto: string,
  port: number,
  code: string,
  hasWeb: boolean,
  willOpen: boolean,
): void {
  const remote = localAddresses()[0]; // 優先 VPN(Tailscale/Radmin…),否則第一個區網位址
  const L = (s = "") => process.stdout.write(s + "\n");
  L();
  L("  palserver GUI 已啟動。請保持這個視窗開著(關掉就會停止伺服器管理)。");
  L();
  if (hasWeb) {
    L(`  在這台電腦管理: ${proto}://localhost:${port}${willOpen ? "   (正在自動開啟瀏覽器…)" : ""}`);
  } else {
    L(`  API 位址(此版本未內含網頁介面): ${proto}://localhost:${port}`);
  }
  if (remote) {
    L(`  邀朋友 / 其他裝置: ${proto}://${remote.ip}:${port}/?setup=${code}${remote.vpn ? `   (${remote.vpn})` : ""}`);
  }
  L(`  配對碼: ${code}   (在別的裝置連線時要用)`);
  if (proto === "https") L("  自簽憑證會跳安全警告,選「繼續前往」即可。");
  L();
}
