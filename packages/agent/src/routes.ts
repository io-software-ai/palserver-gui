import type { FastifyInstance } from "fastify";
import {
  COMMANDS,
  ENGINE_OPTIONS,
  LAUNCH_OPTIONS,
  LAUNCH_OPTION_KEYS,
  type LaunchOptions,
  PALDEFENDER_OPTIONS,
  PD_MOTD_MAX_LEN,
  PD_MOTD_MAX_LINES,
  PAL_STAT_KEYS,
  PAL_STAT_OPTIONS,
  type EngineSettings,
  type PalDefenderConfigPatch,
  type PalStatValues,
  CreateInstanceSchema,
  CustomPalSchema,
  UpdateSettingsSchema,
  WorldSettingsSchema,
  detectVpn,
  type AgentInfo,
  type InstanceDetail,
  type InstanceSummary,
  type KnownPlayer,
  type RconCommandsResponse,
} from "@palserver/shared";
import { fetchServerCommands, rconExec, requireRcon } from "./rcon.js";
import type { PresenceTracker } from "./presence.js";
import type { BackupScheduler } from "./backup-scheduler.js";
import type { RestartSupervisor } from "./supervisor.js";
import { AGENT_VERSION, PORT, HOST, REQUIRE_TOKEN, WEB_ORIGINS, TLS_ENABLED, OPEN_BROWSER, ENV_LOCKED, IS_PORTABLE_EXE } from "./env.js";
import { saveSettings } from "./settings.js";
import { restartSelf } from "./self-update.js";
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
import { SERVER_LAUNCHER, classifyServerDir, detectManualIniEdits, installProgressOf, isInstalling, lastInstallError, moveServerFiles, nativeDriver, serverRoot, updateServer } from "./native.js";
import { cachedVersionSummary, getVersionStatus } from "./version.js";
import { getConnectionInfo } from "./connectivity.js";
import { getModsStatus, installComponent, installedEnhancements, removeComponent, setLuaModEnabled } from "./mods.js";
import * as pakMods from "./pak-mods.js";
import { clearPalStats, getPalSchemaStatus, getPalStats, installPalSchema, removePalSchema, writePalStats } from "./palschema.js";
import { getModerationLists, moderation } from "./moderation.js";
import { getLiveStatus, rest } from "./restapi.js";
import * as files from "./files.js";
import {
  deletePathInPodBrowser,
  listDirInPodBrowser,
  makeDirInPodBrowser,
  readFileInPodBrowser,
  uploadFileInPodBrowser,
  writeFileInPodBrowser,
} from "./k8s-file-browser.js";
import * as saves from "./saves.js";
import { applyHostFix } from "./host-save-fix.js";
import { getEngineSettings, writeEngineSettings } from "./engine-ini.js";
import { getConfigHealth, regenerateConfig } from "./config-health.js";
import {
  configSnapshotPath,
  createConfigSnapshot,
  listConfigSnapshots,
  readConfigSnapshot,
  restoreConfigSnapshot,
} from "./config-backup.js";
import { getPalDefenderConfig, writePalDefenderConfig } from "./paldefender-config.js";
import { getPlayerDetail, getPdPlayers, getPdGuilds, getPdGuild, getPdRestStatus, setPdRestEnabled, setPdRestPort, provisionPdToken } from "./paldefender-rest.js";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 剩餘幾秒時各發一則倒數公告(頭尾密、中段疏);總秒數本身一定會發第一則。 */
const COUNTDOWN_MARKS = [60, 30, 20, 10, 5, 3, 2, 1];

/**
 * 手動停止/重啟前,在遊戲聊天室倒數公告再執行。訊息用呼叫端(GUI)傳來的在地化模板,
 * `{n}` 由這裡代入剩餘秒數;公告走伺服器 REST,REST 沒開就直接跳過(不空等)。
 */
async function announceCountdown(rec: InstanceRecord, seconds: number, template: string): Promise<void> {
  const say = (n: number) => rest.announce(rec, template.split("{n}").join(String(n)));
  const marks = [seconds, ...COUNTDOWN_MARKS.filter((m) => m < seconds)];
  try {
    await say(marks[0]); // 先發第一則,順便確認 REST 可用
  } catch {
    return; // REST 未啟用 — 無法公告,直接執行,不空等
  }
  for (let i = 0; i < marks.length; i++) {
    if (i > 0) await say(marks[i]).catch(() => {});
    const next = marks[i + 1] ?? 0;
    await sleep((marks[i] - next) * 1000);
  }
}

const AnnounceBody = z.object({ announceTemplate: z.string().max(500).optional() });

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
  const snapshotBefore = async (rec: InstanceRecord, reason: string): Promise<void> => {
    if (rec.backend === "docker") return;
    try {
      await createConfigSnapshot(rec, ctxOf(rec), reason);
    } catch (error) {
      throw Object.assign(
        new Error(`設定快照失敗，已取消操作：${error instanceof Error ? error.message : String(error)}`),
        { statusCode: 409 },
      );
    }
  };
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
      installProgress: rec.backend === "native" ? installProgressOf(rec.id) : null,
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
      // docker 在 Unix 系統（Linux/macOS）提供；Windows WSL2 的 UDP 不可靠，
      // 不能跑遊戲伺服器。所有平台都可管理遠端 k8s 實例。
      availableBackends:
        process.platform !== "win32" && dockerVersion !== "unavailable"
          ? ["native", "docker", "k8s"]
          : ["native", "k8s"],
    };
  });

  // GUI 自我更新(對接 GitHub Releases)。?force=1 略過 6 小時的檢查快取。
  app.get("/api/update", async (req) => {
    const force = (req.query as { force?: string }).force === "1";
    return getUpdateStatus(force);
  });

  // 日誌翻譯(贊助者功能 log-tools)。套不了版的英文行走這裡翻成使用者語言。放 agent 端打
  // (server-side)避開瀏覽器 CORS、免自備 API key;結果記憶體快取,同句不重複。
  // 批次:多行用「換行合併」一次送 Google(它會保留 \n,可切回各行),大幅減少往返 → 即時感。
  const translateCache = new Map<string, string>();
  /** 呼叫 Google 免金鑰端點,回傳整段譯文(可含 \n)。 */
  async function gtranslate(text: string, tl: string): Promise<string> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    const rows = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
    return rows.map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
  }
  app.post("/api/translate", async (req) => {
    if (translateCache.size > 8000) translateCache.clear();
    const body = (req.body ?? {}) as { q?: unknown; tl?: unknown };
    const texts = Array.isArray(body.q) ? body.q.filter((x): x is string => typeof x === "string").slice(0, 800) : [];
    const target = (typeof body.tl === "string" ? body.tl : "en").replace(/[^a-zA-Z-]/g, "").slice(0, 8) || "en";
    const keyOf = (s: string) => `${target}\n${s}`;
    // 收集未快取、去重、非空的句子。
    const need: string[] = [];
    const seen = new Set<string>();
    for (const s of texts) {
      if (!s.trim() || translateCache.has(keyOf(s)) || seen.has(s)) continue;
      seen.add(s);
      need.push(s);
    }
    // 依字元預算切塊(避免 URL 過長),每塊用換行合併一次翻;行數對不上就退回逐句。
    const chunks: string[][] = [];
    let cur: string[] = [];
    let curLen = 0;
    for (const s of need) {
      if (cur.length && curLen + s.length > 1200) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(s);
      curLen += s.length + 1;
    }
    if (cur.length) chunks.push(cur);
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const joined = await gtranslate(chunk.join("\n"), target);
          const parts = joined.split("\n");
          if (parts.length === chunk.length) {
            chunk.forEach((s, j) => translateCache.set(keyOf(s), parts[j]));
          } else {
            await Promise.all(
              chunk.map(async (s) => {
                try {
                  translateCache.set(keyOf(s), await gtranslate(s, target));
                } catch {
                  /* 單句失敗略過 */
                }
              }),
            );
          }
        } catch {
          /* 整塊失敗略過 */
        }
      }),
    );
    // 從快取組回(順序對應輸入;沒翻到的維持空字串)。
    return { texts: texts.map((s) => translateCache.get(keyOf(s)) ?? "") };
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

  // 系統 / 網路設定:可從面板改,寫進 data-dir/settings.json,重啟 agent 後生效。
  // 每欄 envLocked=true 表示被環境變數鎖定(env > settings.json),面板顯示為灰化不可改。
  app.get("/api/settings", async () => ({
    requireToken: { value: REQUIRE_TOKEN, envLocked: ENV_LOCKED.requireToken },
    tls: { value: TLS_ENABLED, envLocked: ENV_LOCKED.tls },
    agentPort: { value: PORT, envLocked: ENV_LOCKED.agentPort },
    agentHost: { value: HOST, envLocked: ENV_LOCKED.agentHost },
    webOrigins: { value: WEB_ORIGINS.join(","), envLocked: ENV_LOCKED.webOrigins },
    autoOpenBrowser: { value: OPEN_BROWSER, envLocked: ENV_LOCKED.autoOpenBrowser },
    canRestart: IS_PORTABLE_EXE,
  }));
  app.put("/api/settings", async (req) => {
    const b = z
      .object({
        requireToken: z.boolean().optional(),
        tls: z.boolean().optional(),
        agentPort: z.number().int().min(1).max(65535).optional(),
        agentHost: z.string().max(64).optional(),
        webOrigins: z.string().max(2000).optional(),
        autoOpenBrowser: z.boolean().optional(),
      })
      .parse(req.body);
    saveSettings(b);
    return { ok: true };
  });
  // 套用系統設定:重啟自己(免安裝執行檔才會真的重啟;開發模式回 restarting:false)。
  app.post("/api/restart", async () => {
    if (IS_PORTABLE_EXE) {
      setTimeout(() => {
        void app.close().catch(() => {});
        restartSelf();
      }, 400);
    }
    return { restarting: IS_PORTABLE_EXE };
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
    const portTaken = input.backend !== "k8s" && store.list().some((r) => r.gamePort === input.gamePort);
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
    if (input.backend === "k8s") {
      const dnsLabel = (value: string | undefined, label: string): string | null => {
        const trimmed = value?.trim() ?? "";
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(trimmed) || trimmed.length > 63) {
          return `${label} 必須是有效的 Kubernetes DNS label`;
        }
        return null;
      };
      for (const [value, label] of [
        [input.k8sNamespace, "k8sNamespace"],
        [input.k8sStatefulSet, "k8sStatefulSet"],
        [input.k8sServiceName, "k8sServiceName"],
      ] as const) {
        const error = dnsLabel(value, label);
        if (error) return reply.code(400).send({ error });
      }
    }
    const settings = WorldSettingsSchema.parse({
      ServerName: input.name,
      PublicPort: input.gamePort,
      ...input.settings,
    });
    // k8s: 若 game-server 已運行且有實際 PalWorldSettings.ini，
    // 從 INI 同步 settings 到 store，避免用預設值覆蓋伺服器實際設定。
    if (input.backend === "k8s") {
      try {
        const { readFileInPod } = await import("./k8s-files.js");
        const { parsePalWorldSettingsIni } = await import("./settings-ini.js");
        const tempRec = {
          id: "sync",
          name: input.name,
          backend: "k8s" as const,
          flavor: input.flavor,
          gamePort: input.gamePort,
          settings,
          createdAt: new Date().toISOString(),
          k8sNamespace: input.k8sNamespace,
          k8sStatefulSet: input.k8sStatefulSet,
          k8sServiceName: input.k8sServiceName,
        } as InstanceRecord;
        const ini = await readFileInPod(tempRec, "Pal/Saved/Config/LinuxServer/PalWorldSettings.ini");
        const synced = parsePalWorldSettingsIni(ini);
        Object.assign(settings, synced);
      } catch {
        // game-server 未運行或 INI 不存在 — 用 caller 帶入的 settings
      }
    }
    const rec = store.create({
      name: input.name,
      backend: input.backend,
      flavor: input.flavor,
      gamePort: input.gamePort,
      queryPort: store.nextQueryPort(),
      dockerImage: input.backend === "docker" ? input.dockerImage?.trim() || undefined : undefined,
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
    const nextSettings = WorldSettingsSchema.parse({ ...rec.settings, ...patch });
    await snapshotBefore(rec, "world settings update");
    // The driver re-renders the ini on every start; pre-render for docker so
    // the bind-mounted config is already in place.
    if (rec.backend === "docker") {
      const updated = store.update(rec.id, { settings: nextSettings });
      dockerOps.writeConfig(store.instanceDir(rec.id), updated.settings);
      return { applied: "on-next-restart", settings: updated.settings };
    }
    // k8s: the game-server image reads settings from env, not ini. PATCH the
    // StatefulSet env in place; the Pod rolls and picks up the new values.
    // `restartTriggered` signals the UI that the change is already live.
    if (rec.backend === "k8s") {
      const { applyEnvPatchK8s } = await import("./k8s-env-patch.js");
      const result = await applyEnvPatchK8s(rec, patch);
      const appliedSettings = Object.fromEntries(
        Object.entries(patch).filter(([key]) => !result.unsupported.includes(key)),
      );
      const updated = store.update(rec.id, {
        settings: WorldSettingsSchema.parse({ ...rec.settings, ...appliedSettings }),
      });
      return {
        applied: "env-patched",
        settings: updated.settings,
        restartTriggered: true,
        unsupportedKeys: result.unsupported.length > 0 ? result.unsupported : undefined,
      };
    }
    const updated = store.update(rec.id, { settings: nextSettings });
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

  // native:啟動前把使用者對 PalWorldSettings.ini 的手動編輯併回 store,否則會被開機時的
  // 重寫蓋掉。回傳(可能已更新的)rec。docker/k8s 由各自流程處理,原樣返回。
  const reconcileWorldIni = (rec: InstanceRecord): InstanceRecord => {
    if (rec.backend !== "native") return rec;
    const patch = detectManualIniEdits(rec, ctxOf(rec));
    if (Object.keys(patch).length === 0) return rec;
    return store.update(rec.id, {
      settings: WorldSettingsSchema.parse({ ...rec.settings, ...patch }),
    });
  };

  app.post("/api/instances/:id/start", async (req) => {
    const rec = reconcileWorldIni(getOr404((req.params as { id: string }).id));
    await driverOf(rec).start(rec, ctxOf(rec));
    supervisor.noteManualState(rec.id, true);
    track("server_started");
    return toSummary(rec);
  });

  /** 停止/重啟前若帶了 announceTemplate 且伺服器在跑,依該實例的 announceSeconds 設定
   * 先在遊戲聊天室倒數公告(0 秒 = 不公告)。announceSeconds 與自動重啟共用同一個設定。 */
  const announceBeforeDowntime = async (rec: InstanceRecord, body: unknown): Promise<void> => {
    const template = AnnounceBody.safeParse(body ?? {}).data?.announceTemplate;
    if (!template) return;
    const seconds = Math.min(Math.max(supervisor.readPolicy(rec.id).announceSeconds, 0), 300);
    if (seconds <= 0) return;
    if ((await driverOf(rec).status(rec, ctxOf(rec))).status !== "running") return;
    await announceCountdown(rec, seconds, template);
  };

  app.post("/api/instances/:id/stop", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    await announceBeforeDowntime(rec, req.body);
    await driverOf(rec).stop(rec, ctxOf(rec));
    presence.markAllOffline(rec.id);
    // A deliberate stop must not look like a crash to the supervisor.
    supervisor.noteManualState(rec.id, false);
    return toSummary(rec);
  });

  app.post("/api/instances/:id/restart", async (req) => {
    let rec = getOr404((req.params as { id: string }).id);
    await announceBeforeDowntime(rec, req.body);
    await driverOf(rec).stop(rec, ctxOf(rec));
    presence.markAllOffline(rec.id);
    rec = reconcileWorldIni(rec);
    await driverOf(rec).start(rec, ctxOf(rec));
    supervisor.noteManualState(rec.id, true);
    track("server_started");
    return toSummary(rec);
  });

  app.delete("/api/instances/:id", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    // 真正刪除。driver.remove 負責各後端的收尾:停止行程 / 移除容器 / 刪除 agent
    // 自行安裝的外部目錄(native)。k8s 只縮到 0、刻意保留叢集 PVC(那不是我們建的)。
    await driverOf(rec).remove(rec, ctxOf(rec));
    // agent 自管的資料根目錄(native 安裝+存檔、docker 綁定掛載資料、pid/log)一併刪掉。
    // 對 k8s 這個目錄通常是空的,force 會忽略不存在。
    fs.rmSync(store.instanceDir(rec.id), { recursive: true, force: true });
    store.remove(rec.id);
    reply.code(204);
  });

  /** 匯出成 tar.gz 下載:存檔 + ini 設定 + PalDefender 設定,不含可重下的遊戲執行檔。
   *  瀏覽器直接開這個網址下載(token 走 query,見 auth)。目前僅 native。 */
  app.get("/api/instances/:id/export", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend === "k8s") {
      return reply.code(400).send({ error: "export 請透過鏡像遷移功能(k8s 走 Pod exec)" });
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
    if (rec.backend === "k8s") {
      return reply.code(400).send({ error: "duplicate 請透過鏡像遷移功能(k8s)" });
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
    // 新實例沿用來源的 backend（native 走 host FS，docker 走 bind-mount）。
    const created = store.create({
      name,
      backend: rec.backend,
      flavor: rec.flavor,
      gamePort,
      queryPort: store.nextQueryPort(),
      settings,
    });
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

  // ── pak mods (跨平台：native/docker/k8s 皆可，UE 引擎原生載入) ──
  app.get("/api/instances/:id/pak-mods", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const mods = await pakMods.listPakMods(rec, ctxOf(rec));
    return { mods };
  });

  app.post("/api/instances/:id/pak-mods/toggle", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name, enabled } = z.object({ name: z.string(), enabled: z.boolean() }).parse(req.body);
    await pakMods.setPakModEnabled(rec, ctxOf(rec), name, enabled);
    return { toggled: name, enabled };
  });

  app.delete("/api/instances/:id/pak-mods", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name } = z.object({ name: z.string() }).parse(req.query);
    await pakMods.removePakMod(rec, ctxOf(rec), name);
    reply.code(204);
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

  app.get("/api/instances/:id/paldefender-players", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getPdPlayers(rec, ctxOf(rec));
  });

  app.get("/api/instances/:id/guilds", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    // 據點位置人人可見;名稱/成員等細節是贊助者先行版功能(guild-map)。
    return getPdGuilds(rec, ctxOf(rec), featureEnabled("guild-map"));
  });

  app.get("/api/instances/:id/guilds/:guildId", async (req, reply) => {
    if (!featureEnabled("guild-map")) {
      return reply.code(403).send({ error: "公會詳情為贊助者先行版功能,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const { id, guildId } = req.params as { id: string; guildId: string };
    const rec = getOr404(id);
    return getPdGuild(rec, ctxOf(rec), guildId);
  });

  app.put("/api/instances/:id/paldefender-rest/enabled", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setPdRestEnabled(rec, ctxOf(rec), enabled);
    return { ...getPdRestStatus(rec, ctxOf(rec)), applied: "on-next-restart" };
  });

  app.put("/api/instances/:id/paldefender-rest/port", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { port } = z.object({ port: z.number().int().min(1024).max(65535) }).parse(req.body);
    setPdRestPort(rec, ctxOf(rec), port);
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

  // 統一名冊:有開 PalDefender REST 就以它的 /players 為準(1.8+ 含離線玩家),
  // 用 agent 自己的紀錄補歷史欄位(首見/上線時長/等級);沒開就純用自己的紀錄。
  // PalDefender 沒列到、但自己看過的玩家也保留(舊版 PalDefender 只回在線時的兜底)。
  app.get("/api/instances/:id/players/known", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const own = presence.knownPlayers(rec.id);
    const pd = await getPdPlayers(rec, ctxOf(rec));
    if (!pd.available) return own;
    const byId = new Map(own.map((p) => [p.userId, p]));
    const merged: KnownPlayer[] = pd.players.map((p) => {
      const prev = byId.get(p.userId);
      byId.delete(p.userId);
      return {
        userId: p.userId,
        name: p.name || prev?.name || "",
        accountName: prev?.accountName ?? "",
        online: p.online,
        firstSeen: prev?.firstSeen ?? "",
        lastSeen: prev?.lastSeen ?? "",
        sessions: prev?.sessions ?? 0,
        playtimeSeconds: prev?.playtimeSeconds ?? 0,
        lastLevel: prev?.lastLevel ?? 0,
        ...(p.guildName ? { guildName: p.guildName } : {}),
      };
    });
    for (const leftover of byId.values()) merged.push(leftover);
    return merged;
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

  // 批量給予道具(贊助者先行版 bulk-items):PalDefender RCON `giveitems`。
  app.post("/api/instances/:id/items/give", async (req, reply) => {
    if (!featureEnabled("bulk-items")) {
      return reply
        .code(403)
        .send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(409).send({ error: "批量給予道具目前僅支援原生模式的實例" });
    }
    if (!getModsStatus(rec, ctxOf(rec)).paldefender.installed) {
      return reply.code(409).send({ error: "需要先安裝 PalDefender 才能發道具" });
    }
    requireRcon(rec);
    const { userId, items } = z
      .object({
        userId: z.string().trim().min(1).max(128),
        items: z
          .array(
            z.object({
              itemId: z.string().trim().regex(/^[A-Za-z0-9_]+$/).max(64),
              amount: z.number().int().min(1).max(99999),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(req.body);
    // PalDefender giveitems <UserId> item1:qty1 item2:qty2 …
    const list = items.map((i) => `${i.itemId}:${i.amount}`).join(" ");
    const output = await rconExec(rec, `giveitems ${userId} ${list}`);
    return { output };
  });

  // 傳送玩家(贊助者先行版 teleport):PalDefender `tp <來源> <目標玩家|x y z>`。
  app.post("/api/instances/:id/teleport", async (req, reply) => {
    if (!featureEnabled("teleport")) {
      return reply
        .code(403)
        .send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    if (rec.backend !== "native") {
      return reply.code(409).send({ error: "傳送玩家目前僅支援原生模式的實例" });
    }
    if (!getModsStatus(rec, ctxOf(rec)).paldefender.installed) {
      return reply.code(409).send({ error: "需要先安裝 PalDefender 才能使用傳送" });
    }
    requireRcon(rec);
    const { source, target } = z
      .object({
        source: z.string().trim().regex(/^[A-Za-z0-9_]+$/).max(128),
        // 目標:玩家 UserId 或座標「x y [z]」(允許數字、負號、小數、空白)。
        target: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.\- ]+$/),
      })
      .parse(req.body);
    const output = await rconExec(rec, `tp ${source} ${target}`);
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
    const patch = z
      .object({
        ...shape,
        motd: z.array(z.string().max(PD_MOTD_MAX_LEN)).max(PD_MOTD_MAX_LINES).optional(),
      })
      .strict()
      .parse(req.body);
    const status = writePalDefenderConfig(rec, ctxOf(rec), patch as PalDefenderConfigPatch);
    // Try to hot-apply without a restart; harmless if RCON is off.
    await rconExec(rec, "reloadcfg").catch(() => {});
    return { ...status, applied: "reloaded" };
  });

  // ── PalSchema:物種數值編輯器(贊助者先行版 pal-stats)──
  app.get("/api/instances/:id/palschema", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getPalSchemaStatus(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/palschema/install", async (req, reply) => {
    if (!featureEnabled("pal-stats")) {
      return reply.code(403).send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    // 同 mods:執行中 DLL 被鎖,無法覆寫/建立。
    if (await isRunning(rec)) {
      return reply.code(409).send({ error: "請先停止伺服器再安裝 PalSchema(執行中時檔案被鎖定)" });
    }
    const { version } = await installPalSchema(rec, ctxOf(rec));
    return { installed: "palschema", version, applied: "on-next-restart" };
  });

  app.post("/api/instances/:id/palschema/uninstall", async (req, reply) => {
    if (!featureEnabled("pal-stats")) {
      return reply.code(403).send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    if (await isRunning(rec)) {
      return reply.code(409).send({ error: "請先停止伺服器再移除 PalSchema(執行中時檔案被鎖定)" });
    }
    removePalSchema(rec, ctxOf(rec));
    return { removed: "palschema" };
  });

  app.get("/api/instances/:id/pal-stats", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getPalStats(rec, ctxOf(rec));
  });

  app.put("/api/instances/:id/pal-stats", async (req, reply) => {
    if (!featureEnabled("pal-stats")) {
      return reply.code(403).send({ error: "此功能為贊助者先行版,請在設定頁輸入贊助者識別碼解鎖。" });
    }
    const rec = getOr404((req.params as { id: string }).id);
    const valueShape = Object.fromEntries(
      PAL_STAT_KEYS.map((k) => {
        const meta = PAL_STAT_OPTIONS[k];
        const num = meta.type === "int" ? z.number().int() : z.number();
        return [k, num.min(meta.min).max(meta.max).optional()];
      }),
    );
    const body = z
      .object({ row: z.string().regex(/^[A-Za-z0-9_]{1,80}$/), values: z.object(valueShape).strict() })
      .parse(req.body);
    // 改動寫進 PalSchema mod 檔,伺服器重啟後生效(不即時)。
    return writePalStats(rec, ctxOf(rec), body.row, body.values as PalStatValues);
  });

  // 清空所有物種數值調整。刻意「不」做贊助者 gate:贊助到期的使用者也要能改回原設定。
  app.delete("/api/instances/:id/pal-stats", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return clearPalStats(rec, ctxOf(rec));
  });

  // ── config-file health & regeneration ──
  app.get("/api/instances/:id/config-health", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return getConfigHealth(rec, ctxOf(rec));
  });

  app.post("/api/instances/:id/config/regenerate", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { file } = z.object({ file: z.enum(["world", "engine"]) }).parse(req.body);
    const running = await isRunning(rec);
    if ((rec.backend === "native" && running) || (rec.backend === "k8s" && !running)) {
      throw Object.assign(
        new Error(rec.backend === "k8s" ? "k8s 重建設定需伺服器運行中" : "請先停止伺服器再重新生成設定檔"),
        { statusCode: 409 },
      );
    }
    await snapshotBefore(rec, `regenerate ${file}`);
    return regenerateConfig(rec, ctxOf(rec), file);
  });

  // ── INI configuration snapshots ──
  app.get("/api/instances/:id/config-backups", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return listConfigSnapshots(ctxOf(rec));
  });

  app.post("/api/instances/:id/config-backups", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { reason } = z.object({ reason: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const result = await createConfigSnapshot(rec, ctxOf(rec), reason ?? "manual");
    reply.code(201);
    return result;
  });

  app.get("/api/instances/:id/config-backups/download", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.query);
    const snapshot = readConfigSnapshot(ctxOf(rec), name);
    if (snapshot.metadata.instanceId !== rec.id) {
      throw Object.assign(new Error("設定快照不屬於此實例"), { statusCode: 404 });
    }
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${snapshot.id}.json"`);
    return fs.createReadStream(configSnapshotPath(ctxOf(rec), snapshot.id));
  });

  app.post("/api/instances/:id/config-backups/restore", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    const running = await isRunning(rec);
    if ((rec.backend === "native" && running) || (rec.backend === "k8s" && !running)) {
      throw Object.assign(new Error(rec.backend === "k8s" ? "k8s 還原設定需伺服器運行中" : "請先停止伺服器再還原設定"), { statusCode: 409 });
    }
    return restoreConfigSnapshot(rec, ctxOf(rec), name);
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
    await snapshotBefore(rec, "engine settings update");
    const { status, engineSettings } = await writeEngineSettings(rec, ctxOf(rec), patch as EngineSettings);
    // store 是權威來源:每次啟動前會把它合併回 Engine.ini(伺服器關機會重寫該檔)。
    store.update(rec.id, { engineSettings });
    return { ...status, applied: "on-next-restart" };
  });

  // ── 命令列啟動參數(launch options)+ Steam 查詢埠 ──
  app.get("/api/instances/:id/launch-options", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    return { launchOptions: rec.launchOptions ?? {}, queryPort: rec.queryPort ?? null };
  });

  app.put("/api/instances/:id/launch-options", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const loShape = Object.fromEntries(
      LAUNCH_OPTION_KEYS.map((k) => {
        const meta = LAUNCH_OPTIONS[k];
        if (meta.type === "bool") return [k, z.boolean().optional()];
        if (meta.type === "int") {
          return [k, z.number().int().min(meta.min ?? 0).max(meta.max ?? 1_000_000).optional()];
        }
        return [k, z.enum(meta.choices as unknown as [string, ...string[]]).optional()];
      }),
    );
    const body = z
      .object({
        launchOptions: z.object(loShape).strict().optional(),
        queryPort: z.number().int().min(1024).max(65535).nullable().optional(),
      })
      .parse(req.body);

    const patch: { launchOptions?: LaunchOptions; queryPort?: number } = {};
    if (body.launchOptions) {
      patch.launchOptions = { ...(rec.launchOptions ?? {}), ...(body.launchOptions as LaunchOptions) };
    }
    if (body.queryPort !== undefined) {
      if (body.queryPort !== null) {
        const clash = store.list().some((r) => r.id !== rec.id && r.queryPort === body.queryPort);
        if (clash) {
          return reply.code(409).send({ error: `Steam 查詢埠 ${body.queryPort} 已被其他伺服器使用` });
        }
      }
      patch.queryPort = body.queryPort ?? undefined;
    }
    store.update(rec.id, patch);
    const updated = store.get(rec.id)!;
    if (updated.backend === "k8s") {
      const { applyLaunchOptionsK8s } = await import("./k8s-env-patch.js");
      await applyLaunchOptionsK8s(updated, updated.launchOptions, updated.queryPort).catch(() => {});
    }
    return {
      launchOptions: updated.launchOptions ?? {},
      queryPort: updated.queryPort ?? null,
      applied: "on-next-restart",
    };
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

    if (rec.backend === "native") {
      if ((await driverOf(rec).status(rec, ctxOf(rec))).status === "running") {
        return reply.code(409).send({ error: "請先停止伺服器再更新" });
      }
      if (isInstalling(rec.id)) {
        return reply.code(409).send({ error: "更新已在進行中" });
      }
      await snapshotBefore(rec, "server update");
      updateServer(rec, ctxOf(rec));
      reply.code(202);
      return { started: true, hint: "更新進度會顯示在日誌分頁(agent 來源)" };
    }

    if (rec.backend === "docker") {
      try {
        const image = await dockerOps.updateImage(rec, store.instanceDir(rec.id));
        return { started: true, image, hint: "已拉取最新映像檔並重建容器" };
      } catch (err) {
        return reply.code(409).send({ error: `映像檔更新失敗：${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (rec.backend === "k8s") {
      const { rolloutRestart } = await import("./k8s.js");
      try {
        await rolloutRestart(rec);
        return { started: true, hint: "已觸發滾動重啟,Pod 會重建並拉取最新映像檔" };
      } catch (err) {
        return reply.code(409).send({ error: `滾動重啟失敗：${err instanceof Error ? err.message : String(err)}` });
      }
    }

    return reply.code(409).send({ error: "不支援的後端" });
  });

  // ── automatic restarts ──
  app.get("/api/instances/:id/restart-policy", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const ctx = ctxOf(rec);
    // native: full crash/memory/scheduled. docker: scheduled + memory only
    // (crash handled by unless-stopped policy). k8s: scheduled only.
    const supported = true;
    const stats = await driverOf(rec).stats(rec, ctx);
    return {
      supported,
      reason: undefined,
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
    const { worldGuid } = z.object({ worldGuid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "世界 GUID 格式不合法") }).parse(req.body);
    reply.code(201);
    return saves.createBackup(rec, ctxOf(rec), worldGuid);
  });

  // ── 主機角色修復(內建 palworld-host-save-fix,共玩存檔搬上專用伺服器用)──
  app.post("/api/instances/:id/saves/host-fix", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { worldGuid, oldSav, newSav } = z
      .object({
        worldGuid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "世界 GUID 格式不合法"),
        oldSav: z.string().regex(/^[0-9A-Fa-f]{32}\.sav$/, "玩家存檔檔名格式不合法"),
        newSav: z.string().regex(/^[0-9A-Fa-f]{32}\.sav$/, "玩家存檔檔名格式不合法"),
      })
      .parse(req.body);
    if (await isRunning(rec)) {
      throw Object.assign(new Error("請先停止伺服器再執行修復"), { statusCode: 409 });
    }
    // 改壞角色無法復原 — 修復前強制留一份世界備份。
    const backup = await saves.createBackup(rec, ctxOf(rec), worldGuid);
    const result = applyHostFix(saves.worldDirOf(rec, ctxOf(rec), worldGuid), oldSav, newSav);
    return { ...result, backup: backup.name };
  });

  // ── 匯入外部存檔(其他專用伺服器 / 本機共玩 / 舊版 v1 GUI)──
  app.post("/api/import-save/inspect", async (req) => {
    const { sourcePath } = z.object({ sourcePath: z.string().min(1).max(500) }).parse(req.body);
    return saves.inspectExternalSave(sourcePath);
  });

  app.post("/api/instances/:id/import-save", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { worldPath, overwrite } = z
      .object({ worldPath: z.string().min(1).max(500), overwrite: z.boolean().optional() })
      .parse(req.body);
    if (await isRunning(rec)) {
      throw Object.assign(new Error("請先停止伺服器再匯入存檔"), { statusCode: 409 });
    }
    return saves.importExternalWorld(rec, ctxOf(rec), worldPath, overwrite ?? false);
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
    const { worldGuid } = z.object({ worldGuid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "世界 GUID 格式不合法") }).parse(req.body);
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
      .object({ worldGuid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "世界 GUID 格式不合法"), file: z.string().min(1).max(100) })
      .parse(req.query);
    await saves.deletePlayerSave(rec, ctxOf(rec), worldGuid, file, await isRunning(rec));
    reply.code(204);
  });

  // ── world mirror (同 agent 內 instance 間存檔+INI 鏡像遷移) ──
  app.post("/api/instances/:id/mirror", async (req) => {
    const srcRec = getOr404((req.params as { id: string }).id);
    const { targetId } = z.object({ targetId: z.string().min(1).max(64) }).parse(req.body);
    const dstRec = getOr404(targetId);
    if (srcRec.id === dstRec.id) throw Object.assign(new Error("不能鏡像到自己"), { statusCode: 409 });
    const result = await saves.mirrorWorld(srcRec, ctxOf(srcRec), dstRec, ctxOf(dstRec));
    return { mirrored: true, worldGuid: result.worldGuid, targetId: dstRec.id };
  });

  // ── file browser (native server root or k8s /palworld root) ──
  const PathQuery = z.object({ path: z.string().max(500).default("") });

  app.get("/api/instances/:id/files", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = PathQuery.parse(req.query);
    if (rec.backend === "k8s") return { path: rel, entries: await listDirInPodBrowser(rec, rel) };
    return { path: rel, entries: files.listDir(files.fileRoot(rec, ctxOf(rec)), rel) };
  });

  app.get("/api/instances/:id/files/content", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = PathQuery.parse(req.query);
    if (rec.backend === "k8s") return readFileInPodBrowser(rec, rel);
    return files.readFile(files.fileRoot(rec, ctxOf(rec)), rel);
  });

  app.put("/api/instances/:id/files/content", async (req) => {
    const rec = getOr404((req.params as { id: string }).id);
    const body = z.object({ path: z.string().max(500), content: z.string() }).parse(req.body);
    const configName = path.posix.basename(body.path);
    if (configName === "PalWorldSettings.ini" || configName === "Engine.ini") {
      await snapshotBefore(rec, `raw file edit: ${configName}`);
    }
    if (rec.backend === "k8s") {
      await writeFileInPodBrowser(rec, body.path, body.content);
      return { saved: body.path, applied: "on-next-restart" };
    }
    files.writeFile(files.fileRoot(rec, ctxOf(rec)), body.path, body.content);
    return { saved: body.path, applied: "on-next-restart" };
  });

  app.post("/api/instances/:id/files/dir", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const body = z.object({ path: z.string().min(1).max(500) }).parse(req.body);
    if (rec.backend === "k8s") {
      await makeDirInPodBrowser(rec, body.path);
      reply.code(201);
      return { created: body.path };
    }
    files.makeDir(files.fileRoot(rec, ctxOf(rec)), body.path);
    reply.code(201);
    return { created: body.path };
  });

  app.delete("/api/instances/:id/files", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = z.object({ path: z.string().min(1).max(500) }).parse(req.query);
    if (rec.backend === "k8s") {
      await deletePathInPodBrowser(rec, rel);
      reply.code(204);
      return;
    }
    files.deletePath(files.fileRoot(rec, ctxOf(rec)), rel);
    reply.code(204);
  });

  // Raw body upload: `PUT /files/upload?path=Mods/foo.pak` with the file bytes.
  // Streamed to disk so multi-hundred-MB pak mods don't buffer in memory.
  app.put("/api/instances/:id/files/upload", async (req, reply) => {
    const rec = getOr404((req.params as { id: string }).id);
    const { path: rel } = z.object({ path: z.string().min(1).max(500) }).parse(req.query);
    const configName = path.posix.basename(rel);
    if (configName === "PalWorldSettings.ini" || configName === "Engine.ini") {
      await snapshotBefore(rec, `raw file upload: ${configName}`);
    }
    if (rec.backend === "k8s") {
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const content = Buffer.concat(chunks);
      await uploadFileInPodBrowser(rec, rel, content);
      reply.code(201);
      return { uploaded: rel, size: content.length };
    }
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
