import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extractZip from "extract-zip";
import {
  PAL_STATS_TABLE,
  PAL_STAT_KEYS,
  PAL_STAT_OPTIONS,
  type PalSchemaStatus,
  type PalStatKey,
  type PalStatValues,
  type PalStatsRow,
  type PalStatsStatus,
} from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverPlatform } from "./platform.js";
import { serverRoot } from "./native.js";
import { activeWorldGuidAsync, createBackup } from "./saves.js";
import {
  runtimeExists,
  runtimeMkdir,
  runtimeReadText,
  runtimeRemove,
  runtimeWriteText,
} from "./runtime-files.js";
import { makeDirInPod, writeFileBytesInPod } from "./k8s-files.js";

/**
 * PalSchema 整合(贊助者先行版 pal-stats):
 *  - 一鍵安裝 PalSchema 及其相依的 UE4SS(Okaetsu 的 experimental-palworld 版,
 *    PalSchema 強制此版,標準 UE4SS 會崩潰),並設定 UE4SS-settings.ini / mods.txt。
 *  - 讀/寫我們自管的 PalSchema 子 mod,以 raw DataTable patch 改 DT_PalMonsterParameter
 *    的物種基礎數值(HP / 攻防 / 捕獲率…),首領版(Boss_)是獨立 row 可單獨調。
 *
 * 只有我們這個子 mod 的 raw/pal-stats.json 由 GUI 管理;寫入採「只覆寫受管欄位、
 * 保留其餘 row/欄位」策略,使用者手動加的內容不會被吃掉。改動在伺服器重啟後生效。
 * Docs / 欄位證據:.claude/notes/palschema-reference.md、palschema-datatable-fields.md
 */

const OUR_MOD_NAME = "PalServerGUI";
/** PalSchema 需要在 UE4SS mods.txt/json 啟用的內建 mod。 */
const REQUIRED_UE4SS_MODS = [
  "CheatManagerEnablerMod",
  "ConsoleCommandsMod",
  "ConsoleEnablerMod",
  "BPModLoaderMod",
  "BPML_GenericFunctions",
];

const win64Dir = (root: string) => path.join(root, "Pal", "Binaries", "Win64");
/** UE4SS 目錄:fork 用大寫 UE4SS/,舊/標準安裝可能是小寫 ue4ss/。 */
const ue4ssDir = (root: string) => {
  const upper = path.join(win64Dir(root), "UE4SS");
  const lower = path.join(win64Dir(root), "ue4ss");
  if (fs.existsSync(upper)) return upper;
  if (fs.existsSync(lower)) return lower;
  return upper; // 安裝 fork 後會是大寫
};
const ue4ssModsDir = (root: string) => path.join(ue4ssDir(root), "Mods");
const palSchemaDir = (root: string) => path.join(ue4ssModsDir(root), "PalSchema");
/** 停用時的存放處(UE4SS 只掃 Mods/,搬出來就一定不載入;內容原封不動)。 */
const palSchemaDisabledDir = (root: string) => path.join(ue4ssDir(root), "Mods-disabled", "PalSchema");
/** 讀取用:回傳 mod 實際所在(啟用中優先)與啟用狀態。 */
function palSchemaWhere(root: string): { dir: string | null; enabled: boolean } {
  if (fs.existsSync(palSchemaDir(root))) return { dir: palSchemaDir(root), enabled: true };
  if (fs.existsSync(palSchemaDisabledDir(root))) return { dir: palSchemaDisabledDir(root), enabled: false };
  return { dir: null, enabled: false };
}
const ourModDir = (root: string) => path.join(palSchemaDir(root), "mods", OUR_MOD_NAME);
const rawDir = (root: string) => path.join(ourModDir(root), "raw");
const statsFile = (root: string) => path.join(rawDir(root), "pal-stats.json");
const ue4ssSettingsFile = (root: string) => path.join(ue4ssDir(root), "UE4SS-settings.ini");
const modsTxtFile = (root: string) => path.join(ue4ssModsDir(root), "mods.txt");
const markerFile = (root: string) => path.join(win64Dir(root), ".palserver-palschema.json");
/** PalSchema 自己的設定檔(enableAutoReload 等;官方文件 /docs/configuration)。 */
const palSchemaConfigFile = (root: string) => path.join(palSchemaDir(root), "config", "config.json");
const WIN64_REL = "Pal/Binaries/Win64";
const UE4SS_UPPER_REL = `${WIN64_REL}/UE4SS`;
const UE4SS_LOWER_REL = `${WIN64_REL}/ue4ss`;
const PALSCHEMA_REL = (ue4ss: string) => `${ue4ss}/Mods/PalSchema`;
const OUR_MOD_REL = (ue4ss: string) => `${PALSCHEMA_REL(ue4ss)}/mods/${OUR_MOD_NAME}`;
const RAW_REL = (ue4ss: string) => `${OUR_MOD_REL(ue4ss)}/raw`;
const STATS_REL = (ue4ss: string) => `${RAW_REL(ue4ss)}/pal-stats.json`;
const CONFIG_REL = (ue4ss: string) => `${PALSCHEMA_REL(ue4ss)}/config/config.json`;
const MARKER_REL = `${WIN64_REL}/.palserver-palschema.json`;

/** UE4SS 是否已安裝(不區分 fork/標準;安裝流程會補上 fork)。 */
function ue4ssInstalled(root: string): boolean {
  return (
    fs.existsSync(path.join(ue4ssDir(root), "UE4SS.dll")) ||
    fs.existsSync(path.join(win64Dir(root), "UE4SS.dll")) ||
    fs.existsSync(path.join(win64Dir(root), "ue4ss", "UE4SS.dll"))
  );
}

interface PalSchemaMarker {
  ue4ss?: string;
  palschema?: string;
}
function readMarker(root: string): PalSchemaMarker {
  try {
    return JSON.parse(fs.readFileSync(markerFile(root), "utf8")) as PalSchemaMarker;
  } catch {
    return {};
  }
}
function writeMarker(root: string, patch: PalSchemaMarker): void {
  fs.writeFileSync(markerFile(root), JSON.stringify({ ...readMarker(root), ...patch }, null, 2));
}

export async function getPalSchemaStatus(rec: InstanceRecord, ctx: DriverContext): Promise<PalSchemaStatus> {
  if (serverPlatform(rec) !== "windows") {
    return { supported: false, reason: "PalSchema 僅支援 Windows 伺服器", ue4ss: false, installed: false, version: null };
  }
  if (rec.backend === "k8s") {
    if (!(await runtimeExists(rec, ctx, WIN64_REL, "d"))) {
      return { supported: false, reason: "伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器", ue4ss: false, installed: false, version: null };
    }
    const ue4ss = await k8sUe4ssRel(rec, ctx);
    const marker = await readMarkerRuntime(rec, ctx);
    const installed = await runtimeExists(rec, ctx, PALSCHEMA_REL(ue4ss), "d");
    return {
      supported: true,
      ue4ss: await runtimeExists(rec, ctx, `${ue4ss}/UE4SS.dll`, "f") || await runtimeExists(rec, ctx, `${WIN64_REL}/UE4SS.dll`, "f"),
      installed,
      version: marker.palschema ?? null,
      autoReload: installed ? await readAutoReloadRuntime(rec, ctx, ue4ss) : false,
    };
  }
  const root = serverRoot(rec, ctx);
  if (!fs.existsSync(win64Dir(root))) {
    return { supported: false, reason: "伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器", ue4ss: false, installed: false, version: null };
  }
  const marker = readMarker(root);
  const where = palSchemaWhere(root);
  return {
    supported: true,
    ue4ss: ue4ssInstalled(root),
    installed: where.dir !== null,
    version: marker.palschema ?? null,
    autoReload: where.enabled && readAutoReload(root),
    enabled: where.dir !== null ? where.enabled : undefined,
  };
}

async function k8sUe4ssRel(rec: InstanceRecord, ctx: DriverContext): Promise<string> {
  if (await runtimeExists(rec, ctx, UE4SS_UPPER_REL, "d")) return UE4SS_UPPER_REL;
  return UE4SS_LOWER_REL;
}

async function readMarkerRuntime(rec: InstanceRecord, ctx: DriverContext): Promise<PalSchemaMarker> {
  if (rec.backend !== "k8s") return readMarker(serverRoot(rec, ctx));
  try {
    return JSON.parse(await runtimeReadText(rec, ctx, MARKER_REL)) as PalSchemaMarker;
  } catch {
    return {};
  }
}

async function writeMarkerRuntime(rec: InstanceRecord, ctx: DriverContext, patch: PalSchemaMarker): Promise<void> {
  if (rec.backend !== "k8s") {
    writeMarker(serverRoot(rec, ctx), patch);
    return;
  }
  await runtimeWriteText(rec, ctx, MARKER_REL, JSON.stringify({ ...(await readMarkerRuntime(rec, ctx)), ...patch }, null, 2));
}

/* ── 純函式(單元測試用),不碰 fs ── */

/** 設定 UE4SS-settings.ini 的鍵:存在則就地覆寫、不存在則附加。保留其餘內容。 */
export function patchIniKeys(text: string, kv: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(kv)) {
    const re = new RegExp(`^([ \\t]*)${key}[ \\t]*=.*$`, "m");
    if (re.test(out)) out = out.replace(re, `$1${key} = ${value}`);
    else out = `${out.replace(/\s*$/, "")}\n${key} = ${value}\n`;
  }
  return out;
}

/** 把指定 mod 在 mods.txt 設為啟用(`Name : 1`);已存在就改值,否則附加。 */
export function enableModsTxt(text: string, names: string[]): string {
  const lines = text.length ? text.split("\n") : [];
  for (const name of names) {
    const idx = lines.findIndex((l) => l.trim().match(new RegExp(`^${name}\\s*:`)));
    const flag = `${name} : 1`;
    if (idx >= 0) lines[idx] = flag;
    else lines.push(flag);
  }
  return lines.join("\n");
}

/** 把一列數值合併進既有 raw 結構:只覆寫白名單內的欄位,保留其他 table/row/欄位。 */
export function mergeStatsPatch(
  existing: Record<string, unknown>,
  table: string,
  row: string,
  patch: PalStatValues,
): Record<string, unknown> {
  const next = structuredClone(existing);
  const tbl = (next[table] && typeof next[table] === "object" ? next[table] : {}) as Record<string, unknown>;
  const rowObj = (tbl[row] && typeof tbl[row] === "object" ? tbl[row] : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if ((PAL_STAT_OPTIONS as Record<string, unknown>)[k] && typeof v === "number") {
      const meta = PAL_STAT_OPTIONS[k as PalStatKey];
      rowObj[meta.key] = meta.type === "int" ? Math.trunc(v) : v;
    }
  }
  tbl[row] = rowObj;
  next[table] = tbl;
  return next;
}

const ROW_RE = /^[A-Za-z0-9_]{1,80}$/;

/* ── 安裝 ── */

interface GitRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function resolveRelease(
  repo: string,
  tag: string | "latest",
  pick: (name: string) => boolean,
  envUrl: string,
): Promise<{ version: string; url: string }> {
  const override = process.env[envUrl];
  if (override) return { version: "custom", url: override };
  const endpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(endpoint, {
    headers: { "user-agent": "palserver-gui", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub release 查詢失敗 ${repo}@${tag}: HTTP ${res.status}`);
  const release = (await res.json()) as GitRelease;
  const asset = release.assets.find((a) => pick(a.name));
  if (!asset) {
    throw new Error(`在 ${repo}@${release.tag_name} 找不到對應下載檔;可設 ${envUrl} 指定網址`);
  }
  return { version: release.tag_name, url: asset.browser_download_url };
}

async function downloadZip(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下載失敗: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * 安裝 PalSchema + 其相依 UE4SS(experimental-palworld fork)並完成設定。
 * 呼叫端需確保伺服器已停止(DLL 執行中會被鎖)。
 */
export async function installPalSchema(rec: InstanceRecord, ctx: DriverContext): Promise<{ version: string }> {
  const status = await getPalSchemaStatus(rec, ctx);
  if (!status.supported) throw Object.assign(new Error(status.reason ?? "unsupported"), { statusCode: 409 });
  if (rec.backend === "k8s") return installPalSchemaK8s(rec, ctx);
  const root = serverRoot(rec, ctx);

  // 風險轉變時點:best-effort 先備份當前世界(伺服器已停也能 tar;失敗不阻擋)。
  // 注意 activeWorldGuid 吃 Saved 根目錄,用 Async 版由 rec/ctx 正確解析。
  const guid = await activeWorldGuidAsync(rec, ctx);
  if (guid) await createBackup(rec, ctx, guid).catch(() => {});

  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  // 停用中就先搬回啟用位置,更新直接蓋在上面(不留兩份)
  try {
    setPalSchemaEnabled(rec, ctx, true);
  } catch {
    /* k8s 等不支援停用的路徑:忽略 */
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palschema-"));
  try {
    // 1) UE4SS fork(experimental-palworld;非 zDev 開發版)。內容相對 Win64 佈局。
    const ue4ss = await resolveRelease(
      "Okaetsu/RE-UE4SS",
      "experimental-palworld",
      (n) => /^UE4SS-Palworld\.zip$/i.test(n),
      "PALSERVER_UE4SS_PALWORLD_URL",
    );
    const ue4ssZip = path.join(tmp, "ue4ss.zip");
    await downloadZip(ue4ss.url, ue4ssZip);
    await extractZip(ue4ssZip, { dir: win64Dir(root) });
    if (!fs.existsSync(ue4ssDir(root))) {
      throw new Error("UE4SS 解壓後找不到 UE4SS 目錄,佈局可能有變;可設 PALSERVER_UE4SS_PALWORLD_URL");
    }

    // 2) UE4SS 設定:PalSchema 要求 dx11 + 關閉 UObjectArray 快取。
    const settings = ue4ssSettingsFile(root);
    if (fs.existsSync(settings)) {
      fs.writeFileSync(
        settings,
        patchIniKeys(fs.readFileSync(settings, "utf8"), {
          GraphicsAPI: "dx11",
          bUseUObjectArrayCache: "false",
        }),
      );
    }
    // 3) 啟用必要的內建 mod。
    fs.mkdirSync(ue4ssModsDir(root), { recursive: true });
    const modsTxt = modsTxtFile(root);
    const modsTxtText = fs.existsSync(modsTxt) ? fs.readFileSync(modsTxt, "utf8") : "";
    fs.writeFileSync(modsTxt, enableModsTxt(modsTxtText, REQUIRED_UE4SS_MODS));

    // 4) PalSchema 本體:zip 頂層即 PalSchema/,解壓進 Mods/。
    const ps = await resolveRelease(
      "Okaetsu/PalSchema",
      "latest",
      (n) => /\.zip$/i.test(n) && !/source/i.test(n),
      "PALSERVER_PALSCHEMA_URL",
    );
    const psZip = path.join(tmp, "palschema.zip");
    await downloadZip(ps.url, psZip);
    await extractZip(psZip, { dir: ue4ssModsDir(root) });
    if (!fs.existsSync(palSchemaDir(root))) {
      throw new Error("PalSchema 解壓後找不到 PalSchema 目錄,佈局可能有變;可設 PALSERVER_PALSCHEMA_URL");
    }

    // 5) 建立我們自管的子 mod(metadata.json + raw/)。
    scaffoldOurMod(root);
    // 6) 開啟 auto-reload:運行中改數值即熱重載,免重啟(raw table 需 PalSchema ≥0.5.0)。
    enableAutoReload(root);

    writeMarker(root, { ue4ss: ue4ss.version, palschema: ps.version });
    return { version: ps.version };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** k8s: stage the releases on the agent, then copy the same Win64 layout into the PVC. */
async function installPalSchemaK8s(rec: InstanceRecord, ctx: DriverContext): Promise<{ version: string }> {
  const guid = await activeWorldGuidAsync(rec, ctx);
  if (guid) await createBackup(rec, ctx, guid).catch(() => {});

  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palschema-k8s-"));
  try {
    const ue4ss = await resolveRelease(
      "Okaetsu/RE-UE4SS",
      "experimental-palworld",
      (n) => /^UE4SS-Palworld\.zip$/i.test(n),
      "PALSERVER_UE4SS_PALWORLD_URL",
    );
    const ue4ssZip = path.join(tmp, "ue4ss.zip");
    const win64Stage = path.join(tmp, "win64");
    fs.mkdirSync(win64Stage, { recursive: true });
    await downloadZip(ue4ss.url, ue4ssZip);
    await extractZip(ue4ssZip, { dir: win64Stage });
    const stagedUe4ss = fs.existsSync(path.join(win64Stage, "UE4SS"))
      ? "UE4SS"
      : fs.existsSync(path.join(win64Stage, "ue4ss")) ? "ue4ss" : null;
    if (!stagedUe4ss) {
      throw new Error("UE4SS 解壓後找不到 UE4SS 目錄,佈局可能有變;可設 PALSERVER_UE4SS_PALWORLD_URL");
    }
    await copyTreeToPod(rec, win64Stage, WIN64_REL);
    const ue4ssRel = `${WIN64_REL}/${stagedUe4ss}`;

    const settingsRel = `${ue4ssRel}/UE4SS-settings.ini`;
    if (await runtimeExists(rec, ctx, settingsRel, "f")) {
      await runtimeWriteText(
        rec,
        ctx,
        settingsRel,
        patchIniKeys(await runtimeReadText(rec, ctx, settingsRel), {
          GraphicsAPI: "dx11",
          bUseUObjectArrayCache: "false",
        }),
      );
    }

    const modsRel = `${ue4ssRel}/Mods`;
    await runtimeMkdir(rec, ctx, modsRel);
    const modsTxtRel = `${modsRel}/mods.txt`;
    const modsTxt = await runtimeExists(rec, ctx, modsTxtRel, "f")
      ? await runtimeReadText(rec, ctx, modsTxtRel)
      : "";
    await runtimeWriteText(rec, ctx, modsTxtRel, enableModsTxt(modsTxt, REQUIRED_UE4SS_MODS));

    const ps = await resolveRelease(
      "Okaetsu/PalSchema",
      "latest",
      (n) => /\.zip$/i.test(n) && !/source/i.test(n),
      "PALSERVER_PALSCHEMA_URL",
    );
    const psZip = path.join(tmp, "palschema.zip");
    const psStage = path.join(tmp, "palschema");
    fs.mkdirSync(psStage, { recursive: true });
    await downloadZip(ps.url, psZip);
    await extractZip(psZip, { dir: psStage });
    if (!fs.existsSync(path.join(psStage, "PalSchema"))) {
      throw new Error("PalSchema 解壓後找不到 PalSchema 目錄,佈局可能有變;可設 PALSERVER_PALSCHEMA_URL");
    }
    await copyTreeToPod(rec, psStage, modsRel);
    await scaffoldOurModK8s(rec, ctx, ue4ssRel);
    // 開啟 auto-reload:運行中改數值即熱重載,免重啟(raw table 需 PalSchema ≥0.5.0)。
    await enableAutoReloadRuntime(rec, ctx, ue4ssRel).catch(() => {});
    await writeMarkerRuntime(rec, ctx, { ue4ss: ue4ss.version, palschema: ps.version });
    return { version: ps.version };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function copyTreeToPod(rec: InstanceRecord, localDir: string, remoteRel: string): Promise<void> {
  await makeDirInPod(rec, remoteRel);
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteRel}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyTreeToPod(rec, localPath, remotePath);
    } else {
      await writeFileBytesInPod(rec, remotePath, fs.readFileSync(localPath));
    }
  }
}

/** 讀 PalSchema config 的 enableAutoReload(檔案缺失或壞檔 → false = PalSchema 預設)。
 *  (export 供單元測試;mac 開發機跑不到 native 分支。) */
export function readAutoReload(root: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(palSchemaConfigFile(root), "utf8")).enableAutoReload === true;
  } catch {
    return false;
  }
}

async function readAutoReloadRuntime(rec: InstanceRecord, ctx: DriverContext, ue4ss: string): Promise<boolean> {
  try {
    return JSON.parse(await runtimeReadText(rec, ctx, CONFIG_REL(ue4ss))).enableAutoReload === true;
  } catch {
    return false;
  }
}

/** 開啟 PalSchema 的 auto-reload(檔案監看,存檔即熱重載;raw table 自 v0.5.0 支援)。
 *  merge 寫入,保留 languageOverride 等其他設定鍵。 */
export function enableAutoReload(root: string): void {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(palSchemaConfigFile(root), "utf8"));
  } catch {
    /* 尚未生成 → 從空物件開始,缺的鍵 PalSchema 自己補預設 */
  }
  if (cfg.enableAutoReload === true) return;
  cfg.enableAutoReload = true;
  fs.mkdirSync(path.dirname(palSchemaConfigFile(root)), { recursive: true });
  fs.writeFileSync(palSchemaConfigFile(root), JSON.stringify(cfg, null, 2));
}

async function enableAutoReloadRuntime(rec: InstanceRecord, ctx: DriverContext, ue4ss: string): Promise<void> {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await runtimeReadText(rec, ctx, CONFIG_REL(ue4ss)));
  } catch {
    /* 同上 */
  }
  if (cfg.enableAutoReload === true) return;
  cfg.enableAutoReload = true;
  await runtimeMkdir(rec, ctx, `${PALSCHEMA_REL(ue4ss)}/config`);
  await runtimeWriteText(rec, ctx, CONFIG_REL(ue4ss), JSON.stringify(cfg, null, 2));
}

/** 暫時停用/啟用 PalSchema(不刪檔):整個資料夾搬進/搬出 Mods-disabled/。 */
export function setPalSchemaEnabled(rec: InstanceRecord, ctx: DriverContext, enabled: boolean): void {
  if (rec.backend !== "native" || process.platform !== "win32") {
    throw Object.assign(new Error("停用/啟用僅支援 Windows 原生模式"), { statusCode: 409 });
  }
  const root = serverRoot(rec, ctx);
  const active = palSchemaDir(root);
  const off = palSchemaDisabledDir(root);
  if (enabled && !fs.existsSync(active) && fs.existsSync(off)) {
    fs.renameSync(off, active);
  } else if (!enabled && fs.existsSync(active)) {
    fs.mkdirSync(path.dirname(off), { recursive: true });
    fs.rmSync(off, { recursive: true, force: true }); // 清掉舊殘留,避免 rename 失敗
    fs.renameSync(active, off);
  }
}

function scaffoldOurMod(root: string): void {
  fs.mkdirSync(rawDir(root), { recursive: true });
  const meta = path.join(ourModDir(root), "metadata.json");
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(
      meta,
      JSON.stringify(
        { name: OUR_MOD_NAME, authors: ["palserver-gui"], description: "GUI 管理的物種數值調整", version: "1.0.0" },
        null,
        2,
      ),
    );
  }
}

async function scaffoldOurModK8s(rec: InstanceRecord, ctx: DriverContext, ue4ssRel: string): Promise<void> {
  const modRel = OUR_MOD_REL(ue4ssRel);
  await runtimeMkdir(rec, ctx, RAW_REL(ue4ssRel));
  const metadataRel = `${modRel}/metadata.json`;
  if (!(await runtimeExists(rec, ctx, metadataRel, "f"))) {
    await runtimeWriteText(
      rec,
      ctx,
      metadataRel,
      JSON.stringify(
        { name: OUR_MOD_NAME, authors: ["palserver-gui"], description: "GUI 管理的物種數值調整", version: "1.0.0" },
        null,
        2,
      ),
    );
  }
}

/** 移除 PalSchema 本體與我們的子 mod;保留 UE4SS(其他 mod 可能還要用)。 */
export async function removePalSchema(rec: InstanceRecord, ctx: DriverContext): Promise<void> {
  if (rec.backend === "k8s") {
    const ue4ss = await k8sUe4ssRel(rec, ctx);
    await runtimeRemove(rec, ctx, PALSCHEMA_REL(ue4ss));
    const marker = await readMarkerRuntime(rec, ctx);
    delete marker.palschema;
    await runtimeWriteText(rec, ctx, MARKER_REL, JSON.stringify(marker, null, 2));
    return;
  }
  const root = serverRoot(rec, ctx);
  fs.rmSync(palSchemaDir(root), { recursive: true, force: true });
  const marker = readMarker(root);
  delete marker.palschema;
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2));
}

/* ── 數值讀寫 ── */

function readStatsRaw(root: string): Record<string, unknown> {
  const where = palSchemaWhere(root);
  if (!where.dir) return {};
  try {
    const file = path.join(where.dir, "mods", OUR_MOD_NAME, "raw", "pal-stats.json");
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readStatsRawRuntime(
  rec: InstanceRecord,
  ctx: DriverContext,
  ue4ss: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await runtimeReadText(rec, ctx, STATS_REL(ue4ss))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 把 raw 結構裡的一 table 轉成 {row, values(白名單且為數字)} 列表。 */
function rowsFromRaw(raw: Record<string, unknown>): PalStatsRow[] {
  const tbl = raw[PAL_STATS_TABLE];
  if (!tbl || typeof tbl !== "object") return [];
  const out: PalStatsRow[] = [];
  for (const [row, obj] of Object.entries(tbl as Record<string, unknown>)) {
    if (!obj || typeof obj !== "object") continue;
    const values: PalStatValues = {};
    for (const k of PAL_STAT_KEYS) {
      const raw2 = (obj as Record<string, unknown>)[PAL_STAT_OPTIONS[k].key];
      if (typeof raw2 === "number") values[k] = raw2;
    }
    if (Object.keys(values).length) out.push({ row, values });
  }
  return out;
}

export async function getPalStats(rec: InstanceRecord, ctx: DriverContext): Promise<PalStatsStatus> {
  const schema = await getPalSchemaStatus(rec, ctx);
  if (!schema.supported) return { supported: false, reason: schema.reason, schema, rows: [] };
  if (!schema.installed) {
    return { supported: false, reason: "尚未安裝 PalSchema", schema, rows: [] };
  }
  if (rec.backend === "k8s") {
    const ue4ss = await k8sUe4ssRel(rec, ctx);
    return { supported: true, schema, rows: rowsFromRaw(await readStatsRawRuntime(rec, ctx, ue4ss)) };
  }
  const root = serverRoot(rec, ctx);
  return { supported: true, schema, rows: rowsFromRaw(readStatsRaw(root)) };
}

/** 寫入(合併)一列物種數值。row 必須是 DataTable 的 RowName(如 Anubis / Boss_Anubis)。 */
export async function writePalStats(
  rec: InstanceRecord,
  ctx: DriverContext,
  row: string,
  patch: PalStatValues,
): Promise<PalStatsStatus> {
  const schema = await getPalSchemaStatus(rec, ctx);
  if (!schema.supported) throw Object.assign(new Error(schema.reason ?? "unsupported"), { statusCode: 409 });
  if (!schema.installed) throw Object.assign(new Error("尚未安裝 PalSchema"), { statusCode: 409 });
  if (!ROW_RE.test(row)) throw Object.assign(new Error("無效的帕魯 row 名"), { statusCode: 400 });

  if (rec.backend === "k8s") {
    const ue4ss = await k8sUe4ssRel(rec, ctx);
    await scaffoldOurModK8s(rec, ctx, ue4ss);
    await enableAutoReloadRuntime(rec, ctx, ue4ss).catch(() => {}); // 舊安裝補開;失敗不擋寫入
    const merged = mergeStatsPatch(await readStatsRawRuntime(rec, ctx, ue4ss), PAL_STATS_TABLE, row, patch);
    await runtimeWriteText(rec, ctx, STATS_REL(ue4ss), JSON.stringify(merged, null, 4));
    return { supported: true, schema: await getPalSchemaStatus(rec, ctx), rows: rowsFromRaw(merged) };
  }
  const root = serverRoot(rec, ctx);
  if (schema.enabled === false) {
    throw Object.assign(new Error("PalSchema 目前已停用 — 先按「啟用」再修改數值"), { statusCode: 409 });
  }
  scaffoldOurMod(root); // 確保 raw/ 目錄存在(安裝後理應已在)
  try {
    enableAutoReload(root); // 舊安裝補開;失敗不擋寫入
  } catch {
    /* noop */
  }
  const merged = mergeStatsPatch(readStatsRaw(root), PAL_STATS_TABLE, row, patch);
  fs.writeFileSync(statsFile(root), JSON.stringify(merged, null, 4));
  return { supported: true, schema: await getPalSchemaStatus(rec, ctx), rows: rowsFromRaw(merged) };
}

/** 清空所有已寫入的物種數值調整(移除受管 table),PalSchema 本體保留。
 *  刻意不做贊助者 gate:讓「贊助→取消贊助」的使用者也能把數值改回原本設定。 */
export async function clearPalStats(rec: InstanceRecord, ctx: DriverContext): Promise<PalStatsStatus> {
  const schema = await getPalSchemaStatus(rec, ctx);
  if (!schema.supported) throw Object.assign(new Error(schema.reason ?? "unsupported"), { statusCode: 409 });
  if (!schema.installed) throw Object.assign(new Error("尚未安裝 PalSchema"), { statusCode: 409 });
  if (rec.backend === "k8s") {
    const ue4ss = await k8sUe4ssRel(rec, ctx);
    await scaffoldOurModK8s(rec, ctx, ue4ss);
    const raw = await readStatsRawRuntime(rec, ctx, ue4ss);
    delete raw[PAL_STATS_TABLE];
    await runtimeWriteText(rec, ctx, STATS_REL(ue4ss), JSON.stringify(raw, null, 4));
    return { supported: true, schema, rows: rowsFromRaw(raw) };
  }
  const root = serverRoot(rec, ctx);
  if (schema.enabled === false) {
    throw Object.assign(new Error("PalSchema 目前已停用 — 先按「啟用」再刪除調整"), { statusCode: 409 });
  }
  scaffoldOurMod(root);
  const raw = readStatsRaw(root);
  delete raw[PAL_STATS_TABLE];
  fs.writeFileSync(statsFile(root), JSON.stringify(raw, null, 4));
  return { supported: true, schema, rows: rowsFromRaw(raw) };
}
