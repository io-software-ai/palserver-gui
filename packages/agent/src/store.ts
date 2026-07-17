import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WorldSettingsSchema, type WorldSettings, type EngineSettings, type LaunchOptions } from "@palserver/shared";
import { DATA_DIR } from "./env.js";

export interface InstanceRecord {
  id: string;
  name: string;
  backend: "native" | "docker" | "k8s";
  flavor: "vanilla" | "modded";
  gamePort: number;
  /** Steam 查詢埠(UDP)。Palworld 每台預設都用 27015、且不在 PalWorldSettings.ini
   * 裡,所以同一台開第二台一定撞(第二台綁不到就死在開機)。每台自動分配唯一值,
   * 啟動時以 -queryport + Engine.ini GameServerQueryPort 兩管道套用。 */
  queryPort?: number;
  /** docker only: 自訂容器鏡像;undefined = 用內建 IMAGES[flavor]。 */
  dockerImage?: string;
  /** docker/k8s: 執行環境。"wine" = 跑 Windows binary via Wine; undefined = 原生。 */
  runtime?: "native" | "wine";
  /** native only: custom server root; undefined = agent-managed install
   * under instanceDir/server. */
  serverDir?: string;
  /** true = the agent installed (and may re-download) the server at
   * serverDir; false/undefined = adopted pre-existing install, never
   * auto-installed into. */
  serverDirManaged?: boolean;
  settings: WorldSettings;
  /** 受管理的 Engine.ini 微調(效能/網路)。store 是這些值的權威來源:伺服器關機時
   * 會把 Engine.ini 重寫回預設,所以不能只靠檔案。每次啟動前會把這裡的值合併回
   * Engine.ini(見 native.ts writeIni),GUI 顯示也讀這裡而非讀檔。 */
  engineSettings?: EngineSettings;
  /** 命令列啟動參數(launch options);啟動時由 buildLaunchArgs 組成 -flag。 */
  launchOptions?: LaunchOptions;
  /** 玩家連線用的公開位址(playit.gg 隧道等,使用者貼上;含埠)。undefined = 未設定。 */
  externalAddress?: string;
  /** agent 啟動時自動啟動這台伺服器(搭配「開機自動啟動 agent」= 主機開機即開服)。 */
  autoStart?: boolean;
  createdAt: string;
  /** k8s backend: namespace of the game server StatefulSet. */
  k8sNamespace?: string;
  /** k8s backend: name of the game server StatefulSet. */
  k8sStatefulSet?: string;
  /** k8s backend: ClusterIP Service name for REST API access. */
  k8sServiceName?: string;
}

const STORE_FILE = path.join(DATA_DIR, "instances.json");

/** Steam 查詢埠的分配起點(Palworld 預設值);往上遞增找沒被占用的。 */
const QUERY_PORT_BASE = 27015;

/** REST API 埠的分配起點(Palworld 預設值);往上遞增找沒被占用的。 */
const REST_PORT_BASE = 8212;

/** RCON 埠的分配起點(Palworld 預設值);往上遞增找沒被占用的。 */
const RCON_PORT_BASE = 25575;

/**
 * Flat-file store for instance metadata. Container state lives in Docker
 * (labels + inspect); this file is the source of truth for settings only.
 */
export class InstanceStore {
  private instances = new Map<string, InstanceRecord>();

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const raw: InstanceRecord[] = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      for (const rec of raw) {
        // Migrate settings saved by older schema versions: fill new options
        // with defaults, drop keys we no longer know. 用 safeParse 兜底:即使整筆
        // settings 壞掉(null / 非物件),也退回全預設而非讓整個 agent 開機崩潰。
        // (欄位級的超範圍/髒值由 schema 的 .catch 各自退回預設,見 zodFor。)
        const parsed = WorldSettingsSchema.safeParse(rec.settings ?? {});
        rec.settings = parsed.success ? parsed.data : WorldSettingsSchema.parse({});
        // Records created before the native backend existed were docker-based.
        rec.backend ??= "docker";
        this.instances.set(rec.id, rec);
      }
      // 回填既有實例的 Steam 查詢埠:早於這個欄位建立的實例都沒有,補上唯一值,
      // 否則多台一起開仍會全部搶 27015。下次啟動就會用到新分配的埠。
      const used = new Set(
        [...this.instances.values()].map((r) => r.queryPort).filter((p): p is number => !!p),
      );
      let next = QUERY_PORT_BASE;
      for (const rec of this.instances.values()) {
        if (rec.queryPort == null) {
          while (used.has(next)) next++;
          rec.queryPort = next;
          used.add(next);
        }
      }
      this.flush();
    }
  }

  /** 全部實例占用中的 UDP 埠(遊戲埠+查詢埠)。撞埠檢查要跨欄位:兩者同為 UDP,
   *  gamePort 撞到別台的 queryPort 一樣 bind 不起來。 */
  usedUdpPorts(excludeId?: string): Set<number> {
    const used = new Set<number>();
    for (const r of this.list()) {
      if (r.id === excludeId) continue;
      if (r.gamePort) used.add(r.gamePort);
      if (r.queryPort) used.add(r.queryPort);
    }
    return used;
  }

  /** 全部實例占用中的 TCP 埠(REST+RCON,各自啟用時)。同為 TCP 也要交叉檢查。 */
  usedTcpPorts(excludeId?: string): Set<number> {
    const used = new Set<number>();
    for (const r of this.list()) {
      if (r.id === excludeId) continue;
      const rest = r.settings.RESTAPIPort;
      if (r.settings.RESTAPIEnabled && typeof rest === "number") used.add(rest);
      const rcon = r.settings.RCONPort;
      if (r.settings.RCONEnabled && typeof rcon === "number") used.add(rcon);
    }
    return used;
  }

  /** 分配一個沒被任何實例占用(含遊戲埠,同為 UDP)的 Steam 查詢埠(建立實例時用)。
   *  avoid:同批要建立、但還沒進 store 的埠(例:新實例自己的 gamePort)。 */
  nextQueryPort(avoid: Iterable<number> = []): number {
    const used = this.usedUdpPorts();
    for (const p of avoid) used.add(p);
    let port = QUERY_PORT_BASE;
    while (used.has(port)) port++;
    return port;
  }

  /** 分配一個沒被任何實例占用(含 RCON,同為 TCP)的 REST API 埠(建立實例時用)。 */
  nextRestApiPort(): number {
    const used = this.usedTcpPorts();
    let port = REST_PORT_BASE;
    while (used.has(port)) port++;
    return port;
  }

  /** 分配一個沒被任何實例占用(含 REST,同為 TCP)的 RCON 埠(建立實例時用)。
   *  avoid:同批要建立、還沒進 store 的埠(例:剛分配的 REST 埠)。 */
  nextRconPort(avoid: Iterable<number> = []): number {
    const used = this.usedTcpPorts();
    for (const p of avoid) used.add(p);
    let port = RCON_PORT_BASE;
    while (used.has(port)) port++;
    return port;
  }

  list(): InstanceRecord[] {
    return [...this.instances.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(id: string): InstanceRecord | undefined {
    return this.instances.get(id);
  }

  findByName(name: string): InstanceRecord | undefined {
    return this.list().find((r) => r.name === name);
  }

  create(rec: Omit<InstanceRecord, "id" | "createdAt">): InstanceRecord {
    const full: InstanceRecord = {
      ...rec,
      id: crypto.randomBytes(6).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    this.instances.set(full.id, full);
    this.flush();
    return full;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        InstanceRecord,
        // name/gamePort 由世界設定的 ServerName/PublicPort 鏡射(routes mirrorIdentityFromSettings)
        "settings" | "serverDir" | "serverDirManaged" | "engineSettings" | "launchOptions" | "queryPort" | "name" | "gamePort" | "externalAddress" | "autoStart"
      >
    >,
  ): InstanceRecord {
    const rec = this.instances.get(id);
    if (!rec) throw new Error(`instance ${id} not found`);
    const next = { ...rec, ...patch };
    this.instances.set(id, next);
    this.flush();
    return next;
  }

  remove(id: string): void {
    this.instances.delete(id);
    this.flush();
  }

  /** Per-instance directory bind-mounted into the container. */
  instanceDir(id: string): string {
    return path.join(DATA_DIR, "instances", id);
  }

  private flush(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(this.list(), null, 2));
  }
}
