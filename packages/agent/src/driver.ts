import type { InstanceStats, InstanceStatus, LogSource, LogSourceId } from "@palserver/shared";
import type { InstanceRecord } from "./store.js";

/** Per-instance paths the agent owns on disk. */
export interface DriverContext {
  /** <data-dir>/instances/<id> — config renders, logs, pid files, auto-installs. */
  instanceDir: string;
}

/**
 * A backend that knows how to run a PalServer for an instance.
 * Implementations: native (spawn the server binary on the host — default)
 * and docker (run it in a container).
 */
export interface ServerDriver {
  status(rec: InstanceRecord, ctx: DriverContext): Promise<{ status: InstanceStatus; runtimeId: string | null }>;
  /** Prepare (install if needed), apply settings, and start the server. */
  start(rec: InstanceRecord, ctx: DriverContext): Promise<void>;
  stop(rec: InstanceRecord, ctx: DriverContext): Promise<void>;
  /** Tear down runtime state (container / process). Never deletes saves. */
  remove(rec: InstanceRecord, ctx: DriverContext): Promise<void>;
  stats(rec: InstanceRecord, ctx: DriverContext): Promise<InstanceStats | null>;
  /** Follow logs line by line; resolves to a cleanup fn. */
  streamLogs(
    rec: InstanceRecord,
    ctx: DriverContext,
    onLine: (line: string) => void,
    onEnd: () => void,
    source?: LogSourceId,
  ): Promise<() => void>;

  /** Which log streams this instance can serve. */
  logSources(rec: InstanceRecord, ctx: DriverContext): LogSource[];
}
