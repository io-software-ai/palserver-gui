import type { InstanceRecord } from "./store.js";

/**
 * Platform detection that distinguishes the *agent's* OS from the *game
 * server's* OS. The server may run a Windows binary under Wine even when
 * the agent is on Linux — this abstraction lets every path/gate branch on
 * the server binary's target platform rather than the agent's OS.
 *
 * native backend 反映真實 host OS:Windows host 跑 Windows binary、Linux host
 * 跑 Linux binary。「Linux 不再新建 native」的 gate 在 routes.ts create instance
 * (backend-availability NativeDetector),不在此處。既有 Linux native 實例仍正確
 * 走 Linux 路徑。
 */

/** The OS the game server process runs on, not the agent's OS. */
export function serverPlatform(rec: InstanceRecord): "windows" | "linux" {
  if (rec.backend === "native") {
    return process.platform === "win32" ? "windows" : "linux";
  }
  // docker/k8s: runtime="wine" runs a Windows binary under Wine.
  return rec.runtime === "wine" ? "windows" : "linux";
}

/** The Unreal config sub-directory the server binary reads: "WindowsServer"
 * for a Windows binary (native Windows or Wine), "LinuxServer" otherwise. */
export function configPlatformDir(rec: InstanceRecord): string {
  return serverPlatform(rec) === "windows" ? "WindowsServer" : "LinuxServer";
}
