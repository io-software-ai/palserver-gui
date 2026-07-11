import type { FastifyInstance } from "fastify";
import {
  COMMANDS,
  ENGINE_OPTIONS,
  PALDEFENDER_OPTIONS,
  type EngineSettings,
  type PalDefenderConfig,
  CreateInstanceSchema,
  CustomPalSchema,
  UpdateSettingsSchema,
  WorldSettingsSchema,
  detectVpn,
  type AgentInfo,
  type InstanceDetail,
  type InstanceSummary,
  type RconCommandsResponse,
} from "@palserver/shared";
import { fetchServerCommands, rconExec, requireRcon } from "./rcon.js";
import type { PresenceTracker } from "./presence.js";
import type { BackupScheduler } from "./backup-scheduler.js";
import type { RestartSupervisor } from "./supervisor.js";
import { AGENT_VERSION } from "./env.js";
import {
  type AuthContext,
  extractToken,
  isLoopback,
  pairingCodeMatches,
  rotatePairingCode,
  tokenMatches,
} from "./auth.js";
import type { InstanceStore, InstanceRecord } from "./store.js";
import type { DriverContext, ServerDriver } from "./driver.js";
import * as dockerOps from "./docker.js";

import { k8sDriver } from "./k8s.js";
import { SERVER_LAUNCHER, classifyServerDir, isInstalling, lastInstallError, moveServerFiles, nativeDriver, serverRoot, updateServer } from "./native.js";
import { cachedVersionSummary, getVersionStatus } from "./version.js";
import { getConnectionInfo } from "./connectivity.js";
import { getModsStatus, installComponent, installedEnhancements, removeComponent, setLuaModEnabled } from "./mods.js";
import { getModerationLists, moderation } from "./moderation.js";
import { getLiveStatus, rest } from "./restapi.js";
import * as files from "./files.js";
import * as saves from "./saves.js";
import { getEngineSettings, writeEngineSettings } from "./engine-ini.js";
import { getConfigHealth, regenerateConfig } from "./config-health.js";
import { getPalDefenderConfig, writePalDefenderConfig } from "./paldefender-config.js";
import { getPlayerDetail, getPdRestStatus, setPdRestEnabled, provisionPdToken } from "./paldefender-rest.js";
import { setTelemetryEnabled, telemetryStatus, track } from "./telemetry.js";
import { licenseStatus, setLicenseKey, clearLicenseKey, featureEnabled } from "./license.js";
import { giveCustomPal } from "./pals.js";
import { applyUpdate, getUpdateStatus, setUpdatePrefs, type UpdateOps } from "./self-update.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const drivers: Record<InstanceRecord["backend"], ServerDriver> = {
  native: nativeDriver,
  docker: dockerOps.dockerDriver,
  k8s: k8sDriver,
};

export function registerRoutes(
  app: FastifyInstance,
  store: InstanceStore,
  presence: PresenceTracker,
  scheduler: BackupScheduler,
  supervisor: RestartSupervisor,
  auth: AuthContext,
  updateOps: UpdateOps,
): void {
  const ctxOf = (rec: InstanceRecord): DriverContext => ({
    instanceDir: store.instanceDir(rec.id),
  });
  const driverOf = (rec: InstanceRecord) => drivers[rec.backend];

  const toSummary = async (rec: InstanceRecord): Promise<InstanceSummary> => {
    const { status } = await driverOf(rec).status(rec, ctxOf(rec));
    // Cached only — listing instances must never wait on Steam or the server.
    const { gameVersion, updateAvailable } = cachedVersionSummary(rec, ctxOf(rec));
    const enhancements =
      rec.backend === "native" ? installedEnhancements(saves.serverRootOf(rec, ctxOf(rec))) : [];
    return {
      id: rec.id,
      name: rec.name,
      backend: rec.backend,
      flavor: rec.flavor,
      gamePort: rec.gamePort,
      status,
      createdAt: rec.createdAt,
      gameVersion,
      updateAvailable,
      enhancements,
      installError: rec.backend === "native" ? lastInstallError(rec.id) : null,
    };
  };

  const getOr404 = (id: string): InstanceRecord => {
    const rec = store.get(id);
    if (!rec) {
      const err = new Error("instance not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return rec;
  };

  app.get("/api/info", async (req): Promise<AgentInfo> => {
    const dockerVersion = await dockerOps.docker
      .version()
      .then((v) => v.Version)
      .catch(() => "unavailable");
    // 公開端點,但一併回報此請求的授權狀態,讓前端判斷要直接進還是引導配對。
    const authenticated =
      (!auth.requireToken && isLoopback(req.ip)) || tokenMatches(extractToken(req), auth.token);
    return {
      name: "palserver-agent",
      version: AGENT_VERSION,
      dockerVersion,
      instanceCount: store.list().length,
      authenticated,
      platform: process.platform,
    };
  });

  // GUI 自我更新(對接 GitHub Releases)。?force=1 略過 6 小時的檢查快取。
  app.get("/api/update", async (req) => {
    const force = (req.query as { force?: string }).force === "1";
    return getUpdateStatus(force);
  });

  app.put("/api/update/prefs", async (req) => {
    const patch = z
      .object({
        autoCheck: z.boolean().optional(),
        autoApply: z.boolean().optional(),
        channel: z.enum(["stable", "prerelease"]).optional(),
      })
      .parse(req.body);
    setUpdatePrefs(patch);
    return getUpdateStatus();
  });

  // 換檔會關掉這個 HTTP server 並重啟行程,所以先把 202 送出去,再開始動工;
  // 前端輪詢 GET /api/update 看 phase 與 lastError。
  app.post("/api/update/apply", async (req, reply) => {
    const status = await getUpdateStatus(true);
    if (!status.supported) return reply.code(400).send({ error: status.reason ?? "不支援自我更新" });
    if (!status.updateAvailable) return reply.code(409).send({ error: "已經是最新版本" });
    if (status.phase !== "idle") return reply.code(409).send({ error: "更新已在進行中" });
    const blocked = updateOps.canApply();
    if (blocked) return reply.code(409).send({ error: blocked });

    reply.code(202).send({ applying: true, latestVersion: status.latestVersion });
    setImmediate(() => {
      // 失敗會記在 status.lastError,這裡吞掉避免變成未處理的 rejection。
      void applyUpdate(updateOps).catch(() => {});
    });
    return reply;
  });

  // 匿名使用統計(遙測)開關。收集內容與原則見 PRIVACY.md;envDisabled=true 表示
  // 被 PALSERVER_TELEMETRY=0 強制停用,GUI 開關無效。
  app.get("/api/telemetry", async () => telemetryStatus());
  app.put("/api/telemetry", async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return setTelemetryEnabled(enabled);
  });

  // 贊助者識別碼(先行版授權):填碼 -> 立即向 worker 啟用/驗證;一碼綁一台。
  app.get("/api/license", async () => licenseStatus());
  app.put("/api/license", async (req) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(req.body);
    return setLicenseKey(code);
  });
  app.delete("/api/license", async () => clearLicenseKey());

  // 配對:遠端裝置用好念的配對碼換發長 token。此端點本身免 token(靠配對碼保護)。
  app.post("/api/pair", async (req, reply) => {
    const code = String((req.body as { code?: string } | null)?.code ?? "");
    if (!code || !pairingCodeMatches(code, auth.pairingCode)) {
      return reply.code(401).send({ error: "invalid pairing code" });
    }
    return { token: auth.token };
  });

  // 輪替配對碼(需已授權);舊碼即刻失效。回傳新碼給 UI 顯示/產生邀請連結。
  app.post("/api/pair/rotate", async () => {
    const code = rotatePairingCode();
    auth.pairingCode = code;
    return { pairingCode: code };
  });

  // 已授權者可查目前配對碼,用來產生「邀請朋友遠端連線」的設定連結。
  app.get("/api/pair/code", async () => ({ pairingCode: auth.pairingCode }));

  // 這台 agent 的可連 IPv4 位址(標出可能是 VPN 的:Tailscale / Radmin / Hamachi),
  // 讓設定頁組出給其他裝置用的登入連結。scheme/port 前端用自己連進來的網址即可推得。
  app.get("/api/addresses", async () => {
    const out: { ip: string; vpn: string | null }[] = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== "IPv4" || a.internal) continue;
        out.push({ ip: a.address, vpn: detectVpn(a.address) });
      }
    }
    out.sort((a, b) => Number(!!b.vpn) - Number(!!a.vpn));
    return { addresses: out };
  });

  app.get("/api/instances", async (): Promise<InstanceSummary[]> => {
    return Promise.all(store.list().map(toSummary));
  });

  app.post("/api/instances", async (req, reply) => {
    const input = CreateInstanceSchema.parse(req.body);
    if (store.findByName(input.name)) {
      return reply.code(409).send({ error: `instance "${input.name}" already exists` });
    }
    const portTaken = store.list().some((r) => r.gamePort === input.gamePort);
    if (portTaken) {
      return reply.code(409).send({ error: `game port ${input.gamePort} already in use` });
    }
    let serverDir: string | undefined;
    let serverDirManaged: boolean | undefined;
    if (input.serverDir?.trim()) {
      if (input.backend !== "native") {
        return reply.code(400).send({ error: "serverDir is only supported by the native backend" });
      }
      if (!path.isAbsolute(input.serverDir.trim())) {
        return reply.code(400).send({ error: `server dir must be an absolute path: ${input.serverDir}` });
      }
      serverDir = path.resolve(input.serverDir.trim());
      if (store.list().some((r) => r.serverDir && path.resolve(r.serverDir) === serverDir)) {
        return reply.code(409).send({ error: `server dir already used by another instance: ${serverDir}` });
      }
      const kind = classifyServerDir(serverDir);
      if (kind === "not-a-server") {
        return reply.code(409).send({
          error:
            `"${SERVER_LAUNCHER}" not found in ${serverDir} and the directory is not empty — ` +
            `point at an existing PalServer install, or at an empty/new folder to install into`,
        });
      }
      serverDirManaged = kind === "install" ? true : undefined;
    }
    const settings = WorldSettingsSchema.parse({
      ServerName: input.name,
      PublicPort: input.gamePort,
      ...input.settings,
    });
    const rec = store.create({
      name: input.name,
      backend: input.backend,
      flavor: input.flavor,
      gamePort: input.gamePort,
      serverDir,
      serverDirManaged,
      settings,
      k8sNamespace: input.k8sNamespace,
      k8sStatefulSet: input.k8sStatefulSet,
      k8sServiceName: input.k8sServiceName,
    });
    if (rec.backend === "docker") {
      dockerOps.writeConfig(store.instanceDir(rec.id), settings);
    }
    track("instance_created");
    reply.code(201);
    return toSummary(rec);
  });

  app.get("/api/instances/:id", async (req): Promise<InstanceDetail> => {
    const rec = getOr404((req.params as { id: string }).id);
    const { status, runtimeId } = await driverOf(rec).status(rec, ctxOf(rec));
    return {
      ...(await toSummary(rec)),
      status,
      runtimeId,
      serverDir: rec.serverDir ?? null,
      effectiveServerDir: rec.backend === "native" ? serverRoot(rec, ctxOf(rec)) : null,
      settings: rec.settings,
    };
  });

  app.put("/api/instances/:id/settings", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const patch = UpdateSettingsSchema.parse(req.body);
    const updated = store.update(rec.id, {
      settings: WorldSettingsSchema.parse({ ...rec.settings, ...patch }),
    });
    // The driver re-renders the ini on every start; pre-render for docker so
    // the bind-mounted config is already in place.
    if (rec.backend === "docker") {
      dockerOps.writeConfig(store.instanceDir(rec.id), updated.settings);
      return { applied: "on-next-restart", settings: updated.settings };
    }
    // k8s: the game-server image reads settings from env, not ini. PATCH the
    // StatefulSet env in place; the Pod rolls and picks up the new values.
    // `restartTriggered` signals the UI that the change is already live.
    if (rec.backend === "k8s") {
      const { applyEnvPatchK8s } = await import("./k8s-env-patch.js");
      const result = await applyEnvPatchK8s(rec, updated.settings);
      return {
        applied: "env-patched",
        settings: updated.settings,
        restartTriggered: true,
        unsupportedKeys: result.unsupported.length > 0 ? result.unsupported : undefined,
      };
    }
    return { applied: "on-next-restart", settings: updated.settings };
  });

  /** 查看/修改伺服器路徑(僅 native)。改路徑不搬檔案:指到既有安裝就直接
   * 採用;指到空資料夾/新路徑則下次啟動時安裝到那裡;留空回到 agent 資料夾。
   * 伺服器執行或安裝中不允許改,避免把行程與檔案狀態改到分家。 */
  app.put("/api/instances/:id/server-dir", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(400).send({ error: "serverDir is only supported by the native backend" });
    }
    const { status } = await driverOf(rec).status(rec, ctxOf(rec));
    if (status === "running" || status === "restarting" || status === "installing" || isInstalling(rec.id)) {
      return reply.code(409).send({ error: "stop the server before changing its directory" });
    }
    const input = z.object({ serverDir: z.string().max(500) }).parse(req.body);
    const trimmed = input.serverDir.trim();
    const ctx = ctxOf(rec);
    const currentRoot = serverRoot(rec, ctx);

    // 目標路徑:留空 = 搬回 agent 管理的資料夾。
    let newServerDir: string | undefined;
    let newRoot: string;
    if (!trimmed) {
      newServerDir = undefined;
      newRoot = path.join(ctx.instanceDir, "server");
    } else {
      if (!path.isAbsolute(trimmed)) {
        return reply.code(400).send({ error: `server dir must be an absolute path: ${trimmed}` });
      }
      newServerDir = path.resolve(trimmed);
      newRoot = newServerDir;
      if (store.list().some((r) => r.id !== rec.id && r.serverDir && path.resolve(r.serverDir) === newServerDir)) {
        return reply.code(409).send({ error: `server dir already used by another instance: ${newServerDir}` });
      }
    }
    if (path.resolve(newRoot) === path.resolve(currentRoot)) {
      return { serverDir: rec.serverDir ?? null }; // 沒變
    }

    const hasFiles = fs.existsSync(currentRoot) && fs.readdirSync(currentRoot).length > 0;
    if (!hasFiles) {
      // 目前沒有檔案可搬:單純改指向(採用既有安裝 / 當成安裝目標)。
      const kind = classifyServerDir(newRoot);
      if (kind === "not-a-server") {
        return reply.code(409).send({
          error:
            `"${SERVER_LAUNCHER}" not found in ${newRoot} and the directory is not empty — ` +
            `point at an existing PalServer install, or at an empty/new folder to install into`,
        });
      }
      const updated = store.update(rec.id, {
        serverDir: newServerDir,
        serverDirManaged: kind === "install" ? true : undefined,
      });
      return { serverDir: updated.serverDir ?? null };
    }

    // 有檔案:真的把伺服器檔案搬到新位置。目標必須是空的或不存在,免得蓋掉別的東西。
    if (fs.existsSync(newRoot) && fs.readdirSync(newRoot).length > 0) {
      return reply.code(409).send({
        error: `target directory must be empty or non-existent (moving relocates the current files): ${newRoot}`,
      });
    }
    // 搬移在背景進行(跨磁碟複製可能較久):實例先顯示「安裝中」,搬完更新記錄。
    moveServerFiles(rec, ctx, newServerDir, () => {
      store.update(rec.id, { serverDir: newServerDir, serverDirManaged: undefined });
    });
    reply.code(202);
    return { moving: true };
  });

  app.post("/api/instances/:id/start", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    await driverOf(rec).start(rec, ctxOf(rec));
    supervisor.noteManualState(rec.id, true);
    track("server_started");
    return toSummary(rec);
  });

  app.post("/api/instances/:id/stop", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    await driverOf(rec).stop(rec, ctxOf(rec));
    presence.markAllOffline(rec.id);
    // A deliberate stop must not look like a crash to the supervisor.
    supervisor.noteManualState(rec.id, false);
    return toSummary(rec);
  });

  app.post("/api/instances/:id/restart", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    await driverOf(rec).stop(rec, ctxOf(rec));
    presence.markAllOffline(rec.id);
    await driverOf(rec).start(rec, ctxOf(rec));
    supervisor.noteManualState(rec.id, true);
    track("server_started");
    return toSummary(rec);
  });

  app.delete("/api/instances/:id", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    await driverOf(rec).remove(rec, ctxOf(rec));
    store.remove(rec.id);
    // World saves under the instance/server dir are kept on disk deliberately;
    // deleting them should be an explicit, separate action.
    reply.code(204);
  });

  /** 匯出成 tar.gz 下載:存檔 + ini 設定 + PalDefender 設定,不含可重下的遊戲執行檔。
   *  瀏覽器直接開這個網址下載(token 走 query,見 auth)。目前僅 native。 */
  app.get("/api/instances/:id/export", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(400).send({ error: "export is only supported by the native backend" });
    }
    const stream = saves.exportArchiveStream(rec, ctxOf(rec));
    if (!stream) {
      return reply.code(409).send({ error: "nothing to export yet — start the server once to generate saves/config" });
    }
    const safe = rec.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${safe}-export.tar.gz"`);
    return stream;
  });

  /** 複製伺服器:用相同設定開一個新實例(換新名稱與新遊戲埠),並複製世界存檔與設定,
   *  但不複製數十 GB 的遊戲執行檔(新實例自行安裝)。目前僅 native;需先停止來源。 */
  app.post("/api/instances/:id/duplicate", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(400).send({ error: "duplicate is only supported by the native backend" });
    }
    const { status } = await driverOf(rec).status(rec, ctxOf(rec));
    if (status === "running" || status === "restarting" || status === "installing" || isInstalling(rec.id)) {
      return reply.code(409).send({ error: "stop the server before duplicating it" });
    }
    const body = z.object({ name: z.string().max(80).optional() }).parse(req.body ?? {});
    // 名稱唯一:預設 <name>-copy,撞名就往後補號。
    const base = body.name?.trim() || `${rec.name}-copy`;
    let name = base;
    for (let n = 2; store.findByName(name); n++) name = `${base}-${n}`;
    // 遊戲埠:從來源埠 +1 往上找一個沒被占用的。
    const usedPorts = new Set(store.list().map((r) => r.gamePort));
    let gamePort = rec.gamePort + 1;
    while (usedPorts.has(gamePort)) gamePort++;

    const settings = WorldSettingsSchema.parse({ ...rec.settings, ServerName: name, PublicPort: gamePort });
    // 新實例一律 agent 管理(不共用來源的外部安裝目錄)。
    const created = store.create({ name, backend: "native", flavor: rec.flavor, gamePort, settings });
    try {
      saves.copyPortableData(serverRoot(rec, ctxOf(rec)), serverRoot(created, ctxOf(created)));
    } catch (err) {
      // 複製檔案失敗就把剛建立的實例收回,別留下半殘的實例。
      store.remove(created.id);
      throw err;
    }
    track("instance_created");
    reply.code(201);
    return toSummary(created);
  });

  app.get("/api/instances/:id/stats", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const stats = await driverOf(rec).stats(rec, ctxOf(rec));
    if (!stats) return reply.code(409).send({ error: "server not running" });
    return stats;
  });

  app.get("/api/instances/:id/mods", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getModsStatus(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/mods/:component/install", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const component = z
      .enum(["ue4ss", "paldefender"])
      .parse((req.params as { component: string }).component);
    const { channel } = z
      .object({ channel: z.enum(["stable", "beta"]).default("stable") })
      .parse(req.body ?? {});
    // The mod DLLs are loaded by the running server; Windows locks them, so an
    // in-place overwrite fails. Require a stopped server for install/update.
    if (await isRunning(rec)) {
      return reply.code(409).send({ error: "請先停止伺服器再安裝或更新模組(執行中時檔案被鎖定無法覆寫)" });
    }
    const { version } = await installComponent(rec, ctxOf(rec), component, channel);
    return { installed: component, version, applied: "on-next-restart" };
  });

  app.post("/api/instances/:id/mods/:component/uninstall", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const component = z
      .enum(["ue4ss", "paldefender"])
      .parse((req.params as { component: string }).component);
    // Same lock issue as install: the DLLs are held by the running server.
    if (await isRunning(rec)) {
      return reply.code(409).send({ error: "請先停止伺服器再移除模組(執行中時檔案被鎖定無法刪除)" });
    }
    await removeComponent(rec, ctxOf(rec), component);
    return { removed: component };
  });

  app.post("/api/instances/:id/mods/lua-toggle", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const body = z.object({ name: z.string(), enabled: z.boolean() }).parse(req.body);
    setLuaModEnabled(rec, ctxOf(rec), body.name, body.enabled);
    return getModsStatus(rec, ctxOf(rec));
  });

  // ── live server control via the game's own REST API ──
  app.get("/api/instances/:id/live", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getLiveStatus(rec);
  });

  app.get("/api/instances/:id/paldefender-rest", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getPdRestStatus(rec, ctxOf(rec));
  });

  app.put("/api/instances/:id/paldefender-rest/enabled", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setPdRestEnabled(rec, ctxOf(rec), enabled);
    return { ...getPdRestStatus(rec, ctxOf(rec)), applied: "on-next-restart" };
  });

  app.post("/api/instances/:id/paldefender-rest/token", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { regenerate } = z.object({ regenerate: z.boolean().default(false) }).parse(req.body ?? {});
    const ok = await provisionPdToken(rec, ctxOf(rec), regenerate);
    return { ...getPdRestStatus(rec, ctxOf(rec)), hasToken: ok };
  });

  app.get("/api/instances/:id/players/:identifier/detail", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { identifier } = req.params as { identifier: string };
    return getPlayerDetail(rec, ctxOf(rec), identifier);
  });

  app.get("/api/instances/:id/players/known", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return presence.knownPlayers(rec.id);
  });

  app.get("/api/instances/:id/players/events", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    return presence.events(rec.id, limit);
  });

  // ── PalDefender whitelist & banlist ──
  app.get("/api/instances/:id/moderation", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getModerationLists(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/moderation/:action", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const action = z
      .enum(["whitelist_add", "whitelist_remove", "ban", "unban", "banip", "unbanip"])
      .parse((req.params as { action: string }).action);
    const body = z
      .object({ value: z.string().min(1).max(100), reason: z.string().max(200).optional() })
      .parse(req.body);
    switch (action) {
      case "whitelist_add": await moderation.whitelistAdd(rec, body.value); break;
      case "whitelist_remove": await moderation.whitelistRemove(rec, body.value); break;
      case "ban": await moderation.ban(rec, body.value, body.reason); break;
      case "unban": await moderation.unban(rec, body.value); break;
      case "banip": await moderation.banIp(rec, body.value); break;
      case "unbanip": await moderation.unbanIp(rec, body.value); break;
    }
    return { ok: true, action, value: body.value };
  });

  app.post("/api/instances/:id/announce", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { message } = z.object({ message: z.string().min(1).max(500) }).parse(req.body);
    await rest.announce(rec, message);
    return { announced: message };
  });

  app.post("/api/instances/:id/players/:userId/kick", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { userId } = req.params as { userId: string };
    const { message } = z.object({ message: z.string().max(500).optional() }).parse(req.body ?? {});
    await rest.kick(rec, userId, message);
    return { kicked: userId };
  });

  app.post("/api/instances/:id/players/:userId/ban", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { userId } = req.params as { userId: string };
    const { message } = z.object({ message: z.string().max(500).optional() }).parse(req.body ?? {});
    await rest.ban(rec, userId, message);
    return { banned: userId };
  });

  app.post("/api/instances/:id/players/:userId/unban", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { userId } = req.params as { userId: string };
    await rest.unban(rec, userId);
    return { unbanned: userId };
  });

  app.post("/api/instances/:id/save", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    await rest.save(rec);
    return { saved: true };
  });

  const LogSourceSchema = z.enum(["agent", "game", "paldefender"]);

  // ── RCON console ──
  app.get("/api/instances/:id/rcon/commands", async (req): Promise<RconCommandsResponse> => {
    const rec = getOr404((req.params as { id: string }).id);
    try {
      requireRcon(rec);
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        paldefender: false,
        commands: [],
      };
    }
    const hasPalDefender = getModsStatus(rec, ctxOf(rec)).paldefender.installed;
    // PalDefender knows exactly which commands this build accepts; prefer it
    // over our static list so plugin updates don't strand the UI.
    const live = hasPalDefender ? await fetchServerCommands(rec) : null;
    const commands = COMMANDS.filter((c) => {
      if (c.source === "builtin") return true;
      if (!hasPalDefender) return false;
      return live ? live.includes(c.name) : true;
    });
    return { available: true, paldefender: hasPalDefender, commands };
  });

  app.post("/api/instances/:id/rcon", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { command } = z.object({ command: z.string().min(1).max(500) }).parse(req.body);
    const output = await rconExec(rec, command);
    return { command, output };
  });

  // 自訂帕魯(贊助者先行版 custom-pal):PalDefender 範本 + RCON givepal_j。
  app.post("/api/instances/:id/pals/give", async (req, reply) => {
    if (!featureEnabled("custom-pal")) {
      return reply
        .code(403)
        .send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(409).send({ error: "自訂帕魯目前僅支援原生模式的實例" });
    }
    if (!getModsStatus(rec, ctxOf(rec)).paldefender.installed) {
      return reply.code(409).send({ error: "需要先安裝 PalDefender 才能發帕魯" });
    }
    requireRcon(rec);
    const input = CustomPalSchema.parse(req.body);
    const output = await giveCustomPal(rec, ctxOf(rec), input);
    return { output };
  });

  // ── PalDefender Config.json ──
  app.get("/api/instances/:id/paldefender-config", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getPalDefenderConfig(rec, ctxOf(rec));
  });

  app.put("/api/instances/:id/paldefender-config", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const shape = Object.fromEntries(
      Object.entries(PALDEFENDER_OPTIONS).map(([key, meta]) => {
        if (meta.type === "bool") return [key, z.boolean().optional()];
        const num = meta.type === "int" ? z.number().int() : z.number();
        return [key, num.min(meta.min).max(meta.max).optional()];
      }),
    );
    const patch = z.object(shape).strict().parse(req.body);
    const status = writePalDefenderConfig(rec, ctxOf(rec), patch as PalDefenderConfig);
    // Try to hot-apply without a restart; harmless if RCON is off.
    await rconExec(rec, "reloadcfg").catch(() => {});
    return { ...status, applied: "reloaded" };
  });

  // ── config-file health & regeneration ──
  app.get("/api/instances/:id/config-health", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getConfigHealth(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/config/regenerate", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { file } = z.object({ file: z.enum(["world", "engine"]) }).parse(req.body);
    if (await isRunning(rec)) {
      throw Object.assign(new Error("請先停止伺服器再重新生成設定檔"), { statusCode: 409 });
    }
    return regenerateConfig(rec, ctxOf(rec), file);
  });

  // ── Engine.ini performance settings ──
  app.get("/api/instances/:id/engine-settings", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getEngineSettings(rec, ctxOf(rec));
  });

  app.put("/api/instances/:id/engine-settings", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const shape = Object.fromEntries(
      Object.entries(ENGINE_OPTIONS).map(([key, meta]) => {
        if (meta.type === "bool") return [key, z.boolean().optional()];
        const num = meta.type === "int" ? z.number().int() : z.number();
        return [key, num.min(meta.min ?? -Infinity).max(meta.max ?? Infinity).optional()];
      }),
    );
    const patch = z.object(shape).strict().parse(req.body);
    const status = await writeEngineSettings(rec, ctxOf(rec), patch as EngineSettings);
    return { ...status, applied: "on-next-restart" };
  });

  // ── game version & updates ──
  app.get("/api/instances/:id/connection", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getConnectionInfo(rec.gamePort);
  });

  app.get("/api/instances/:id/version", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getVersionStatus(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/update", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(409).send({ error: "更新目前僅支援原生模式的實例" });
    }
    if ((await driverOf(rec).status(rec, ctxOf(rec))).status === "running") {
      return reply.code(409).send({ error: "請先停止伺服器再更新" });
    }
    if (isInstalling(rec.id)) {
      return reply.code(409).send({ error: "更新已在進行中" });
    }
    updateServer(rec, ctxOf(rec));
    reply.code(202);
    return { started: true, hint: "更新進度會顯示在日誌分頁(agent 來源)" };
  });

  // ── automatic restarts ──
  app.get("/api/instances/:id/restart-policy", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const ctx = ctxOf(rec);
    // native: full crash/memory/scheduled. k8s: scheduled only (STS handles
    // crash self-heal; no per-process memory stats). docker: unsupported.
    const supported = rec.backend !== "docker";
    const stats = supported ? await driverOf(rec).stats(rec, ctx) : null;
    return {
      supported,
      reason: supported ? undefined : "自動重啟目前不支援 Docker 模式的實例",
      policy: supervisor.readPolicy(rec.id),
      events: supervisor.events(rec.id),
      restartsLastHour: supervisor.restartsLastHour(rec.id),
      memoryMB: stats ? Math.round(stats.memoryBytes / (1 << 20)) : null,
    };
  });

  app.put("/api/instances/:id/restart-policy", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "時間格式須為 HH:MM");
    const policy = z
      .object({
        scheduled: z.object({
          enabled: z.boolean(),
          mode: z.enum(["interval", "daily"]),
          intervalMinutes: z.number().int().min(15).max(10080),
          dailyTimes: z.array(HHMM).max(12),
        }),
        memory: z.object({
          enabled: z.boolean(),
          thresholdMB: z.number().int().min(512).max(262144),
          sustainedChecks: z.number().int().min(1).max(20),
        }),
        crash: z.object({
          enabled: z.boolean(),
          maxPerHour: z.number().int().min(1).max(20),
        }),
        announceSeconds: z.number().int().min(0).max(300),
      })
      .parse(req.body);
    return supervisor.writePolicy(rec.id, policy);
  });

  // ── world saves & backups ──
  const isRunning = async (rec: InstanceRecord) =>
    (await driverOf(rec).status(rec, ctxOf(rec))).status === "running";

  app.get("/api/instances/:id/saves", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return { ...(await saves.getSavesStatus(rec, ctxOf(rec))), schedule: scheduler.read(rec.id) };
  });

  app.put("/api/instances/:id/saves/schedule", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(5).max(1440).optional(),
        keep: z.number().int().min(1).max(100).optional(),
        skipWhenEmpty: z.boolean().optional(),
      })
      .parse(req.body);
    return scheduler.update(rec.id, patch);
  });

  /** Run the scheduled backup right now (same code path as the timer). */
  app.post("/api/instances/:id/saves/schedule/run", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return scheduler.runFor(rec);
  });

  app.post("/api/instances/:id/saves/backup", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { worldGuid } = z.object({ worldGuid: z.string().min(1).max(64) }).parse(req.body);
    reply.code(201);
    return saves.createBackup(rec, ctxOf(rec), worldGuid);
  });

  app.post("/api/instances/:id/saves/restore", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { backup } = z.object({ backup: z.string().min(1).max(200) }).parse(req.body);
    return saves.restoreBackup(rec, ctxOf(rec), backup, await isRunning(rec));
  });

  app.delete("/api/instances/:id/saves/backup", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.query);
    saves.deleteBackup(ctxOf(rec), name);
    reply.code(204);
  });

  app.get("/api/instances/:id/saves/backup/download", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.query);
    const file = saves.backupPath(ctxOf(rec), name);
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${path.basename(file)}"`);
    return fs.createReadStream(file);
  });

  app.post("/api/instances/:id/saves/active", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { worldGuid } = z.object({ worldGuid: z.string().min(1).max(64) }).parse(req.body);
    const running = await isRunning(rec);
    // native edits the ini on the host (server must be stopped); k8s writes it
    // inside the running Pod via exec (server must be up so a Pod exists).
    if (rec.backend === "native" && running) {
      throw Object.assign(new Error("請先停止伺服器再切換世界"), { statusCode: 409 });
    }
    if (rec.backend === "k8s" && !running) {
      throw Object.assign(new Error("k8s 切換世界需伺服器運行中(以存取 Pod)"), { statusCode: 409 });
    }
    await saves.setActiveWorldGuidBackend(rec, ctxOf(rec), worldGuid);
    return { active: worldGuid, applied: "on-next-start" };
  });

  app.delete("/api/instances/:id/saves/player", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { worldGuid, file } = z
      .object({ worldGuid: z.string().min(1).max(64), file: z.string().min(1).max(100) })
      .parse(req.query);
    await saves.deletePlayerSave(rec, ctxOf(rec), worldGuid, file, await isRunning(rec));
    reply.code(204);
  });

  // ── file browser (native instances; confined to the server directory) ──
  const PathQuery = z.object({ path: z.string().max(500).default("") });

  app.get("/api/instances/:id/files", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = PathQuery.parse(req.query);
    return { path: rel, entries: files.listDir(files.fileRoot(rec, ctxOf(rec)), rel) };
  });

  app.get("/api/instances/:id/files/content", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = PathQuery.parse(req.query);
    return files.readFile(files.fileRoot(rec, ctxOf(rec)), rel);
  });

  app.put("/api/instances/:id/files/content", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const body = z.object({ path: z.string().max(500), content: z.string() }).parse(req.body);
    files.writeFile(files.fileRoot(rec, ctxOf(rec)), body.path, body.content);
    return { saved: body.path, applied: "on-next-restart" };
  });

  app.post("/api/instances/:id/files/dir", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const body = z.object({ path: z.string().min(1).max(500) }).parse(req.body);
    files.makeDir(files.fileRoot(rec, ctxOf(rec)), body.path);
    reply.code(201);
    return { created: body.path };
  });

  app.delete("/api/instances/:id/files", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = z.object({ path: z.string().min(1).max(500) }).parse(req.query);
    files.deletePath(files.fileRoot(rec, ctxOf(rec)), rel);
    reply.code(204);
  });

  // Raw body upload: `PUT /files/upload?path=Mods/foo.pak` with the file bytes.
  // Streamed to disk so multi-hundred-MB pak mods don't buffer in memory.
  app.put("/api/instances/:id/files/upload", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = z.object({ path: z.string().min(1).max(500) }).parse(req.query);
    const target = files.uploadTarget(files.fileRoot(rec, ctxOf(rec)), rel);
    await pipeline(req.raw, fs.createWriteStream(target));
    reply.code(201);
    return { uploaded: rel, size: fs.statSync(target).size };
  });

  app.get("/api/instances/:id/logs/sources", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return driverOf(rec).logSources(rec, ctxOf(rec));
  });

  app.get("/api/instances/:id/logs", { websocket: true }, (socket, req) => {
    const rec = store.get((req.params as { id: string }).id);
    if (!rec) {
      socket.close(4004, "instance not found");
      return;
    }
    const source = LogSourceSchema.catch("agent").parse(
      (req.query as { source?: string }).source,
    );
    let cleanup: (() => void) | null = null;
    driverOf(rec)
      .streamLogs(
        rec,
        ctxOf(rec),
        (line) => socket.send(line),
        () => socket.close(1000, "log stream ended"),
        source,
      )
      .then((stop) => {
        cleanup = stop;
        if (socket.readyState !== socket.OPEN) stop();
      })
      .catch((err: Error) => socket.close(1011, err.message.slice(0, 120)));
    socket.on("close", () => cleanup?.());
  });
}
