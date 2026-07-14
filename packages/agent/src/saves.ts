import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { BackupInfo, ExternalWorldCandidate, SavesStatus, WorldSave } from "@palserver/shared";
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
  if (rec.backend === "docker") {
    // docker bind-mount: saved = Pal/Saved, portable paths are relative to it
    const saved = path.join(ctx.instanceDir, "saved");
    const dockerRel = ["SaveGames", "Config"].filter((p) => fs.existsSync(path.join(saved, p)));
    if (dockerRel.length === 0) return null;
    const child = spawn("tar", ["-czf", "-", "-C", saved, ...dockerRel], { windowsHide: true });
    child.on("error", () => {});
    return child.stdout;
  }
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

function assertWorldGuid(worldGuid: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(worldGuid)) throw fail("世界 GUID 格式不合法");
}

async function validateArchiveMembers(archive: string): Promise<void> {
  const listing = await execFileP("tar", ["-tzf", archive], { windowsHide: true }).catch(() => {
    throw fail("備份檔不是有效的 tar.gz", 422);
  });
  for (const member of listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const normalized = member.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw fail("備份檔包含不安全的路徑", 422);
    }
  }
}

/** Path helpers. These take the Pal/Saved root (not the full server root):
 *  native: serverRoot/Pal/Saved, docker: instanceDir/saved. */
const saveGamesDir = (savedRoot: string) => path.join(savedRoot, "SaveGames", "0");
const backupsDir = (ctx: DriverContext) => path.join(ctx.instanceDir, "backups");
const gameUserSettings = (savedRoot: string) =>
  path.join(savedRoot, "Config", CONFIG_PLATFORM_DIR, "GameUserSettings.ini");

/** Backends that expose the world-save tree for read/write. native and docker
 * read the host filesystem directly (docker via bind-mount); k8s reaches
 * files over `kubectl exec`. */
function requireFileCapable(rec: InstanceRecord): void {
  // all backends are now file-capable
  void rec;
}

/** The Pal/Saved directory for host-FS backends.
 * native: <serverRoot>/Pal/Saved
 * docker: <instanceDir>/saved (bind-mount maps directly to Pal/Saved) */
const savedRoot = (rec: InstanceRecord, ctx: DriverContext): string =>
  rec.backend === "docker"
    ? path.join(ctx.instanceDir, "saved")
    : path.join(serverRoot(rec, ctx), "Pal", "Saved");

/** saveGamesDir relative to the Pal/Saved directory. */
const saveGamesFromSaved = (saved: string): string => path.join(saved, "SaveGames", "0");

/** GameUserSettings.ini path relative to the Pal/Saved directory. */
const gameUserSettingsFromSaved = (saved: string): string =>
  path.join(saved, "Config", CONFIG_PLATFORM_DIR, "GameUserSettings.ini");

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
  setActiveWorldGuid(savedRoot(rec, ctx), guid);
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
  return activeWorldGuid(savedRoot(rec, ctx));
}

function listBackups(ctx: DriverContext): BackupInfo[] {
  // Agent-created backups: tar.gz files under <instanceDir>/backups.
  const dir = backupsDir(ctx);
  const agentBackups: BackupInfo[] = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((f) => f.endsWith(".tar.gz"))
        .map((name) => {
          const stat = fs.statSync(path.join(dir, name));
          const [guid] = name.replace(/\.tar\.gz$/, "").split("__");
          return {
            name,
            worldGuid: guid ?? "",
            sizeBytes: stat.size,
            createdAt: new Date(stat.mtimeMs).toISOString(),
          } satisfies BackupInfo;
        })
    : [];

  // Also scan for image-level automatic backups (thijsvanloef / self-built):
  // these live at <savedRoot>/SaveGames/0/<guid>/backup/world/<timestamp>/
  // and are directories containing Level.sav + Players/.
  const root = path.join(ctx.instanceDir, "saved");
  const saveGames0 = path.join(root, "SaveGames", "0");
  const imageBackups: BackupInfo[] = [];
  if (fs.existsSync(saveGames0)) {
    for (const guid of fs.readdirSync(saveGames0)) {
      const worldBackupDir = path.join(saveGames0, guid, "backup", "world");
      if (!fs.existsSync(worldBackupDir)) continue;
      for (const ts of fs.readdirSync(worldBackupDir)) {
        const tsDir = path.join(worldBackupDir, ts);
        if (!fs.statSync(tsDir).isDirectory()) continue;
        // Sum file sizes in the backup directory.
        let sizeBytes = 0;
        try {
          for (const f of fs.readdirSync(tsDir)) {
            const s = fs.statSync(path.join(tsDir, f));
            sizeBytes += s.isFile() ? s.size : 0;
          }
        } catch { /* skip */ }
        imageBackups.push({
          name: ts,
          worldGuid: guid,
          sizeBytes,
          createdAt: new Date(fs.statSync(tsDir).mtimeMs).toISOString(),
        });
      }
    }
  }

  return [...agentBackups, ...imageBackups]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** List thijsvanloef image's automatic backups from the Pod's PVC.
 *  These live at Pal/Saved/SaveGames/0/<guid>/backup/world/<timestamp>/
 *  and are directories containing Level.sav + Players/. */
async function listBackupsK8s(rec: InstanceRecord): Promise<BackupInfo[]> {
  const active = await activeWorldGuidK8s(rec);
  if (!active) return [];
  const backupRoot = `${K8S_SAVEGAMES_REL}/${active}/backup/world`;
  let dirs: string[];
  try {
    dirs = (await listDirInPod(rec, backupRoot)).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // no backup/world dir
  }
  const backups: BackupInfo[] = [];
  for (const ts of dirs) {
    try {
      // Get total size of the backup directory
      const sizeOut = await execInPod(rec, ["du", "-sb", `/palworld/${backupRoot}/${ts}`]);
      const sizeBytes = Number(sizeOut.trim().split(/\s+/)[0]) || 0;
      // Get modification time
      const statOut = await execInPod(rec, ["stat", "-c", "%Y", `/palworld/${backupRoot}/${ts}`]);
      const mtime = Number(statOut.trim()) * 1000;
      backups.push({
        name: `${ts}`,
        worldGuid: active,
        sizeBytes,
        createdAt: new Date(mtime || Date.now()).toISOString(),
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Everything but the schedule, which the scheduler owns and routes merges in. */
export async function getSavesStatus(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<Omit<SavesStatus, "schedule">> {
  // k8s: worlds live in the Pod, reached over exec; the server must be up to
  // list anything. listWorldsK8s returns [] on a missing SaveGames dir.
  if (rec.backend === "k8s") {
    return { supported: true, worlds: await listWorldsK8s(rec), backups: await listBackupsK8s(rec) };
  }
  // native + docker: both read the host filesystem directly (docker via bind-mount).
  const root = savedRoot(rec, ctx);
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
  assertWorldGuid(worldGuid);
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
    const root = savedRoot(rec, ctx);
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
  assertWorldGuid(path.basename(backupName).replace(/\.tar\.gz$/, "").split("__")[0] ?? "");
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
  assertWorldGuid(worldGuid);
  await validateArchiveMembers(archive);

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

  const root = savedRoot(rec, ctx);
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
  assertWorldGuid(worldGuid);
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

  const target = path.join(saveGamesDir(savedRoot(rec, ctx)), worldGuid, "Players", file);
  if (!fs.existsSync(target)) throw fail("找不到該玩家存檔", 404);
  fs.rmSync(target);
}

/**
 * 鏡像遷移：把來源實例的存檔、世界 INI、GameUserSettings 複製到目標實例，
 * 並把目標的 DedicatedServerName 改為來源的 worldguid，讓 server 載入相同的世界。
 *
 * 限制：同一 agent 內的 instance 間。native↔native 走 host FS；k8s↔k8s 走 exec。
 * native↔k8s 混合（一個在 host、一個在 Pod）需額外傳輸機制，暫不支援。
 */
export async function mirrorWorld(
  srcRec: InstanceRecord,
  srcCtx: DriverContext,
  dstRec: InstanceRecord,
  dstCtx: DriverContext,
): Promise<{ worldGuid: string }> {
  const sameBackend = srcRec.backend === dstRec.backend;

  // 1. 取得來源的活躍 worldguid
  const srcGuid = await activeWorldGuidAsync(srcRec, srcCtx);
  if (!srcGuid) throw fail("來源實例找不到活躍世界( DedicatedServerName 未設定)", 409);

  // 2. 停止目標 server（native 要停、k8s 也先 scale down 確保檔案穩定）
  //    呼叫端負責停/啟，這裡只做檔案操作

  if (sameBackend && (srcRec.backend === "native" || srcRec.backend === "docker")) {
    // native↔native / docker↔docker：直接 host FS 複製
    const srcSaved = savedRoot(srcRec, srcCtx);
    const dstSaved = savedRoot(dstRec, dstCtx);
    if (srcRec.backend === "native") {
      // native 用 copyPortableData（含完整 server root 結構）
      copyPortableData(serverRoot(srcRec, srcCtx), serverRoot(dstRec, dstCtx));
    } else {
      // docker 只需 cp saved 目錄
      fs.cpSync(srcSaved, dstSaved, { recursive: true });
    }
    // 改 DedicatedServerName
    const dstGusPath = gameUserSettings(dstSaved);
    if (fs.existsSync(dstGusPath)) {
      const ini = fs.readFileSync(dstGusPath, "utf8");
      fs.writeFileSync(dstGusPath, applyDedicatedServerName(ini, srcGuid));
    }
  } else if (sameBackend && srcRec.backend === "k8s") {
    // k8s↔k8s：透過 exec tar pipe（src Pod → stdout → dst Pod stdin）
    const srcSavePath = `/palworld/${K8S_SAVEGAMES_REL}`;
    const dstSavePath = `/palworld/${K8S_SAVEGAMES_REL}`;
    const archive = await tarDirInPod(srcRec, `${K8S_SAVEGAMES_REL}/0/${srcGuid}`);
    await untarIntoPod(dstRec, K8S_SAVEGAMES_REL, archive);

    // INI 也複製
    const K8S_CONFIG_REL = "Pal/Saved/Config/LinuxServer";
    for (const file of ["PalWorldSettings.ini", "Engine.ini", "GameUserSettings.ini"]) {
      const content = await readFileInPod(srcRec, `${K8S_CONFIG_REL}/${file}`);
      await writeFileInPod(dstRec, `${K8S_CONFIG_REL}/${file}`, content);
    }

    // 改 DedicatedServerName
    const gus = await readFileInPod(dstRec, K8S_GAME_USER_SETTINGS_REL);
    await writeFileInPod(dstRec, K8S_GAME_USER_SETTINGS_REL, applyDedicatedServerName(gus, srcGuid));
  } else {
    throw fail(
      `鏡像遷移目前不支援 ${srcRec.backend} → ${dstRec.backend}（僅支援同類 backend）`,
      409,
    );
  }

  return { worldGuid: srcGuid };
}

/* ────────────────────────────────────────────────────────────────────────
 * 匯入外部存檔(其他專用伺服器 / 本機共玩存檔 / 舊版 v1 GUI)。
 * 三種來源磁碟上都是同一種形狀:一個含 Level.sav 的世界資料夾;差別只在
 * 它被放在哪種容器路徑底下,所以掃描器接受各種常見給法(世界資料夾本身、
 * SaveGames/0、Pal/Saved、伺服器根目錄、共玩的 SaveGames/<SteamID>)。
 * 對應手動流程見 docs/MIGRATION.md 情境 A/B/C。
 * ──────────────────────────────────────────────────────────────────────── */

const LEVEL_SAV = "Level.sav";
/** 本機共玩存檔的主機玩家固定檔名 — 出現它代表要跑 host-save-fix(MIGRATION 情境 C)。 */
const COOP_HOST_SAV = "00000000000000000000000000000001.sav";

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      /* 掃描中被移除等,略過 */
    }
  }
  return total;
}

function worldCandidate(dir: string): ExternalWorldCandidate | null {
  const level = path.join(dir, LEVEL_SAV);
  if (!fs.existsSync(level)) return null;
  const playersDir = path.join(dir, "Players");
  let players = 0;
  let coopHost = false;
  try {
    const names = fs.readdirSync(playersDir).filter((n) => n.toLowerCase().endsWith(".sav"));
    players = names.length;
    coopHost = names.some((n) => n.toLowerCase() === COOP_HOST_SAV);
  } catch {
    /* 沒有 Players 目錄 */
  }
  return {
    guid: path.basename(dir),
    path: dir,
    sizeMB: Math.round((dirSizeBytes(dir) / (1 << 20)) * 10) / 10,
    players,
    coopHost,
    lastModified: fs.statSync(level).mtime.toISOString(),
  };
}

/** 掃描使用者給的路徑,列出可匯入的世界。找不到就回空陣列(不是錯誤 ——
 *  前端據此顯示「這個路徑下沒有世界存檔」的引導)。 */
export function inspectExternalSave(sourcePath: string): { worlds: ExternalWorldCandidate[] } {
  const src = path.resolve(sourcePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    throw fail("路徑不存在", 404);
  }
  if (!stat.isDirectory()) throw fail("路徑不是資料夾", 422);

  const worlds: ExternalWorldCandidate[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const w = worldCandidate(dir);
    if (w) worlds.push(w);
  };

  add(src); // 給的就是世界資料夾本身
  // 常見容器:直接子層(SaveGames/0、共玩 SaveGames/<SteamID>)與更深的標準結構。
  const containers = [
    src,
    path.join(src, "0"),
    path.join(src, "SaveGames", "0"),
    path.join(src, "Saved", "SaveGames", "0"),
    path.join(src, "Pal", "Saved", "SaveGames", "0"),
  ];
  for (const c of containers) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(c, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) add(path.join(c, e.name));
    }
  }
  return { worlds };
}

/** 把外部世界資料夾複製進目標實例並設為啟用世界。呼叫端負責確認伺服器已停止。
 *  現有存檔會先自動備份;GameUserSettings.ini 不存在(從未啟動)就直接建立 ——
 *  只寫 DedicatedServerName,不帶入來源的任何設定(MIGRATION 的忠告)。 */
export async function importExternalWorld(
  rec: InstanceRecord,
  ctx: DriverContext,
  worldPath: string,
  overwrite = false,
): Promise<{ worldGuid: string; backedUp: boolean }> {
  if (rec.backend === "k8s") {
    throw fail("k8s 實例請用「模組」分頁的檔案瀏覽上傳存檔(見遷移指南)", 409);
  }
  const src = path.resolve(worldPath);
  if (!fs.existsSync(path.join(src, LEVEL_SAV))) {
    throw fail("來源不是世界資料夾(缺 Level.sav)— 先用掃描確認路徑", 422);
  }
  const guid = path.basename(src);
  assertWorldGuid(guid);

  const saved = savedRoot(rec, ctx);
  const destGames = saveGamesFromSaved(saved);
  const dest = path.join(destGames, guid);
  if (path.resolve(dest) === src) throw fail("來源就是這個實例自己的存檔,不需匯入", 409);
  if (fs.existsSync(dest) && !overwrite) {
    throw fail(`目標已有同名世界 ${guid}。勾選「覆蓋同名世界」以取代(會先自動備份)`, 409);
  }

  // 匯入是覆蓋性操作:目標若有啟用中的世界,先照既有備份機制留一份。
  let backedUp = false;
  const activeGuid = await activeWorldGuidAsync(rec, ctx).catch(() => null);
  if (activeGuid && fs.existsSync(path.join(destGames, activeGuid))) {
    await createBackup(rec, ctx, activeGuid);
    backedUp = true;
  }

  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(destGames, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });

  // 設為啟用世界。GameUserSettings.ini 可能還不存在(實例從未啟動)→ 建最小檔。
  const gus = gameUserSettings(saved);
  fs.mkdirSync(path.dirname(gus), { recursive: true });
  const ini = fs.existsSync(gus) ? fs.readFileSync(gus, "utf8") : "";
  fs.writeFileSync(gus, applyDedicatedServerName(ini, guid));

  return { worldGuid: guid, backedUp };
}
