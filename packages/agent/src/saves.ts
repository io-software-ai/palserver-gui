import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { BackupInfo, SavesStatus, WorldSave } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";
import { rest } from "./restapi.js";
import { execInPod, listDirInPod, readFileInPod, tarDirInPod, untarIntoPod, writeFileInPod } from "./k8s.js";

const execFileP = promisify(execFile);

/**
 * 「輕量可攜」匯出/複製要帶的東西:世界存檔 + ini 設定 + PalDefender 設定,
 * 刻意排除可重新下載的遊戲執行檔(數十 GB)。路徑相對於 serverRoot,一律用
 * 正斜線 —— tar 與 Node fs 在 Windows 也都吃正斜線。 */
const PORTABLE_PATHS = [
  "Pal/Saved/SaveGames",
  "Pal/Saved/Config",
  "Pal/Binaries/Win64/PalDefender/Config.json",
];

/** 存在於此 serverRoot 底下的可攜路徑(相對)。 */
function existingPortablePaths(root: string): string[] {
  return PORTABLE_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
}

/** 匯出成 tar.gz 的可讀串流(存檔+設定,不含遊戲執行檔);沒東西可匯出時回 null。 */
export function exportArchiveStream(rec: InstanceRecord, ctx: DriverContext): Readable | null {
  const root = serverRoot(rec, ctx);
  const rel = existingPortablePaths(root);
  if (rel.length === 0) return null;
  const child = spawn("tar", ["-czf", "-", "-C", root, ...rel], { windowsHide: true });
  child.on("error", () => {}); // tar 不在時別讓它變成未捕捉例外;串流會提前結束
  return child.stdout;
}

/** 把來源的存檔+設定複製到新實例的 serverRoot(複製伺服器用,不含遊戲執行檔)。 */
export function copyPortableData(srcRoot: string, destRoot: string): void {
  for (const rel of existingPortablePaths(srcRoot)) {
    const from = path.join(srcRoot, rel);
    const to = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

/**
 * World-save and backup management.
 *
 * Layout: <server>/Pal/Saved/SaveGames/0/<WorldGUID>/{Level.sav, Players/*.sav, …}
 * The server picks which world to load from `DedicatedServerName` in
 * GameUserSettings.ini — a mismatch there is the classic migration failure,
 * so we read it, show it, and can set it.
 *
 * Backups are tar.gz archives under <instanceDir>/backups. tar ships with
 * Windows 10+, macOS and Linux, so no archive dependency is needed.
 */

const CONFIG_PLATFORM_DIR = process.platform === "win32" ? "WindowsServer" : "LinuxServer";

/**
 * Paths inside the game-server Pod are always Linux — the thijsvanloef/
 * palworld-server image mounts data under /palworld/ regardless of the host.
 */
const K8S_SAVEGAMES_REL = "Pal/Saved/SaveGames/0";
const K8S_GAME_USER_SETTINGS_REL = `Pal/Saved/Config/LinuxServer/GameUserSettings.ini`;

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const saveGamesDir = (root: string) => path.join(root, "Pal", "Saved", "SaveGames", "0");
const backupsDir = (ctx: DriverContext) => path.join(ctx.instanceDir, "backups");
const gameUserSettings = (root: string) =>
  path.join(root, "Pal", "Saved", "Config", CONFIG_PLATFORM_DIR, "GameUserSettings.ini");

/** Backends that expose the world-save tree for read/write. native reads the
 * host filesystem directly; k8s reaches files over `kubectl exec`. docker has
 * no exec path wired here and stays unsupported. */
function requireFileCapable(rec: InstanceRecord): void {
  if (rec.backend === "docker") {
    throw fail("存檔管理目前不支援 Docker 模式的實例", 409);
  }
}

export const serverRootOf = (rec: InstanceRecord, ctx: DriverContext) => serverRoot(rec, ctx);

/** Delete the oldest backups of a world beyond `keep`. Returns removed names. */
export function pruneBackups(ctx: DriverContext, worldGuid: string, keep: number): string[] {
  const stale = listBackups(ctx)
    .filter((b) => b.worldGuid === worldGuid)
    .slice(keep); // listBackups is newest-first
  for (const backup of stale) {
    fs.rmSync(path.join(backupsDir(ctx), backup.name), { force: true });
  }
  return stale.map((b) => b.name);
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/** The world the server will load, per GameUserSettings.ini. */
export function activeWorldGuid(root: string): string | null {
  try {
    const ini = fs.readFileSync(gameUserSettings(root), "utf8");
    const match = /^DedicatedServerName\s*=\s*(.*)$/m.exec(ini);
    const value = match?.[1]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Point the server at a world (native host filesystem). Creates the
 * key/section if missing. */
export function setActiveWorldGuid(root: string, guid: string): void {
  const file = gameUserSettings(root);
  if (!fs.existsSync(file)) {
    throw fail("找不到 GameUserSettings.ini — 請先啟動一次伺服器讓它生成", 409);
  }
  if (!fs.existsSync(path.join(saveGamesDir(root), guid))) {
    throw fail(`找不到世界存檔 ${guid}`, 404);
  }
  let ini = fs.readFileSync(file, "utf8");
  ini = applyDedicatedServerName(ini, guid);
  fs.writeFileSync(file, ini);
}

/** Rewrite GameUserSettings.ini text so DedicatedServerName points at `guid`.
 * Extracted so the native and k8s paths share one edit algorithm. */
function applyDedicatedServerName(ini: string, guid: string): string {
  if (/^DedicatedServerName\s*=.*$/m.test(ini)) {
    return ini.replace(/^DedicatedServerName\s*=.*$/m, `DedicatedServerName=${guid}`);
  }
  if (/^\[\/Script\/Pal\.PalGameLocalSettings\]/m.test(ini)) {
    return ini.replace(
      /^\[\/Script\/Pal\.PalGameLocalSettings\]/m,
      `[/Script/Pal.PalGameLocalSettings]\nDedicatedServerName=${guid}`,
    );
  }
  return `${ini}\n[/Script/Pal.PalGameLocalSettings]\nDedicatedServerName=${guid}\n`;
}

/**
 * Switch the active world for any file-capable backend. native edits the ini
 * on the host (server must be stopped); k8s rewrites the ini inside the
 * running Pod via exec (server must be up so a Pod exists). Both require a
 * restart afterward for the change to take effect.
 */
export async function setActiveWorldGuidBackend(
  rec: InstanceRecord,
  ctx: DriverContext,
  guid: string,
): Promise<void> {
  requireFileCapable(rec);
  if (rec.backend === "k8s") {
    let ini: string;
    try {
      ini = await readFileInPod(rec, K8S_GAME_USER_SETTINGS_REL);
    } catch {
      throw fail("找不到 GameUserSettings.ini — 請先啟動一次伺服器讓它生成", 409);
    }
    // Confirm the target world exists in the Pod before committing the edit.
    const exists = await execInPod(rec, ["test", "-d", `/palworld/${K8S_SAVEGAMES_REL}/${guid}`])
      .then(() => true)
      .catch(() => false);
    if (!exists) throw fail(`找不到世界存檔 ${guid}`, 404);
    await writeFileInPod(rec, K8S_GAME_USER_SETTINGS_REL, applyDedicatedServerName(ini, guid));
    return;
  }
  setActiveWorldGuid(serverRoot(rec, ctx), guid);
}

function listWorlds(root: string): WorldSave[] {
  const dir = saveGamesDir(root);
  if (!fs.existsSync(dir)) return [];
  const active = activeWorldGuid(root);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(dir, e.name);
      const playersDir = path.join(full, "Players");
      const players = fs.existsSync(playersDir)
        ? fs.readdirSync(playersDir).filter((f) => f.toLowerCase().endsWith(".sav"))
        : [];
      return {
        guid: e.name,
        active: e.name === active,
        sizeBytes: dirSize(full),
        modifiedAt: new Date(fs.statSync(full).mtimeMs).toISOString(),
        playerSaves: players.map((f) => ({
          file: f,
          playerUid: path.basename(f, path.extname(f)),
          sizeBytes: fs.statSync(path.join(playersDir, f)).size,
        })),
      } satisfies WorldSave;
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.modifiedAt.localeCompare(a.modifiedAt));
}

// ── k8s variants: same semantics, reached over `kubectl exec` ───────────
// The Pod filesystem is remote, so these are async and best-effort: a missing
// directory (never booted) yields [] rather than throwing, matching the
// native fs.existsSync guard. `stat` lines carry size and mtime so we can
// reproduce the WorldSave shape without an extra stat-per-file round trip.

/** Read DedicatedServerName from the Pod's GameUserSettings.ini. */
async function activeWorldGuidK8s(rec: InstanceRecord): Promise<string | null> {
  try {
    const ini = await readFileInPod(rec, K8S_GAME_USER_SETTINGS_REL);
    const match = /^DedicatedServerName\s*=\s*(.*)$/m.exec(ini);
    const value = match?.[1]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** List worlds in the Pod via `ls -1 --time-style=... -l` parsed to WorldSave[]. */
async function listWorldsK8s(rec: InstanceRecord): Promise<WorldSave[]> {
  const active = await activeWorldGuidK8s(rec);
  // List world dirs (one per line).
  let dirs: string[];
  try {
    dirs = (await listDirInPod(rec, K8S_SAVEGAMES_REL)).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // SaveGames/0 not present yet — server never booted.
  }
  const worlds: WorldSave[] = [];
  for (const guid of dirs) {
    // Per-world detail: stat the dir + list player saves.
    let sizeBytes = 0;
    let modifiedAt = new Date().toISOString();
    try {
      const stat = await execInPod(rec, ["stat", "-c", "%s %Y", `/palworld/${K8S_SAVEGAMES_REL}/${guid}`]);
      const [size, mtime] = stat.trim().split(/\s+/);
      sizeBytes = Number(size) || 0;
      if (mtime) modifiedAt = new Date(Number(mtime) * 1000).toISOString();
    } catch {
      /* leave defaults */
    }
    // Player saves live under <world>/Players/*.sav.
    const playerSaves: WorldSave["playerSaves"] = [];
    try {
      const players = (await listDirInPod(rec, `${K8S_SAVEGAMES_REL}/${guid}/Players`))
        .split("\n").map((s) => s.trim()).filter((f) => f.toLowerCase().endsWith(".sav"));
      for (const f of players) {
        let psize = 0;
        try {
          const ps = await execInPod(rec, ["stat", "-c", "%s", `/palworld/${K8S_SAVEGAMES_REL}/${guid}/Players/${f}`]);
          psize = Number(ps.trim()) || 0;
        } catch {
          /* leave 0 */
        }
        playerSaves.push({
          file: f,
          playerUid: path.basename(f, path.extname(f)),
          sizeBytes: psize,
        });
      }
    } catch {
      /* no Players dir */
    }
    worlds.push({ guid, active: guid === active, sizeBytes, modifiedAt, playerSaves });
  }
  worlds.sort(
    (a, b) => Number(b.active) - Number(a.active) || b.modifiedAt.localeCompare(a.modifiedAt),
  );
  return worlds;
}

/** Async active-world resolver that works for both native and k8s backends.
 * Used by the backup scheduler, which ticks async. */
export async function activeWorldGuidAsync(rec: InstanceRecord, ctx: DriverContext): Promise<string | null> {
  if (rec.backend === "k8s") return activeWorldGuidK8s(rec);
  return activeWorldGuid(serverRoot(rec, ctx));
}

function listBackups(ctx: DriverContext): BackupInfo[] {
  const dir = backupsDir(ctx);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      // <guid>__<iso-ish timestamp>.tar.gz
      const [guid] = name.replace(/\.tar\.gz$/, "").split("__");
      return {
        name,
        worldGuid: guid ?? "",
        sizeBytes: stat.size,
        createdAt: new Date(stat.mtimeMs).toISOString(),
      } satisfies BackupInfo;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Everything but the schedule, which the scheduler owns and routes merges in. */
export async function getSavesStatus(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<Omit<SavesStatus, "schedule">> {
  if (rec.backend === "docker") {
    return { supported: false, reason: "存檔管理目前不支援 Docker 模式的實例", worlds: [], backups: [] };
  }
  // k8s: worlds live in the Pod, reached over exec; the server must be up to
  // list anything. listWorldsK8s returns [] on a missing SaveGames dir.
  if (rec.backend === "k8s") {
    return { supported: true, worlds: await listWorldsK8s(rec), backups: listBackups(ctx) };
  }
  const root = serverRoot(rec, ctx);
  if (!fs.existsSync(saveGamesDir(root))) {
    return {
      supported: false,
      reason: "尚未產生世界存檔 — 先啟動一次伺服器",
      worlds: [],
      backups: listBackups(ctx),
    };
  }
  return { supported: true, worlds: listWorlds(root), backups: listBackups(ctx) };
}

/** Ask the running server to flush the world first, so the archive isn't
 * a snapshot of half-written state. Silently skipped when REST is off. */
async function flushWorld(rec: InstanceRecord): Promise<boolean> {
  try {
    await rest.save(rec);
    return true;
  } catch {
    return false;
  }
}

export async function createBackup(
  rec: InstanceRecord,
  ctx: DriverContext,
  worldGuid: string,
): Promise<BackupInfo> {
  requireFileCapable(rec);
  const flushed = await flushWorld(rec);
  fs.mkdirSync(backupsDir(ctx), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${worldGuid}__${stamp}.tar.gz`;
  const archive = path.join(backupsDir(ctx), name);

  if (rec.backend === "k8s") {
    // Stream the world dir out of the Pod into a local archive. The server
    // must be running for exec to reach a Pod — the caller (scheduler / route)
    // already ensures that, and flushWorld best-effort asks it to save first.
    const worldRel = `${K8S_SAVEGAMES_REL}/${worldGuid}`;
    const buf = await tarDirInPod(rec, worldRel).catch(() => {
      throw fail(`找不到世界存檔 ${worldGuid}`, 404);
    });
    fs.writeFileSync(archive, buf);
  } else {
    const root = serverRoot(rec, ctx);
    const worldDir = path.join(saveGamesDir(root), worldGuid);
    if (!fs.existsSync(worldDir)) throw fail(`找不到世界存檔 ${worldGuid}`, 404);
    await execFileP("tar", ["-czf", archive, "-C", worldDir, "."], { windowsHide: true });
  }

  return {
    name,
    worldGuid,
    sizeBytes: fs.statSync(archive).size,
    createdAt: new Date().toISOString(),
    flushedBeforeBackup: flushed,
  };
}

export async function restoreBackup(
  rec: InstanceRecord,
  ctx: DriverContext,
  backupName: string,
  running: boolean,
): Promise<{ worldGuid: string; safetyBackup: string }> {
  requireFileCapable(rec);
  // k8s: the Pod must exist to receive the restore, so we don't gate on
  // `running` the way native does (native wants the server stopped so its
  // files aren't mid-write). For k8s we unpack into the running Pod and let
  // the caller restart it to pick up the restored state.
  if (rec.backend === "native" && running) throw fail("請先停止伺服器再還原存檔", 409);
  if (rec.backend === "k8s" && !running) throw fail("k8s 還原存檔需伺服器運行中(以存取 Pod)", 409);

  const archive = path.join(backupsDir(ctx), path.basename(backupName));
  if (!archive.endsWith(".tar.gz") || !fs.existsSync(archive)) throw fail("找不到備份檔", 404);

  const worldGuid = path.basename(backupName).replace(/\.tar\.gz$/, "").split("__")[0];
  if (!worldGuid) throw fail("備份檔名無法解析出世界 GUID");

  if (rec.backend === "k8s") {
    // Safety backup first (re-uses createBackup's tar-out path), then replace.
    let safetyBackup = "(無現有存檔,略過)";
    const exists = await execInPod(rec, ["test", "-d", `/palworld/${K8S_SAVEGAMES_REL}/${worldGuid}`])
      .then(() => true)
      .catch(() => false);
    if (exists) {
      safetyBackup = (await createBackup(rec, ctx, worldGuid)).name;
      await execInPod(rec, ["rm", "-rf", `/palworld/${K8S_SAVEGAMES_REL}/${worldGuid}`]).catch(() => {});
    }
    await untarIntoPod(rec, `${K8S_SAVEGAMES_REL}/${worldGuid}`, fs.readFileSync(archive));
    return { worldGuid, safetyBackup };
  }

  const root = serverRoot(rec, ctx);
  const worldDir = path.join(saveGamesDir(root), worldGuid);

  // Never destroy the current world without keeping a copy of it first.
  let safetyBackup = "(無現有存檔,略過)";
  if (fs.existsSync(worldDir)) {
    safetyBackup = (await createBackup(rec, ctx, worldGuid)).name;
    fs.rmSync(worldDir, { recursive: true, force: true });
  }
  fs.mkdirSync(worldDir, { recursive: true });
  await execFileP("tar", ["-xzf", archive, "-C", worldDir], { windowsHide: true });
  return { worldGuid, safetyBackup };
}

export function deleteBackup(ctx: DriverContext, backupName: string): void {
  const archive = path.join(backupsDir(ctx), path.basename(backupName));
  if (!archive.endsWith(".tar.gz") || !fs.existsSync(archive)) throw fail("找不到備份檔", 404);
  fs.rmSync(archive);
}

export function backupPath(ctx: DriverContext, backupName: string): string {
  const archive = path.join(backupsDir(ctx), path.basename(backupName));
  if (!archive.endsWith(".tar.gz") || !fs.existsSync(archive)) throw fail("找不到備份檔", 404);
  return archive;
}

/** Remove one player's save. The player rejoins as a fresh character. */
export async function deletePlayerSave(
  rec: InstanceRecord,
  ctx: DriverContext,
  worldGuid: string,
  file: string,
  running: boolean,
): Promise<void> {
  requireFileCapable(rec);
  // k8s: the Pod must exist to reach the file, so it must be running; native
  // wants the server stopped so its save files aren't locked mid-write.
  if (rec.backend === "native" && running) throw fail("請先停止伺服器再刪除玩家存檔", 409);
  if (rec.backend === "k8s" && !running) throw fail("k8s 刪除玩家存檔需伺服器運行中(以存取 Pod)", 409);
  if (!/^[A-Fa-f0-9]+\.sav$/.test(file)) throw fail("玩家存檔檔名不合法");

  if (rec.backend === "k8s") {
    const target = `/palworld/${K8S_SAVEGAMES_REL}/${worldGuid}/Players/${file}`;
    const exists = await execInPod(rec, ["test", "-f", target])
      .then(() => true)
      .catch(() => false);
    if (!exists) throw fail("找不到該玩家存檔", 404);
    await execInPod(rec, ["rm", "-f", target]);
    return;
  }

  const target = path.join(saveGamesDir(serverRoot(rec, ctx)), worldGuid, "Players", file);
  if (!fs.existsSync(target)) throw fail("找不到該玩家存檔", 404);
  fs.rmSync(target);
}
