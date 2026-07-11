/**
 * Cross-platform pak mod management.
 *
 * pak mods are loaded natively by Unreal Engine — no DLL injection needed.
 * Place `.pak` files under `Pal/Content/Paks/` and the engine loads them
 * on next boot. This works on Windows (native), Linux (docker/k8s) alike.
 *
 * Backend access:
 *  - native: host filesystem via serverRoot
 *  - docker: docker exec into container (Paks is NOT in bind-mount)
 *  - k8s: Pod exec (k8s-files.ts)
 */
import fs from "node:fs";
import path from "node:path";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";
import { execInPod, listDirInPod } from "./k8s-files.js";
import { execInContainer } from "./docker.js";

/** Container/Pod 內的 Paks 目錄絕對路徑。 */
const PAKS_CONTAINER = "/palworld/Pal/Content/Paks";
/** native host FS 的相對路徑（相對於 serverRoot）。 */
const PAKS_REL = "Pal/Content/Paks";

/** Relative pak path for a given backend. */
function paksPath(rec: InstanceRecord, ctx: DriverContext): string {
  if (rec.backend === "docker") {
    // docker bind-mount: saved = Pal/Saved; Content is NOT in bind-mount.
    // Paks directory is inside the container only — needs docker exec.
    // For now, return the host path that *would* be the server root.
    // (docker pak support requires exec; see TODO below)
    return path.join(serverRoot(rec, ctx), PAKS_REL);
  }
  return path.join(serverRoot(rec, ctx), PAKS_REL);
}

export interface PakMod {
  name: string;
  size: number;
  enabled: boolean;
}

/** List all pak mods (excluding the official Pal-*.pak). */
export async function listPakMods(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<PakMod[]> {
  // k8s + docker: exec into container/pod
  if (rec.backend === "k8s" || rec.backend === "docker") {
    try {
      const raw = rec.backend === "k8s"
        ? await listDirInPod(rec, PAKS_REL)
        : await execInContainer(rec, ["ls", "-1", PAKS_CONTAINER]);
      return raw
        .split("\n")
        .map((s) => s.trim())
        .filter((name) => name.endsWith(".pak") && !name.startsWith("Pal-"))
        .map((name) => ({
          name,
          size: 0,
          enabled: !name.endsWith(".disabled"),
        }));
    } catch {
      return [];
    }
  }

  // native: host filesystem
  const dir = paksPath(rec, ctx);
  if (!fs.existsSync(dir)) return [];
  const results: PakMod[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".pak") && !entry.name.startsWith("Pal-")) {
      const stat = fs.statSync(path.join(dir, entry.name));
      results.push({
        name: entry.name,
        size: stat.size,
        enabled: !entry.name.endsWith(".disabled"),
      });
    }
    // LogicMods subdirectory
    if (entry.isDirectory() && entry.name === "LogicMods") {
      const logicDir = path.join(dir, entry.name);
      for (const sub of fs.readdirSync(logicDir, { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith(".pak")) {
          const stat = fs.statSync(path.join(logicDir, sub.name));
          results.push({
            name: `LogicMods/${sub.name}`,
            size: stat.size,
            enabled: !sub.name.endsWith(".disabled"),
          });
        }
      }
    }
  }
  return results;
}

/** Toggle a pak mod on/off by renaming .pak ↔ .pak.disabled. */
export async function setPakModEnabled(
  rec: InstanceRecord,
  ctx: DriverContext,
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!/^[\w./-]+$/.test(name)) throw Object.assign(new Error("pak 檔名不合法"), { statusCode: 400 });

  const baseName = name.replace(/\.disabled$/, "");
  const fromName = enabled ? `${baseName}.disabled` : baseName;
  const toName = enabled ? baseName : `${baseName}.disabled`;

  // k8s + docker: exec mv
  if (rec.backend === "k8s") {
    await execInPod(rec, ["mv", `${PAKS_REL}/${fromName}`, `${PAKS_REL}/${toName}`]);
    return;
  }
  if (rec.backend === "docker") {
    await execInContainer(rec, ["mv", `${PAKS_CONTAINER}/${fromName}`, `${PAKS_CONTAINER}/${toName}`]);
    return;
  }

  // native: host FS rename
  const dir = paksPath(rec, ctx);
  const from = path.join(dir, fromName);
  const to = path.join(dir, toName);
  if (!fs.existsSync(from) && !fs.existsSync(to)) {
    throw Object.assign(new Error(`找不到 pak mod: ${name}`), { statusCode: 404 });
  }
  if (fs.existsSync(from)) fs.renameSync(from, to);
}

/** Remove a pak mod. */
export async function removePakMod(
  rec: InstanceRecord,
  ctx: DriverContext,
  name: string,
): Promise<void> {
  if (!/^[\w./-]+$/.test(name)) throw Object.assign(new Error("pak 檔名不合法"), { statusCode: 400 });
  const baseName = name.replace(/\.disabled$/, "");

  // k8s + docker: exec rm
  if (rec.backend === "k8s") {
    await execInPod(rec, ["rm", "-f", `${PAKS_REL}/${baseName}`, `${PAKS_REL}/${baseName}.disabled`]);
    return;
  }
  if (rec.backend === "docker") {
    await execInContainer(rec, ["rm", "-f", `${PAKS_CONTAINER}/${baseName}`, `${PAKS_CONTAINER}/${baseName}.disabled`]);
    return;
  }

  // native: host FS
  const dir = paksPath(rec, ctx);
  for (const candidate of [baseName, `${baseName}.disabled`]) {
    const target = path.join(dir, candidate);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}
