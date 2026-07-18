import type { Backend } from "@palserver/shared";
import { docker } from "./docker.js";
import { loadKubeConfig } from "./k8s-files.js";

/**
 * Backend 可用性偵測(003 連線偵測架構)。
 *
 * 原則(老闆揭示):
 *   - availableBackends 描述「伺服器端能力」,不依賴 agent OS。
 *   - Windows 只提供 native(WSL2 UDP 失效,不支援 docker/k8s)。
 *   - Linux 不再「新建」native 實例(既有 Linux native 保留,driver 仍正確運作)。
 *   - macOS 提供 docker/k8s 但不保證可用。
 *   - k8s 偵測 cheap-only(kubeconfig 存在即可);連通問題留給 driver。
 *
 * 介面刻意單 method `isAvailable()`(反方 003 D2):3 個 backend 中只有 k8s 真的需要
 * 分 cheap/expensive,但對稱的單 method 介面比 cheap/expensive 兩層(其中兩個 backend
 * 是回音)更誠實。需要的 detector 在內部分層。
 */

/** Race 一個 promise 與 timeout,timeout 觸發時 clearTimeout 避免 timer 洩漏。 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BackendDetector {
  /** 此 backend 在這台 agent 上是否可用。可能包含 cheap 本地檢查 + expensive 網路確認。 */
  isAvailable(): Promise<boolean>;
}

/**
 * Native detector:Windows host 才有 Windows binary 能力。
 * platform 透過依賴注入,方便測試(反方 003 D8 — process.platform 在 ESM 載入時機不可靠)。
 */
export class NativeDetector implements BackendDetector {
  constructor(private readonly platform: string = process.platform) {}
  async isAvailable(): Promise<boolean> {
    return this.platform === "win32";
  }
}

/**
 * Docker detector:docker daemon 連得到(任何 OS)。
 * expensive:docker.version() with timeout,因為 dockerode 不吃 AbortSignal。
 * 公開 `detectVersion()` 讑呼叫端(/api/info)可共用單一探測結果,避免重複往返。
 */
export class DockerDetector implements BackendDetector {
  constructor(private readonly dockerInstance: typeof docker = docker) {}
  /** 探測 docker 版本字串(失敗/逾時回 null),供 /api/info 共用。 */
  async detectVersion(): Promise<string | null> {
    try {
      const v = await withTimeout(this.dockerInstance.version(), 3000);
      return (v as { Version?: string } | null)?.Version ?? null;
    } catch {
      return null;
    }
  }
  async isAvailable(): Promise<boolean> {
    return (await this.detectVersion()) !== null;
  }
}

/**
 * K8s detector:kubeconfig 存在即可(cheap-only)。
 *
 * 006 修正:不再做 expensive namespace 連通偵測。實際 namespace 是使用者建立實例時
 * 自填的欄位,偵測時不知道目標 namespace;且 namespace-scoped RBAC 用固定 probe
 * namespace 會誤判(review #4)。連通問題在 driver(k8s.ts)實際建立/啟動實例時浮現。
 *
 * Windows k8s 政策 gate 不在此處理 — 顯式寫在 computeAvailableBackends(反方 003 D3)。
 */
export class K8sDetector implements BackendDetector {
  async isAvailable(): Promise<boolean> {
    // Cheap:kubeconfig 能否載入(讀 ~/.kube/config 或 in-cluster env)。
    try {
      loadKubeConfig();
      return true;
    } catch {
      return false;
    }
  }
}

/** 預設 detector 實例(production 用)。測試可注入偽 detector。 */
export function createDefaultDetectors(): Record<Backend, BackendDetector> {
  return {
    native: new NativeDetector(),
    docker: new DockerDetector(),
    k8s: new K8sDetector(),
  };
}

/**
 * 計算目前「可用」的 backend 清單。Windows k8s 政策 gate 顯式寫在這裡(反方 003 D3) —
 * Windows 一律不提供 k8s(老闆硬性指示),不論 k8s detector 是否連得到。
 *
 * `overrideDetectors` 可傳入「部分」detector 覆寫,缺的用預設(createDefaultDetectors)
 * 中的對應項。/api/info 用此傳入已探測過 docker 的 DockerDetector,避免重複往返。
 */
export async function computeAvailableBackends(
  overrideDetectors?: Partial<Record<Backend, BackendDetector>>,
  opts: { platform?: string } = {},
): Promise<Backend[]> {
  const platform = opts.platform ?? process.platform;
  const defaults = createDefaultDetectors();
  const detectors: Record<Backend, BackendDetector> = {
    native: overrideDetectors?.native ?? defaults.native,
    docker: overrideDetectors?.docker ?? defaults.docker,
    k8s: overrideDetectors?.k8s ?? defaults.k8s,
  };
  const candidates: Backend[] = ["native", "docker", "k8s"];
  // Windows k8s 政策 gate:不論偵測結果,Windows 不提供 k8s。
  const effective = platform === "win32" ? candidates.filter((b) => b !== "k8s") : candidates;
  const results = await Promise.all(
    effective.map(async (b) => ((await detectors[b].isAvailable()) ? b : null)),
  );
  return results.filter((b): b is Backend => b !== null);
}
