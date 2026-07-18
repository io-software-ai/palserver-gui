import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { registerRoutes } from "./routes.js";
import { WEB_ORIGINS, REQUIRE_TOKEN } from "./env.js";
import { isLoopback, makeAuthHook } from "./auth.js";
import type { InstanceStore } from "./store.js";
import type { PresenceTracker } from "./presence.js";
import type { BackupScheduler } from "./backup-scheduler.js";
import type { RestartSupervisor } from "./supervisor.js";
import type { AuthContext } from "./auth.js";
import type { UpdateOps } from "./self-update.js";
import type { TlsCert } from "./tls.js";
import type { PublicMapPublisher } from "./public-map.js";

/** App 建構需要的 deps(生產與測試共用)。 */
export interface AppDeps {
  store: InstanceStore;
  presence: PresenceTracker;
  scheduler: BackupScheduler;
  supervisor: RestartSupervisor;
  publicMap: PublicMapPublisher;
  auth: AuthContext;
  updateOps: UpdateOps;
}

export interface AppOptions extends AppDeps {
  /** TLS 憑證;測試不傳(走 http)。 */
  tls?: TlsCert | null;
  /** 內建前端 dist 目錄;測試不傳(不伺服前端)。 */
  webDist?: string | null;
}

/**
 * 建構 Fastify app:fastify 建構 + 中性 middleware(cors/static/websocket/
 * errorHandler)+ auth hook + registerRoutes。
 *
 * 生產與測試共用此 factory(routes.test.ts 用 mock deps 呼叫它)。
 * Lifecycle side effects(presence.start / scheduler.start / announceBoot /
 * app.listen 等)留給呼叫端,不在此處。
 */
export async function createApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: "warn" },
    bodyLimit: 1024 * 1024 * 1024,
    ...(opts.tls ? { https: { key: opts.tls.key, cert: opts.tls.cert } } : {}),
  });

  app.addContentTypeParser("application/octet-stream", (_req, _payload, done) => done(null, undefined));

  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
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

  if (opts.webDist) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
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
    if (routePath === "/api/info" || routePath === "/api/pair") return;
    if (!REQUIRE_TOKEN && isLoopback(req.ip)) return;
    await makeAuthHook(opts.auth.token)(req, reply);
  });

  registerRoutes(app, opts.store, opts.presence, opts.scheduler, opts.supervisor, opts.publicMap, opts.auth, opts.updateOps);

  return app;
}
