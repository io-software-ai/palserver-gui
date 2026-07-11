import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WorldSettingsSchema, type WorldSettings } from "@palserver/shared";
import { DATA_DIR } from "./env.js";

export interface InstanceRecord {
  id: string;
  name: string;
  backend: "native" | "docker" | "k8s";
  flavor: "vanilla" | "modded";
  gamePort: number;
  /** native only: custom server root; undefined = agent-managed install
   * under instanceDir/server. */
  serverDir?: string;
  /** true = the agent installed (and may re-download) the server at
   * serverDir; false/undefined = adopted pre-existing install, never
   * auto-installed into. */
  serverDirManaged?: boolean;
  settings: WorldSettings;
  createdAt: string;
  /** k8s backend: namespace of the game server StatefulSet. */
  k8sNamespace?: string;
  /** k8s backend: name of the game server StatefulSet. */
  k8sStatefulSet?: string;
  /** k8s backend: ClusterIP Service name for REST API access. */
  k8sServiceName?: string;
}

const STORE_FILE = path.join(DATA_DIR, "instances.json");

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
        // with defaults, drop keys we no longer know.
        rec.settings = WorldSettingsSchema.parse(rec.settings);
        // Records created before the native backend existed were docker-based.
        rec.backend ??= "docker";
        this.instances.set(rec.id, rec);
      }
      this.flush();
    }
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
    patch: Partial<Pick<InstanceRecord, "settings" | "serverDir" | "serverDirManaged">>,
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
