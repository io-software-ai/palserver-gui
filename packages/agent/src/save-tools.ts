import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  SaveHealthReport,
  SaveHealthStatus,
  SaveHealthPhase,
  SavePlayerProfile,
  SavePlayersSnapshot,
  SavePlayersSummary,
} from "@palserver/shared";
import { AGENT_VERSION, DATA_DIR, GITHUB_REPO } from "./env.js";
import type { InstanceRecord } from "./store.js";
import type { DriverContext } from "./driver.js";
import { dirSize, flushWorld, worldDirOf } from "./saves.js";
import { analyzeLevelJsonFile } from "./save-health.js";

/**
 * 存檔健檢(save-slim Stage 1,唯讀)— 外部工具管理 + 任務編排。
 *
 * Level.sav 的完整解析(GVAS + Oodle)交給上游 palsav(palsav-flex,GPL-3.0):
 * 比照 oodle.ts / DepotDownloader 模式,不隨包發行 —— 由本 repo 的
 * palsav-tools.yml workflow 用 PyInstaller 凍結成獨立執行檔發到 GitHub Release,
 * 執行期才下載(SHA256SUMS.txt 驗證,與 self-update 同姿態)、以子行程呼叫,
 * 與 agent 程式碼不連結,維持授權隔離。
 *
 * 流程:flush → 複製 Level.sav 到暫存 → palsav convert --to-json → 串流分析
 * (save-health.ts)→ 報告落地 instanceDir/save-health.json。全程不改動存檔。
 */

/** 對應本 repo Release tag(palsav-tools.yml 建置);升級工具時同步 bump。 */
const PALSAV_TAG = "palsav-tools-v1";
const SUMS_ASSET = "SHA256SUMS.txt";
/** convert 上限:大型世界要幾分鐘,但不該無限掛著。 */
const CONVERT_TIMEOUT_MS = 30 * 60_000;

const REPORTS_FILE = "save-health.json";
const SNAPSHOTS_FILE = "save-players.json";
const TMP_DIR = "health-tmp";

function palsavAssetName(): string | null {
  if (process.arch !== "x64") return null;
  if (process.platform === "win32") return "palsav-win-x64.exe";
  if (process.platform === "linux") return "palsav-linux-x64";
  return null;
}

/** 平台/後端是否支援健檢(不支援時給使用者看得懂的原因)。 */
export function saveHealthSupport(rec: InstanceRecord): { supported: boolean; reason?: string } {
  if (rec.backend === "k8s") {
    return {
      supported: false,
      reason: "k8s 後端暫不支援存檔健檢(需要先把大型存檔拉出 Pod),後續版本評估",
    };
  }
  if (!palsavAssetName()) {
    return {
      supported: false,
      reason: `存檔健檢需要 Windows 或 Linux x64 主機(目前:${process.platform}/${process.arch})`,
    };
  }
  return { supported: true };
}

/* ── 工具下載與驗證(比照 self-update 的 download + SHA256SUMS) ── */

async function download(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": `palserver-agent/${AGENT_VERSION}` },
    redirect: "follow",
  });
  if (res.status === 404) {
    throw new Error(`健檢工具尚未發佈(release ${PALSAV_TAG} 找不到資產)— 請先跑 palsav-tools workflow`);
  }
  if (!res.ok || !res.body) throw new Error(`下載健檢工具失敗:HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (onProgress) {
    body.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (total > 0) onProgress(Math.min(99, Math.round((seen / total) * 100)));
    });
  }
  await pipeline(body, fs.createWriteStream(dest));
}

const sha256 = async (file: string): Promise<string> => {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
};

/** SHA256SUMS.txt:`<hex>  <filename>` 一行一個(sha256sum 標準格式)。 */
function expectedHash(sums: string, assetName: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2]) === assetName) return m[1].toLowerCase();
  }
  return null;
}

/** 確保凍結的 palsav 執行檔就位(下載一次即快取;每次呼叫都重驗雜湊)。 */
async function ensurePalsav(onProgress?: (pct: number) => void): Promise<string> {
  const asset = palsavAssetName();
  if (!asset) throw new Error("此平台不支援存檔健檢");
  const dir = path.join(DATA_DIR, "tools", `palsav-${PALSAV_TAG}`);
  const bin = path.join(dir, asset);
  const sumsFile = path.join(dir, SUMS_ASSET);

  if (fs.existsSync(bin) && fs.existsSync(sumsFile)) {
    const expect = expectedHash(fs.readFileSync(sumsFile, "utf8"), asset);
    if (expect && (await sha256(bin)) === expect) return bin;
    // 壞檔/半下載:清掉重來
    fs.rmSync(bin, { force: true });
    fs.rmSync(sumsFile, { force: true });
  }

  fs.mkdirSync(dir, { recursive: true });
  const base = `https://github.com/${GITHUB_REPO}/releases/download/${PALSAV_TAG}`;

  const sumsTmp = `${sumsFile}.part`;
  await download(`${base}/${SUMS_ASSET}`, sumsTmp);
  const sums = fs.readFileSync(sumsTmp, "utf8");
  const expect = expectedHash(sums, asset);
  if (!expect) {
    fs.rmSync(sumsTmp, { force: true });
    throw new Error(`release ${PALSAV_TAG} 的 ${SUMS_ASSET} 裡沒有 ${asset} 的雜湊`);
  }

  const binTmp = `${bin}.part`;
  await download(`${base}/${asset}`, binTmp, onProgress);
  const actual = await sha256(binTmp);
  if (actual !== expect) {
    fs.rmSync(binTmp, { force: true });
    fs.rmSync(sumsTmp, { force: true });
    throw new Error("健檢工具雜湊不符,已拒絕使用(可能下載不完整或被竄改),請再試一次");
  }
  fs.renameSync(sumsTmp, sumsFile);
  fs.renameSync(binTmp, bin);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

/* ── 任務狀態(每個 instance 同時最多一個健檢) ── */

interface HealthJob {
  worldGuid: string;
  phase: SaveHealthPhase;
  pct: number | null;
}

const jobs = new Map<string, HealthJob>(); // key: instance id
const lastErrors = new Map<string, string>(); // key: `${instanceId}/${worldGuid}`

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/* ── 報告持久化(instanceDir/save-health.json,worldGuid → report) ── */

function reportsPath(ctx: DriverContext): string {
  return path.join(ctx.instanceDir, REPORTS_FILE);
}

function readReports(ctx: DriverContext): Record<string, SaveHealthReport> {
  try {
    return JSON.parse(fs.readFileSync(reportsPath(ctx), "utf8")) as Record<string, SaveHealthReport>;
  } catch {
    return {};
  }
}

function writeReport(ctx: DriverContext, report: SaveHealthReport): void {
  const all = readReports(ctx);
  all[report.worldGuid] = report;
  fs.writeFileSync(reportsPath(ctx), JSON.stringify(all, null, 2));
}

/* ── 玩家快照持久化(instanceDir/save-players.json,worldGuid → snapshot) ── */

function snapshotsPath(ctx: DriverContext): string {
  return path.join(ctx.instanceDir, SNAPSHOTS_FILE);
}

function readSnapshots(ctx: DriverContext): Record<string, SavePlayersSnapshot> {
  try {
    return JSON.parse(fs.readFileSync(snapshotsPath(ctx), "utf8")) as Record<string, SavePlayersSnapshot>;
  } catch {
    return {};
  }
}

function writeSnapshot(ctx: DriverContext, snapshot: SavePlayersSnapshot): void {
  const all = readSnapshots(ctx);
  all[snapshot.worldGuid] = snapshot;
  fs.writeFileSync(snapshotsPath(ctx), JSON.stringify(all));
}

/** 玩家快照清單(不含 pals 明細)。 */
export function getPlayersSummary(ctx: DriverContext, worldGuid: string): SavePlayersSummary & { worldGuid: string } {
  const snap = readSnapshots(ctx)[worldGuid];
  return {
    worldGuid,
    generatedAt: snap?.generatedAt ?? null,
    levelSavMtime: snap?.levelSavMtime ?? null,
    players: (snap?.players ?? []).map(({ pals: _pals, ...rest }) => rest),
  };
}

/** 單一玩家完整檔案(含帕魯明細)。uid 比對忽略大小寫與連字號。 */
export function getPlayerProfile(ctx: DriverContext, worldGuid: string, uid: string): SavePlayerProfile | null {
  const norm = (s: string) => s.replace(/-/g, "").toLowerCase();
  const snap = readSnapshots(ctx)[worldGuid];
  return snap?.players.find((p) => norm(p.uid) === norm(uid)) ?? null;
}

/* ── 主流程 ── */

/** 子行程跑 palsav convert;回傳 stderr 尾段供錯誤訊息。 */
function runConvert(bin: string, savPath: string, jsonPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["convert", savPath, "--to-json", "-o", jsonPath, "--minify-json", "-f"], {
      // PYTHONHASHSEED=0:palsav cli 啟動時要求固定 hash seed,先給就不會重新 exec 自己一次
      env: { ...process.env, PYTHONHASHSEED: "0" },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail.push(chunk.toString());
      while (stderrTail.length > 40) stderrTail.shift();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`存檔轉換超過 ${CONVERT_TIMEOUT_MS / 60_000} 分鐘,已中止`));
    }, CONVERT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`無法啟動健檢工具:${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(jsonPath)) return resolve();
      const tail = stderrTail.join("").slice(-500).trim();
      if (/no space left|enospc/i.test(tail)) {
        return reject(new Error("磁碟空間不足:健檢需要暫存空間(約存檔大小的數倍),請清出空間後再試"));
      }
      reject(new Error(`存檔轉換失敗(exit ${code})${tail ? `:${tail}` : ""}`));
    });
  });
}

async function runJob(rec: InstanceRecord, ctx: DriverContext, worldGuid: string): Promise<SaveHealthReport> {
  const job = jobs.get(rec.id)!;
  const worldDir = worldDirOf(rec, ctx, worldGuid);
  const levelSav = path.join(worldDir, "Level.sav");
  if (!fs.existsSync(levelSav)) throw fail(`找不到世界存檔 ${worldGuid} 的 Level.sav`, 404);

  // 運行中也可以做(唯讀):先 best-effort 請伺服器落盤,分析的是最近一次存檔狀態
  await flushWorld(rec);

  const levelStat = fs.statSync(levelSav);
  const playersDir = path.join(worldDir, "Players");
  let playerSavCount = 0;
  let playersDirBytes = 0;
  if (fs.existsSync(playersDir)) {
    for (const f of fs.readdirSync(playersDir)) {
      if (!f.endsWith(".sav")) continue;
      playerSavCount += 1;
      playersDirBytes += fs.statSync(path.join(playersDir, f), { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  const worldDirBytes = dirSize(worldDir);

  job.phase = "download";
  job.pct = 0;
  const bin = await ensurePalsav((pct) => {
    job.pct = pct;
  });

  const tmpDir = path.join(ctx.instanceDir, TMP_DIR);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // 複製一份再轉:避免 palsav 讀到伺服器寫入半途的原檔
    const savCopy = path.join(tmpDir, "Level.sav");
    await fs.promises.copyFile(levelSav, savCopy);

    job.phase = "convert";
    job.pct = null; // 子行程無進度回報
    const jsonPath = path.join(tmpDir, "Level.sav.json");
    await runConvert(bin, savCopy, jsonPath);

    job.phase = "analyze";
    job.pct = 0;
    const analysis = await analyzeLevelJsonFile(jsonPath, levelStat.mtimeMs, (pct) => {
      job.pct = pct;
    });

    const report: SaveHealthReport = {
      worldGuid,
      generatedAt: new Date().toISOString(),
      toolTag: PALSAV_TAG,
      levelSavBytes: levelStat.size,
      levelSavMtime: levelStat.mtime.toISOString(),
      playersDirBytes,
      playerSavCount,
      worldDirBytes,
      counts: analysis.counts,
      inactivePlayers: analysis.inactivePlayers,
      emptyGuildNames: analysis.emptyGuildNames,
    };
    writeReport(ctx, report);
    // 同一次掃描順帶產出玩家快照(玩家詳情頁「從存檔刷新」的資料來源)
    writeSnapshot(ctx, {
      worldGuid,
      generatedAt: report.generatedAt,
      levelSavMtime: report.levelSavMtime,
      players: analysis.players,
    });
    return report;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 啟動健檢(背景執行)。進行中再叫 → 409;平台不支援 → 400。 */
export function startHealthCheck(rec: InstanceRecord, ctx: DriverContext, worldGuid: string): void {
  const support = saveHealthSupport(rec);
  if (!support.supported) throw fail(support.reason ?? "此環境不支援存檔健檢", 400);
  if (jobs.has(rec.id)) throw fail("已有健檢正在進行,請等它完成", 409);

  jobs.set(rec.id, { worldGuid, phase: "download", pct: null });
  lastErrors.delete(`${rec.id}/${worldGuid}`);

  void runJob(rec, ctx, worldGuid)
    .catch((err: Error) => {
      lastErrors.set(`${rec.id}/${worldGuid}`, err.message);
    })
    .finally(() => {
      jobs.delete(rec.id);
    });
}

/** 目前狀態:進行中的任務(該世界)+ 上次錯誤 + 最近一次成功報告。 */
export function getHealthStatus(rec: InstanceRecord, ctx: DriverContext, worldGuid: string): SaveHealthStatus {
  const support = saveHealthSupport(rec);
  const job = jobs.get(rec.id);
  const running = job && job.worldGuid === worldGuid ? job : null;
  return {
    supported: support.supported,
    reason: support.reason,
    phase: running?.phase ?? "idle",
    progressPct: running?.pct ?? null,
    error: lastErrors.get(`${rec.id}/${worldGuid}`) ?? null,
    report: readReports(ctx)[worldGuid] ?? null,
  };
}
