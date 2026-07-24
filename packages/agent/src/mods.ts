import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extractZip from "extract-zip";
import type { ModComponent, ModsStatus } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverPlatform } from "./platform.js";
import { serverRoot } from "./native.js";
import * as dockerOps from "./docker.js";
import { execInPod, readFileInPod, writeFileBytesInPod, makeDirInPod, deletePathInPod } from "./k8s-files.js";

/**
 * Mod management for native instances (the v1 headline feature, rebuilt):
 *  - PalDefender (formerly PalGuard): standalone anti-cheat, extracted into
 *    Pal/Binaries/Win64 (PalDefender.dll + d3d9.dll proxy loader); its config
 *    tree self-generates under Win64/PalDefender on first boot.
 *    Docs: https://ultimeit.github.io/PalDefender/
 *  - UE4SS: Lua/Blueprint mod loader, extracted into the same dir
 *    (dwmapi.dll + ue4ss/). Lua mods live in ue4ss/Mods, toggled via mods.txt.
 * Both are fetched from their GitHub latest release (URL overridable via env).
 */

const GH_REPOS: Record<
  ModComponent,
  { repo: string; asset: RegExp; betaAsset?: RegExp; tag?: string; envUrl: string }
> = {
  ue4ss: {
    // Palworld 專用的 Okaetsu fork(experimental-palworld);與 PalSchema 用的同一份,
    // 相容性比上游標準 UE4SS 好。此 release 是固定 tag(非版本號),用 tag 直接鎖定。
    repo: "Okaetsu/RE-UE4SS",
    tag: "experimental-palworld",
    asset: /^UE4SS-Palworld\.zip$/i, // 標準版
    betaAsset: /^UE4SS-Palworld_zDev\.zip$/i, // 開發版(含除錯主控台/工具,體積較大)
    envUrl: "PALSERVER_UE4SS_URL",
  },
  paldefender: {
    // The wiki names the asset PalDefender_Windows.zip but releases currently
    // ship it as PalDefender.zip — accept both.
    repo: "Ultimeit/PalDefender",
    asset: /^PalDefender(_Windows)?\.zip$/i,
    envUrl: "PALSERVER_PALDEFENDER_URL",
  },
};

const win64Dir = (root: string) => path.join(root, "Pal", "Binaries", "Win64");

/** mod 下載逾時(毫秒):卡住的下載超過這個時間就中止並報錯,避免永遠掛著、累積佔連線。
 *  大檔(UE4SS ~7MB)在正常網路幾秒完成;限速地區走鏡像。3 分鐘是留裕度的上限。 */
const MOD_DOWNLOAD_TIMEOUT_MS = 180_000;

/** Container/Pod 內的遊戲根目錄（docker/k8s Wine image = /palworld, 同 thijsvanloef 慣例）。 */
const CONTAINER_INSTALL_DIR = "/palworld";
const CONTAINER_WIN64_DIR = `${CONTAINER_INSTALL_DIR}/Pal/Binaries/Win64`;
/** k8s writeFileInPod 需要 resolvePodPath 相對路徑（會加 /palworld 前綴）。 */
const POD_WIN64_REL = "Pal/Binaries/Win64";

/** docker/k8s 下用 exec 偵測檔案是否存在。 */
async function fileExistsInRuntime(rec: InstanceRecord, filePath: string): Promise<boolean> {
  if (rec.backend === "docker") {
    try {
      await dockerOps.execInContainer(rec, ["test", "-f", filePath]);
      return true;
    } catch {
      return false;
    }
  }
  if (rec.backend === "k8s") {
    try {
      await execInPod(rec, ["test", "-f", filePath]);
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(filePath);
}

/** Cheap fs check of which enhancements are installed, for instance summaries. */
export function installedEnhancements(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(win64Dir(root), "PalDefender.dll"))) out.push("PalDefender");
  if (
    fs.existsSync(path.join(win64Dir(root), "ue4ss", "UE4SS.dll")) ||
    fs.existsSync(path.join(win64Dir(root), "UE4SS.dll"))
  ) {
    out.push("UE4SS");
  }
  return out;
}
/** UE4SS mods dir — new layout (ue4ss/Mods) or the flat pre-3.1 layout (Mods). */
const ue4ssModsDir = (root: string) => {
  const nested = path.join(win64Dir(root), "ue4ss", "Mods");
  return fs.existsSync(nested) ? nested : path.join(win64Dir(root), "Mods");
};
const paksDir = (root: string) => path.join(root, "Pal", "Content", "Paks");
/** Marker recording which versions the GUI installed, plus the top-level
 * files each component's archive extracted — so uninstall removes exactly
 * those. Older markers only carry the version strings. */
interface ModsMarker {
  paldefender?: string;
  ue4ss?: string;
  files?: Partial<Record<ModComponent, string[]>>;
}
const markerFile = (root: string) => path.join(win64Dir(root), ".palserver-mods.json");

function readMarker(root: string): ModsMarker {
  try {
    return JSON.parse(fs.readFileSync(markerFile(root), "utf8")) as ModsMarker;
  } catch {
    return {};
  }
}

function writeMarker(root: string, component: ModComponent, version: string, files?: string[]): void {
  const marker = readMarker(root);
  marker[component] = version;
  if (files) marker.files = { ...(marker.files ?? {}), [component]: files };
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2));
}

async function extractZipTracked(zipPath: string, dir: string): Promise<string[]> {
  const top = new Set<string>();
  await extractZip(zipPath, {
    dir,
    onEntry: (entry) => {
      const seg = entry.fileName.replace(/^\.\//, "").split(/[\\/]/)[0];
      if (seg) top.add(seg);
    },
  });
  return [...top];
}

/** Fallback removal set for mods installed before we tracked files. Excludes
 * any shared proxy DLL to avoid breaking the other component. */
const DEFAULT_MOD_FILES: Record<ModComponent, string[]> = {
  paldefender: ["PalDefender.dll", "PalDefender"],
  ue4ss: ["UE4SS.dll", "UE4SS-settings.ini", "ue4ss", "Mods"],
};

const DISABLED_SUFFIX = ".palserver-disabled";

/** 各元件「停用時改名」的目標 DLL(相對 win64)。 */
const DISABLE_TARGETS: Record<ModComponent, string[]> = {
  ue4ss: ["UE4SS.dll", "ue4ss/UE4SS.dll", "UE4SS/UE4SS.dll"],
  paldefender: ["PalDefender.dll"],
};

function componentState(root: string, component: ModComponent): { installed: boolean; enabled: boolean } {
  let active = false;
  let disabled = false;
  for (const rel of DISABLE_TARGETS[component]) {
    if (fs.existsSync(path.join(win64Dir(root), rel))) active = true;
    if (fs.existsSync(path.join(win64Dir(root), rel + DISABLED_SUFFIX))) disabled = true;
  }
  return { installed: active || disabled, enabled: active };
}

/** 暫時停用/重新啟用(不刪任何檔):把主 DLL 改名加 .palserver-disabled 尾碼。
 *  改版日的安全退路 —— 移除會連使用者的 Lua 模組一起刪,停用不會。
 *  僅支援 native Windows(檔案就在本機);需伺服器停止(DLL 鎖定)。 */
export function setModEnabled(rec: InstanceRecord, ctx: DriverContext, component: ModComponent, enabled: boolean): void {
  if (rec.backend !== "native" || process.platform !== "win32") {
    throw Object.assign(new Error("停用/啟用僅支援 Windows 原生模式"), { statusCode: 409 });
  }
  const root = serverRoot(rec, ctx);
  for (const rel of DISABLE_TARGETS[component]) {
    const active = path.join(win64Dir(root), rel);
    const off = active + DISABLED_SUFFIX;
    if (enabled && fs.existsSync(off)) fs.renameSync(off, active);
    if (!enabled && fs.existsSync(active)) fs.renameSync(active, off);
  }
}

export async function getModsStatus(rec: InstanceRecord, ctx: DriverContext): Promise<ModsStatus> {
  const unsupported = (reason: string, serverInstalled = true): ModsStatus => ({
    supported: false,
    reason,
    serverInstalled,
    ue4ss: { installed: false, version: null },
    paldefender: { installed: false, version: null },
    luaMods: [],
    luaModsDir: null,
    pakMods: [],
  });

  if (serverPlatform(rec) !== "windows") {
    return unsupported("模組管理需要 Windows 伺服器(UE4SS/PalDefender 是 Windows DLL,在非 Windows binary 上無法載入)");
  }

  // docker/k8s: 容器/Pod 內 exec 偵測（host fs 看不到容器內的 Win64 目錄）。
  if (rec.backend === "docker" || rec.backend === "k8s") {
    const paldefenderInstalled = await fileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/PalDefender.dll`);
    const ue4ssInstalled =
      await fileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/ue4ss/UE4SS.dll`) ||
      await fileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/UE4SS.dll`);
    return {
      supported: true,
      ue4ss: { installed: ue4ssInstalled, version: null },
      paldefender: { installed: paldefenderInstalled, version: null },
      luaMods: [],
      luaModsDir: null,
      pakMods: [],
    };
  }

  const root = serverRoot(rec, ctx);
  if (!fs.existsSync(win64Dir(root))) {
    return unsupported("伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器", false);
  }

  const marker = readMarker(root);
  const ue4ssState = componentState(root, "ue4ss");
  const paldefenderState = componentState(root, "paldefender");
  const ue4ssInstalled = ue4ssState.installed;
  const paldefenderInstalled = paldefenderState.installed;

  const modsDir = ue4ssModsDir(root);
  return {
    supported: true,
    serverInstalled: true,
    ue4ss: { installed: ue4ssInstalled, version: marker.ue4ss ?? null, enabled: ue4ssState.enabled },
    paldefender: { installed: paldefenderInstalled, version: marker.paldefender ?? null, enabled: paldefenderState.enabled },
    luaMods: listLuaMods(root),
    luaModsDir: fs.existsSync(modsDir)
      ? path.relative(root, modsDir).split(path.sep).join("/")
      : null,
    pakMods: listPakMods(root),
  };
}

function listLuaMods(root: string): { name: string; enabled: boolean }[] {
  const dir = ue4ssModsDir(root);
  if (!fs.existsSync(dir)) return [];
  const enabledFromTxt = parseModsTxt(root);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => ({
      name: e.name,
      enabled:
        enabledFromTxt.get(e.name) === true ||
        fs.existsSync(path.join(dir, e.name, "enabled.txt")),
    }));
}

function parseModsTxt(root: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const file = path.join(ue4ssModsDir(root), "mods.txt");
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.trim().match(/^([\w-]+)\s*:\s*([01])$/);
    if (match) result.set(match[1], match[2] === "1");
  }
  return result;
}

function listPakMods(root: string): string[] {
  const results: string[] = [];
  const scan = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".pak") && !entry.name.startsWith("Pal-")) {
        results.push(prefix + entry.name);
      }
      if (entry.isDirectory() && entry.name === "LogicMods") {
        scan(path.join(dir, entry.name), "LogicMods/");
      }
    }
  };
  scan(paksDir(root), "");
  return results;
}

export function setLuaModEnabled(
  rec: InstanceRecord,
  ctx: DriverContext,
  name: string,
  enabled: boolean,
): void {
  const root = serverRoot(rec, ctx);
  const modDir = path.join(ue4ssModsDir(root), name);
  if (!/^[\w-]+$/.test(name) || !fs.existsSync(modDir)) {
    throw Object.assign(new Error(`unknown lua mod: ${name}`), { statusCode: 404 });
  }
  // enabled.txt overrides mods.txt, so clear it when disabling.
  if (!enabled) fs.rmSync(path.join(modDir, "enabled.txt"), { force: true });

  const file = path.join(ue4ssModsDir(root), "mods.txt");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const flag = `${name} : ${enabled ? 1 : 0}`;
  const idx = lines.findIndex((l) => l.trim().startsWith(`${name} `) || l.trim().startsWith(`${name}:`));
  if (idx >= 0) lines[idx] = flag;
  else lines.unshift(flag);
  fs.writeFileSync(file, lines.join("\n"));
}

interface GitRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: { name: string; browser_download_url: string; updated_at?: string }[];
}

/** release 的顯示版本。固定 tag 的元件(如 UE4SS Okaetsu experimental-palworld)tag 不會變,
 *  改用「標準資產的建置日期(updated_at)」當版本 —— 這樣才標得出版本、且 Okaetsu 重新上傳新
 *  建置時(同 tag、新日期)偵測得到「有新版」。非固定 tag 的元件照用 tag_name。 */
function releaseVersion(component: ModComponent, release: GitRelease): string {
  const cfg = GH_REPOS[component];
  if (cfg.tag) {
    const asset = release.assets.find((a) => cfg.asset.test(a.name));
    const date = asset?.updated_at?.slice(0, 10); // YYYY-MM-DD
    return date ? `${cfg.tag} (${date})` : cfg.tag;
  }
  return release.tag_name;
}

/** 各元件的最新穩定版 tag(6 小時記憶體快取;查詢失敗回 null,不丟錯)。
 *  給「有新版可更新」徽章用 —— 改版日玩家最需要知道模組能不能更了。 */
const latestCache = new Map<ModComponent, { tag: string | null; at: number }>();
const LATEST_TTL = 6 * 60 * 60 * 1000;
export async function latestModVersions(): Promise<Record<ModComponent, string | null>> {
  const out = {} as Record<ModComponent, string | null>;
  for (const component of ["ue4ss", "paldefender"] as ModComponent[]) {
    const hit = latestCache.get(component);
    if (hit && Date.now() - hit.at < LATEST_TTL) {
      out[component] = hit.tag;
      continue;
    }
    try {
      const cfg = GH_REPOS[component];
      // 固定 tag 的元件(如 UE4SS Okaetsu fork)直接查該 tag,否則查 latest。
      const endpoint = cfg.tag
        ? `https://api.github.com/repos/${cfg.repo}/releases/tags/${cfg.tag}`
        : `https://api.github.com/repos/${cfg.repo}/releases/latest`;
      const res = await fetch(endpoint, {
        headers: { "user-agent": "palserver-gui", accept: "application/vnd.github+json" },
      });
      const tag = res.ok ? releaseVersion(component, (await res.json()) as GitRelease) : null;
      latestCache.set(component, { tag, at: Date.now() });
      out[component] = tag;
    } catch {
      latestCache.set(component, { tag: null, at: Date.now() });
      out[component] = null;
    }
  }
  return out;
}

async function resolveDownload(
  component: ModComponent,
  channel: "stable" | "beta",
): Promise<{ version: string; url: string }> {
  const { repo, asset, betaAsset, tag, envUrl } = GH_REPOS[component];
  const override = process.env[envUrl];
  if (override) return { version: "custom", url: override };

  // 固定 tag 的元件(UE4SS Okaetsu fork = experimental-palworld)兩個通道都用同一 release,
  // 靠不同資產區分(stable=標準版、beta=zDev 開發版)。否則:stable="latest"(排除 pre-release)、
  // beta 掃 release 清單取最新(含 pre-release)。
  const endpoint = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
    : channel === "beta"
      ? `https://api.github.com/repos/${repo}/releases?per_page=15`
      : `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(endpoint, {
    headers: { "user-agent": "palserver-gui", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub release lookup failed for ${repo}: HTTP ${res.status}`);

  const body = await res.json();
  const release: GitRelease | undefined =
    !tag && channel === "beta" ? (body as GitRelease[]).filter((r) => !r.draft).at(0) : (body as GitRelease);
  if (!release) throw new Error(`no releases found for ${repo}`);

  // beta 通道若有專屬資產(如 UE4SS zDev)就用它,否則沿用標準資產。
  const pattern = channel === "beta" && betaAsset ? betaAsset : asset;
  const match = release.assets.find((a) => pattern.test(a.name));
  if (!match) {
    throw new Error(
      `no matching asset in ${repo}@${release.tag_name} (looked for ${pattern}); ` +
        `set ${envUrl} to pin a download URL`,
    );
  }
  return { version: releaseVersion(component, release), url: match.browser_download_url };
}

export async function installComponent(
  rec: InstanceRecord,
  ctx: DriverContext,
  component: ModComponent,
  channel: "stable" | "beta" = "stable",
  /** 直接指定下載 URL(繞過 GitHub release 解析);給限速地區走鏡像用。資產格式須與該元件相同。 */
  urlOverride?: string,
): Promise<{ version: string }> {
  const status = await getModsStatus(rec, ctx);
  if (!status.supported) {
    throw Object.assign(new Error(status.reason ?? "mods unsupported"), { statusCode: 409 });
  }

  const { version, url } = urlOverride
    ? { version: "custom", url: urlOverride }
    : await resolveDownload(component, channel);
  // 下載加逾時:沒有 signal 時,連線卡住(慢速 CDN / 對端不回)會讓 fetch 永遠掛著,
  // 且 HTTP 客戶端斷線也不會中止 server 端下載 → 卡住的下載會累積、佔住連線。逾時就中止並報錯。
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(MOD_DOWNLOAD_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw Object.assign(
        new Error(
          `下載逾時(超過 ${Math.round(MOD_DOWNLOAD_TIMEOUT_MS / 1000)}s):連線過慢或對端無回應。` +
            `限速地區可改用鏡像(install 帶 url,或設 ${GH_REPOS[component].envUrl})。來源:${url}`,
        ),
        { statusCode: 504 },
      );
    }
    throw e;
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  // docker/k8s: download to host, extract, then transfer into container/Pod.
  if (rec.backend === "docker" || rec.backend === "k8s") {
    return installComponentInRuntime(rec, component, version, zipBuffer);
  }

  // native: extract directly on host fs.
  const root = serverRoot(rec, ctx);
  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  const zipPath = path.join(ctx.instanceDir, `${component}.zip`);
  fs.writeFileSync(zipPath, zipBuffer);
  const files = await extractZipTracked(zipPath, win64Dir(root));
  fs.rmSync(zipPath, { force: true });
  writeMarker(root, component, version, files);
  return { version };
}

/** Install a mod component into a docker container or k8s Pod via exec/archive. */
async function installComponentInRuntime(
  rec: InstanceRecord,
  component: ModComponent,
  version: string,
  zipBuffer: Buffer,
): Promise<{ version: string }> {
  const containerWin64 = CONTAINER_WIN64_DIR;
  // PVC = /palworld (entire install persisted); DLLs survive Pod restarts.
  const persistentWin64 = containerWin64;
  // Extract on host to a temp dir, then transfer each file via exec.
  const tmpDir = path.join(os.tmpdir(), `palserver-mod-${component}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, `${component}.zip`), zipBuffer);
  const files = await extractZipTracked(path.join(tmpDir, `${component}.zip`), tmpDir);
  fs.rmSync(path.join(tmpDir, `${component}.zip`), { force: true });

  // Ensure Win64 dir exists (DepotDownloader may still be running on first boot).
  if (rec.backend === "docker") {
    await dockerOps.execInContainer(rec, ["mkdir", "-p", persistentWin64]);
  } else {
    // k8s: retry until Win64 exists (DepotDownloader creates it).
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const exists = await fileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/PalServer-Win64-Shipping-Cmd.exe`);
        if (exists) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 10000));
    }
    await execInPod(rec, ["mkdir", "-p", persistentWin64]);
  }

  // Transfer each extracted file/directory into the container/Pod.
  for (const rel of files) {
    const localPath = path.join(tmpDir, rel);
    const remotePath = `${persistentWin64}/${rel}`;
    if (fs.statSync(localPath).isDirectory()) {
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["mkdir", "-p", remotePath]);
      } else {
        await execInPod(rec, ["mkdir", "-p", remotePath]);
      }
      await transferDirToRuntime(rec, localPath, remotePath);
    } else {
      await transferFileToRuntime(rec, localPath, remotePath);
    }
  }

  // Clean up host temp.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { version };
}

async function transferFileToRuntime(rec: InstanceRecord, localPath: string, remotePath: string): Promise<void> {
  const data = fs.readFileSync(localPath);
  if (rec.backend === "docker") {
    // docker: putArchive or base64 over exec. Base64 is simpler for small DLLs.
    const b64 = data.toString("base64");
    await dockerOps.execInContainer(rec, ["sh", "-c", `echo '${b64}' | base64 -d > '${remotePath}'`]);
  } else {
    // k8s: writeFileBytesInPod uses resolvePodPath (prepends /palworld).
    const relPath = remotePath.replace(/^\/palworld\//, "");
    await writeFileBytesInPod(rec, relPath, data);
  }
}

async function transferDirToRuntime(rec: InstanceRecord, localDir: string, remoteDir: string): Promise<void> {
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["mkdir", "-p", remotePath]);
      } else {
        const relPath = remotePath.replace(/^\/palworld\//, "");
        await makeDirInPod(rec, relPath);
      }
      await transferDirToRuntime(rec, localPath, remotePath);
    } else {
      await transferFileToRuntime(rec, localPath, remotePath);
    }
  }
}

/** Uninstall a component: remove the files its install extracted (tracked in
 * the marker; falls back to known defaults for older installs). Never removes
 * a file the other still-installed component also claims, so removing one mod
 * can't break the other. Caller must ensure the server is stopped (DLLs are
 * locked while running). */
export async function removeComponent(
  rec: InstanceRecord,
  ctx: DriverContext,
  component: ModComponent,
): Promise<void> {
  const status = await getModsStatus(rec, ctx);
  if (!status.supported) {
    throw Object.assign(new Error(status.reason ?? "mods unsupported"), { statusCode: 409 });
  }

  // docker/k8s: remove files inside container/Pod via exec.
  if (rec.backend === "docker" || rec.backend === "k8s") {
    const other: ModComponent = component === "ue4ss" ? "paldefender" : "ue4ss";
    const keep = new Set(status[other].installed ? DEFAULT_MOD_FILES[other] : []);
    const targets = DEFAULT_MOD_FILES[component].filter((f) => !keep.has(f));
    for (const rel of targets) {
      const remotePath = `${CONTAINER_WIN64_DIR}/${rel}`;
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["rm", "-rf", remotePath]).catch(() => {});
      } else {
        // deletePathInPod uses resolvePodPath (prepends /palworld); strip prefix.
        const relPath = remotePath.replace(/^\/palworld\//, "");
        await deletePathInPod(rec, relPath).catch(() => {});
      }
    }
    return;
  }

  // native: remove on host fs.
  const root = serverRoot(rec, ctx);
  const w64 = win64Dir(root);
  const marker = readMarker(root);

  const other: ModComponent = component === "ue4ss" ? "paldefender" : "ue4ss";
  const keep = new Set(
    status[other].installed ? (marker.files?.[other] ?? DEFAULT_MOD_FILES[other]) : [],
  );
  const targets = (
    marker.files?.[component]?.length ? marker.files[component]! : DEFAULT_MOD_FILES[component]
  ).filter((f) => !keep.has(f));

  for (const rel of targets) {
    const p = path.resolve(w64, rel);
    if (p === w64 || !p.startsWith(w64 + path.sep)) continue;
    fs.rmSync(p, { recursive: true, force: true });
  }

  delete marker[component];
  if (marker.files) delete marker.files[component];
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2));
}
