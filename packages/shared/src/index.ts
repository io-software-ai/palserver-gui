import { z } from "zod";
import { WORLD_OPTIONS, type OptionMeta } from "./options.js";

export * from "./options.js";

/** Value type an option can hold at runtime. */
export type WorldOptionValue = string | number | boolean;
export type WorldSettings = Record<keyof typeof WORLD_OPTIONS, WorldOptionValue>;

function zodFor(meta: OptionMeta): z.ZodTypeAny {
  switch (meta.type) {
    case "float":
      return z.number().min(meta.min).max(meta.max).default(meta.default);
    case "int":
      return z.number().int().min(meta.min).max(meta.max).default(meta.default);
    case "bool":
      return z.boolean().default(meta.default);
    case "enum":
      return z.enum(meta.choices as [string, ...string[]]).default(meta.default);
    case "string":
      return z.string().max(meta.maxLength).default(meta.default);
  }
}

const shape = Object.fromEntries(
  Object.entries(WORLD_OPTIONS).map(([key, meta]) => [key, zodFor(meta)]),
);

/** Full settings object; missing keys are filled with defaults on parse. */
export const WorldSettingsSchema = z.object(shape) as unknown as z.ZodType<WorldSettings>;

/** Partial patch used by PUT /instances/:id/settings. */
export const UpdateSettingsSchema = z
  .object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])))
  .strict() as unknown as z.ZodType<Partial<WorldSettings>>;

export const InstanceStatusSchema = z.enum([
  "created", // no container yet (never started, or removed) — start materializes it
  "running",
  "restarting",
  "exited",
  "missing",
]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

/** How the agent runs the server: native = spawn PalServer directly on the
 * host (default, no Docker needed); docker = run it in a container. */
export const BackendSchema = z.enum(["native", "docker"]);
export type Backend = z.infer<typeof BackendSchema>;

export const CreateInstanceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  backend: BackendSchema.default("native"),
  flavor: z.enum(["vanilla", "modded"]).default("vanilla"),
  /** UDP port the server listens on (host port for docker). */
  gamePort: z.number().int().min(1024).max(65535).default(8211),
  /** native only: adopt an existing dedicated-server install instead of
   * letting the agent download one (e.g. C:\steamcmd\steamapps\common\PalServer). */
  serverDir: z.string().max(500).optional(),
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;

export interface InstanceSummary {
  id: string;
  name: string;
  backend: Backend;
  flavor: "vanilla" | "modded";
  gamePort: number;
  status: InstanceStatus;
  createdAt: string;
}

export interface InstanceDetail extends InstanceSummary {
  settings: WorldSettings;
  /** docker: container id · native: process id (null when not running). */
  runtimeId: string | null;
  serverDir: string | null;
}

export interface InstanceStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
}

export interface AgentInfo {
  name: string;
  version: string;
  dockerVersion: string;
  instanceCount: number;
}

export interface ApiError {
  error: string;
}
