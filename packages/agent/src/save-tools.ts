import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type {
  AutoScanSetting,
  SaveGuild,
  SaveHealthReport,
  SaveHealthStatus,
  SaveHealthPhase,
  SaveBreedingSnapshot,
  SavePlayerProfile,
  SavePlayersSnapshot,
  SavePlayersSummary,
  SaveScanStats,
  SaveScanPlayerStat,
  SaveScanTopPal,
} from "@palserver/shared";
import { DEFAULT_AUTO_SCAN, topPalScore } from "@palserver/shared";
import { AGENT_VERSION, DATA_DIR, GITHUB_REPO } from "./env.js";
import type { InstanceRecord } from "./store.js";
import type { DriverContext } from "./driver.js";
import { dirSize, flushWorld, worldDirOf } from "./saves.js";
import { analyzeLevelJsonFile, collectContainerContents, normGuid, type InventoryKind } from "./save-health.js";
import { tarDirInPod } from "./k8s-files.js";
import { ContainerHealthRunner } from "./runtime-health.js";

const execFileP = promisify(execFile);

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
const STATS_HISTORY_FILE = "save-stats-history.json";
/** 每個世界保留的掃描統計筆數(排行榜週報用;超過丟最舊)。每小時自動掃描約可放 20 天。 */
const STATS_HISTORY_MAX = 500;
const TMP_DIR = "health-tmp";

export function palsavAssetName(rec: InstanceRecord): string | null {
  // 容器後端:轉換器在容器內執行(amd64 映像),與 agent 主機的架構無關。
  if (rec.backend !== "native") return rec.runtime === "wine" ? "palsav-win-x64.exe" : "palsav-linux-x64";
  // native:二進位直接跑在主機上,才需要看主機架構/平台。
  if (process.arch !== "x64") return null;
  if (process.platform === "win32") return "palsav-win-x64.exe";
  if (process.platform === "linux") return "palsav-linux-x64";
  return null;
}

/** 平台/後端是否支援健檢(不支援時給使用者看得懂的原因)。 */
export function saveHealthSupport(rec: InstanceRecord): { supported: boolean; reason?: string } {
  if (!palsavAssetName(rec)) {
    return {
      supported: false,
      reason: rec.backend === "native"
        ? `存檔健檢需要 Windows 或 Linux x64 主機(目前:${process.platform}/${process.arch})`
        : `容器健檢需要 x64 容器工具(目前:${process.arch},runtime:${rec.runtime ?? "native"})`,
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
export async function ensurePalsav(rec: InstanceRecord, onProgress?: (pct: number) => void): Promise<string> {
  const asset = palsavAssetName(rec);
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

/** 配種工具只需要個體與主人,不回傳背包/公會等大型玩家檔案。 */
export function getBreedingSnapshot(ctx: DriverContext, worldGuid: string): SaveBreedingSnapshot {
  const snapshot = readSnapshots(ctx)[worldGuid];
  return {
    worldGuid,
    generatedAt: snapshot?.generatedAt ?? null,
    pals: (snapshot?.players ?? []).flatMap((player) =>
      player.pals.map((pal) => ({ ...pal, ownerUid: player.uid, ownerName: player.name })),
    ),
  };
}

function writeSnapshot(ctx: DriverContext, snapshot: SavePlayersSnapshot): void {
  const all = readSnapshots(ctx);
  all[snapshot.worldGuid] = snapshot;
  fs.writeFileSync(snapshotsPath(ctx), JSON.stringify(all));
}

/* ── 掃描統計歷史(instanceDir/save-stats-history.json,worldGuid → 追加陣列;排行榜/週報用) ── */

function statsHistoryPath(ctx: DriverContext): string {
  return path.join(ctx.instanceDir, STATS_HISTORY_FILE);
}

function readStatsHistory(ctx: DriverContext): Record<string, SaveScanStats[]> {
  try {
    return JSON.parse(fs.readFileSync(statsHistoryPath(ctx), "utf8")) as Record<string, SaveScanStats[]>;
  } catch {
    return {};
  }
}

function appendScanStats(ctx: DriverContext, worldGuid: string, stats: SaveScanStats): void {
  try {
    const all = readStatsHistory(ctx);
    const list = all[worldGuid] ?? [];
    // 同一份存檔(levelSavMtime 沒變)重掃不重複記,直接以最新結果取代最後一筆
    if (list.length > 0 && list[list.length - 1].levelSavMtime === stats.levelSavMtime) list.pop();
    list.push(stats);
    all[worldGuid] = list.slice(-STATS_HISTORY_MAX);
    fs.writeFileSync(statsHistoryPath(ctx), JSON.stringify(all));
  } catch {
    // 統計歷史寫失敗不擋健檢主流程
  }
}

export function getStatsHistory(ctx: DriverContext, worldGuid: string): { worldGuid: string; history: SaveScanStats[] } {
  return { worldGuid, history: readStatsHistory(ctx)[worldGuid] ?? [] };
}

/* ── 每小時自動掃描(排行榜/週報資料來源;設定檔比照 backup-schedule) ── */

const AUTO_SCAN_FILE = "auto-scan.json";

export function readAutoScan(ctx: DriverContext): AutoScanSetting {
  try {
    return { ...DEFAULT_AUTO_SCAN, ...JSON.parse(fs.readFileSync(path.join(ctx.instanceDir, AUTO_SCAN_FILE), "utf8")) };
  } catch {
    return { ...DEFAULT_AUTO_SCAN };
  }
}

export function writeAutoScan(ctx: DriverContext, patch: Partial<AutoScanSetting>): AutoScanSetting {
  const next = { ...readAutoScan(ctx), ...patch };
  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.instanceDir, AUTO_SCAN_FILE), JSON.stringify(next, null, 2));
  return next;
}

/**
 * 每分鐘 tick:啟用自動掃描、伺服器運作中、間隔已到、且該實例沒有掃描在跑,
 * 就對啟用中的世界起一次健檢(產出健檢報告+快照+統計歷史,與手動同一條管線)。
 * 停機時不掃(存檔沒在變);不支援的 runtime 由 saveHealthSupport 擋掉。
 */
export function startAutoScanLoop(deps: {
  list: () => InstanceRecord[];
  ctxOf: (rec: InstanceRecord) => DriverContext;
  statusOf: (rec: InstanceRecord) => Promise<string>;
  activeWorldGuid: (rec: InstanceRecord, ctx: DriverContext) => Promise<string | null>;
}): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      for (const rec of deps.list()) {
        const ctx = deps.ctxOf(rec);
        const setting = readAutoScan(ctx);
        if (!setting.enabled) continue;
        const elapsedMin = setting.lastRunAt ? (Date.now() - Date.parse(setting.lastRunAt)) / 60_000 : Infinity;
        if (elapsedMin < Math.max(setting.intervalMinutes, 10)) continue;
        if (jobs.has(rec.id)) continue;
        if (!saveHealthSupport(rec).supported) continue;
        try {
          if ((await deps.statusOf(rec)) !== "running") continue;
          const worldGuid = await deps.activeWorldGuid(rec, ctx);
          if (!worldGuid) continue;
          startHealthCheck(rec, ctx, worldGuid);
          writeAutoScan(ctx, { lastRunAt: new Date().toISOString(), lastResult: "已啟動掃描" });
        } catch (err) {
          writeAutoScan(ctx, {
            lastRunAt: new Date().toISOString(),
            lastResult: `失敗:${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    })();
  }, 60_000);
  timer.unref();
  return timer;
}

/** 從完整快照算出精簡統計(每玩家:等級/金錢/圖鑑數/最強帕魯;每公會:成員/據點/實力欄位)。
 *  export 供單元測試(純函式)。 */
export function computeScanStats(snap: SavePlayersSnapshot): SaveScanStats {
  const players: SaveScanPlayerStat[] = snap.players.map((p) => {
    let top: SaveScanTopPal | null = null;
    let topKey = -1;
    for (const pal of p.pals) {
      const iv = (pal.talentHp ?? 0) + (pal.talentShot ?? 0) + (pal.talentDefense ?? 0);
      const candidate: SaveScanTopPal = {
        characterId: pal.characterId,
        ...(pal.nickname ? { nickname: pal.nickname } : {}),
        level: pal.level,
        rank: pal.rank,
        ivTotal: iv,
        passiveCount: pal.passives.length,
        passives: pal.passives.slice(0, 8),
      };
      // 加權評分(shared topPalScore):等級 + IV×0.1 + 星級×10 + 詞條數×5
      const key = topPalScore(candidate);
      if (key > topKey) {
        topKey = key;
        top = candidate;
      }
    }
    return {
      uid: p.uid,
      name: p.name,
      level: p.level,
      money: p.inventory?.money ?? null,
      palCount: p.palCount,
      paldeckCount: p.paldeck ? new Set(p.paldeck).size : null,
      topPal: top,
    };
  });
  // 公會深度欄位:成員以 uid(去連字號、不分大小寫)對回玩家統計
  const norm = (s: string) => s.replace(/-/g, "").toLowerCase();
  const playerByUid = new Map(players.map((p) => [norm(p.uid), p]));
  const guilds = (snap.guilds ?? []).map((g) => {
    const members = g.members.map((m) => ({ ...m, stat: playerByUid.get(norm(m.uid)) }));
    const levels = members
      .map((m) => m.stat?.level)
      .filter((lv): lv is number => typeof lv === "number");
    return {
      id: g.id,
      name: g.name,
      memberCount: g.members.length,
      baseCount: g.bases.length,
      baseCampLevel: g.baseCampLevel,
      avgLevel: levels.length > 0 ? Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10 : null,
      maxLevel: levels.length > 0 ? Math.max(...levels) : null,
      activeMembers: members.filter((m) => m.lastOnlineDaysAgo !== null && m.lastOnlineDaysAgo <= 7).length,
      workerPals: g.bases.reduce((sum, b) => sum + b.workers.length, 0),
      storageKinds: g.storage ? g.storage.length : null,
      researchDone: g.research ? g.research.entries.length : null,
      totalMoney: members.reduce((sum, m) => sum + (m.stat?.money ?? 0), 0),
      totalPals: members.reduce((sum, m) => sum + (m.stat?.palCount ?? 0), 0),
    };
  });
  return { scannedAt: snap.generatedAt, levelSavMtime: snap.levelSavMtime, players, guilds };
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

/** 公會清單(公會頁用)。 */
export function getGuildsSnapshot(
  ctx: DriverContext,
  worldGuid: string,
): { worldGuid: string; generatedAt: string | null; guilds: SaveGuild[] } {
  const snap = readSnapshots(ctx)[worldGuid];
  return { worldGuid, generatedAt: snap?.generatedAt ?? null, guilds: snap?.guilds ?? [] };
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
    const child = spawn(bin, ["--to-json", "-o", jsonPath, "--minify-json", "-f", savPath], {
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

/** 解析 Players/*.sav,建兩份容器對照:
 *  - kinds:角色容器 → party(身上)/palbox(帕魯箱),帕魯位置分類用
 *  - itemOwners:物品容器 → 誰的哪一格(背包/武器/防具/重要/食物),離線物品用
 *  任一必要玩家檔轉換失敗即停止本次健檢並回報;檔數設上限防極端伺服器。 */
const MAX_PLAYER_SAVS = 50;
/** 玩家 .sav 的 InventoryInfo 欄位 → 快照 inventory 分類。 */
const INVENTORY_FIELDS: Record<string, InventoryKind> = {
  CommonContainerId: "common",
  EssentialContainerId: "essential",
  WeaponLoadOutContainerId: "weapons",
  PlayerEquipArmorContainerId: "armor",
  FoodEquipContainerId: "food",
};

interface ContainerIndex {
  kinds: Map<string, "party" | "palbox">;
  itemOwners: Map<string, { uid: string; kind: InventoryKind }>;
  /** uid(無連字號小寫)→ 曾捕捉過的物種 characterId 清單(RecordData.PalCaptureCount) */
  paldeck: Map<string, string[]>;
  /** 轉換失敗必須回報，不能以空索引假裝健檢完整。 */
  conversionFailures: string[];
}

const savNameToUuid = (name: string): string => {
  const h = name.slice(0, 32).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

type IdProp = { value?: { ID?: { value?: unknown } } };

/** 讀 Map 條目的 key/value(簡單型別為裸值,防禦性也接受 {value} 包裝)。 */
function mapEntryKey(e: { key?: unknown }): string | null {
  if (typeof e?.key === "string") return e.key;
  const wrapped = (e?.key as { value?: unknown })?.value;
  return typeof wrapped === "string" ? wrapped : null;
}
function mapEntryValue(e: { value?: unknown }): unknown {
  const v = e?.value;
  if (v !== null && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

/** 從玩家 .sav JSON 撈圖鑑登錄紀錄:SaveData.RecordData.value 底下的
 *  PaldeckUnlockFlag(bool=已登錄)與 PalCaptureCount(int=捕捉次數)兩張 Map,
 *  取「已登錄 ∪ 捕捉次數>0」的物種聯集。key 是物種字串,但大小寫/前綴與遊戲
 *  資料表 characterId 可能有出入(如 Sheepball vs SheepBall),消費端要不分大小寫比對。
 *  欄位路徑出處:KrisCris/Palworld-Pal-Editor player_entity.py:383-408。 */
export function extractPaldeck(sd: Record<string, unknown> | undefined): string[] | null {
  const record = (sd?.RecordData ?? (sd as Record<string, unknown> | undefined)?.recordData) as
    | { value?: Record<string, { value?: unknown }> }
    | undefined;
  if (!record?.value) return null;
  const species = new Set<string>();
  const unlockEntries = record.value.PaldeckUnlockFlag?.value;
  if (Array.isArray(unlockEntries)) {
    for (const e of unlockEntries as { key?: unknown; value?: unknown }[]) {
      const k = mapEntryKey(e);
      if (k && mapEntryValue(e) === true) species.add(k);
    }
  }
  const captureEntries = record.value.PalCaptureCount?.value;
  if (Array.isArray(captureEntries)) {
    for (const e of captureEntries as { key?: unknown; value?: unknown }[]) {
      const k = mapEntryKey(e);
      const count = mapEntryValue(e);
      if (k && (typeof count !== "number" || count > 0)) species.add(k);
    }
  }
  if (!Array.isArray(unlockEntries) && !Array.isArray(captureEntries)) return null;
  return [...species];
}

type ConvertFn = (inputPath: string, outputPath: string) => Promise<void>;

async function buildContainerIndex(convert: ConvertFn, playersDir: string, tmpDir: string): Promise<ContainerIndex> {
  const kinds = new Map<string, "party" | "palbox">();
  const itemOwners = new Map<string, { uid: string; kind: InventoryKind }>();
  const paldeck = new Map<string, string[]>();
  if (!fs.existsSync(playersDir)) return { kinds, itemOwners, paldeck, conversionFailures: [] };
  const conversionFailures: string[] = [];
  const files = fs
    .readdirSync(playersDir)
    .filter((f) => /^[0-9A-Fa-f]{32}\.sav$/.test(f))
    .slice(0, MAX_PLAYER_SAVS);
  for (const f of files) {
    const copy = path.join(tmpDir, `player-${f}`);
    const out = `${copy}.json`;
    try {
      await fs.promises.copyFile(path.join(playersDir, f), copy);
      await convert(copy, out);
      const sd = (JSON.parse(fs.readFileSync(out, "utf8")) as {
        properties?: { SaveData?: { value?: Record<string, IdProp> } };
      }).properties?.SaveData?.value;
      const idOf = (p: IdProp | undefined): string | null =>
        typeof p?.value?.ID?.value === "string" ? (p.value.ID.value as string) : null;

      const otomo = idOf(sd?.OtomoCharacterContainerId);
      const storage = idOf(sd?.PalStorageContainerId);
      if (otomo) kinds.set(normGuid(otomo), "party");
      if (storage) kinds.set(normGuid(storage), "palbox");

      const uid = savNameToUuid(f);
      const invInfo = (sd?.InventoryInfo ?? sd?.inventoryInfo) as
        | { value?: Record<string, IdProp> }
        | undefined;
      for (const [field, kind] of Object.entries(INVENTORY_FIELDS)) {
        const cid = idOf(invInfo?.value?.[field]);
        if (cid) itemOwners.set(normGuid(cid), { uid, kind });
      }
      const deck = extractPaldeck(sd as Record<string, unknown> | undefined);
      if (deck) paldeck.set(uid.replace(/-/g, "").toLowerCase(), deck);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      conversionFailures.push(`${f}:${reason}`);
      break;
    } finally {
      fs.rmSync(copy, { force: true });
      fs.rmSync(out, { force: true });
    }
  }
  return { kinds, itemOwners, paldeck, conversionFailures };
}

async function runJob(rec: InstanceRecord, ctx: DriverContext, worldGuid: string): Promise<SaveHealthReport> {
  const job = jobs.get(rec.id)!;
  const tmpDir = path.join(ctx.instanceDir, TMP_DIR);
  let containerRunner: ContainerHealthRunner | null = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // 運行中也可以做(唯讀):先 best-effort 請伺服器落盤,分析的是最近一次存檔狀態
    await flushWorld(rec);

    let worldDir: string;
    if (rec.backend === "k8s") {
      // k8s PVC is not visible to the agent process: take a read-only tar
      // snapshot after flush; conversion itself is dispatched into the Pod.
      worldDir = path.join(tmpDir, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const archive = path.join(tmpDir, "world.tar.gz");
      job.phase = "download";
      job.pct = 0;
      // backup/world is maintained independently by the backup scheduler and
      // is not part of the world-health input; excluding it also prevents a
      // concurrent backup write from invalidating the read-only snapshot.
      fs.writeFileSync(archive, await tarDirInPod(rec, `Pal/Saved/SaveGames/0/${worldGuid}`, ["./backup"]));
      await execFileP("tar", ["-xzf", archive, "-C", worldDir], { windowsHide: true });
    } else {
      worldDir = worldDirOf(rec, ctx, worldGuid);
    }
    const levelSav = path.join(worldDir, "Level.sav");
    if (!fs.existsSync(levelSav)) throw fail(`找不到世界存檔 ${worldGuid} 的 Level.sav`, 404);

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

    if (rec.backend !== "k8s") {
      job.phase = "download";
      job.pct = 0;
    }
    const bin = await ensurePalsav(rec, (pct) => {
      job.pct = pct;
    });
    const runner = rec.backend === "docker" || rec.backend === "k8s"
      ? new ContainerHealthRunner(rec, bin, `job-${rec.id}-${Date.now().toString(36)}`)
      : null;
    containerRunner = runner;
    const convert: ConvertFn = runner
      ? (inputPath, outputPath) => runner.convert(inputPath, outputPath)
      : (inputPath, outputPath) => runConvert(bin, inputPath, outputPath);

    // 複製一份再轉:避免 palsav 讀到伺服器寫入半途的原檔
    const savCopy = path.join(tmpDir, "Level.sav");
    await fs.promises.copyFile(levelSav, savCopy);

    job.phase = "convert";
    job.pct = null; // 子行程無進度回報
    // 先解析玩家檔(小,秒級)建容器對照 → 帕魯位置分類 + 離線物品歸屬 + 圖鑑紀錄
    const { kinds, itemOwners, paldeck, conversionFailures } = await buildContainerIndex(
      convert,
      path.join(worldDir, "Players"),
      tmpDir,
    );
    if (conversionFailures.length > 0) {
      throw fail(
        `玩家存檔轉換失敗(${conversionFailures.length}):${conversionFailures.slice(0, 3).join("; ")}`,
        422,
      );
    }
    const jsonPath = path.join(tmpDir, "Level.sav.json");
    await convert(savCopy, jsonPath);

    job.phase = "analyze";
    job.pct = 0;
    const analysis = await analyzeLevelJsonFile(
      jsonPath,
      levelStat.mtimeMs,
      (pct) => {
        job.pct = pct;
      },
      { containerKinds: kinds, itemContainerOwners: itemOwners },
    );

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
      worldSections: analysis.worldSections,
    };
    writeReport(ctx, report);

    // 公會倉庫:容器 id 在存檔後段才出現,需要第二趟輕量掃描補內容
    if (analysis.guildStorageContainers.size > 0) {
      try {
        const targets = new Set([...analysis.guildStorageContainers.values()].map(normGuid));
        const contents = await collectContainerContents(jsonPath, targets, (pct) => {
          job.pct = pct;
        });
        for (const g of analysis.guilds) {
          const cid = analysis.guildStorageContainers.get(normGuid(g.id));
          // 找不到容器 = 解析不到(null,UI 顯示無資料);找到但沒東西 = 真的空([])
          if (cid) g.storage = contents.get(normGuid(cid)) ?? null;
        }
      } catch {
        // 倉庫收集失敗不擋整體:guilds.storage 維持 null(UI 顯示無資料)
      }
    }

    // 圖鑑紀錄併回玩家檔案(玩家 .sav 的 RecordData;uid 忽略連字號與大小寫比對)
    for (const p of analysis.players) {
      p.paldeck = paldeck.get(p.uid.replace(/-/g, "").toLowerCase()) ?? null;
    }

    // 同一次掃描順帶產出玩家/公會快照(玩家詳情與公會頁的資料來源)
    const snapshot: SavePlayersSnapshot = {
      worldGuid,
      generatedAt: report.generatedAt,
      levelSavMtime: report.levelSavMtime,
      players: analysis.players,
      guilds: analysis.guilds,
    };
    writeSnapshot(ctx, snapshot);
    // 排行榜/週報:每次掃描追加一筆精簡統計(不覆蓋,和快照不同)
    appendScanStats(ctx, worldGuid, computeScanStats(snapshot));
    return report;
  } finally {
    // Container tools and inputs must not remain in the game runtime after a
    // scan, even when conversion/analyse fails midway.
    await containerRunner?.cleanup();
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
