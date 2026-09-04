/**
 * Versioned contracts for catalog-declared local development servers.
 *
 * A declaration is data owned by the local operator.  It deliberately has no
 * executable, command line, caller supplied environment, or arbitrary URL.
 * Runtime adapters translate the closed template IDs below into those details.
 */

import path from "node:path";
import { z } from "zod";

export const DEV_SERVER_RUNTIMES = ["node", "python", "android", "generic"] as const;
export const DEV_SERVER_SCOPES = ["local", "lan"] as const;
export const DEV_SERVER_STATES = [
  "starting", "running", "stopping", "stopped", "failed", "expired",
] as const;

export type DevServerRuntime = (typeof DEV_SERVER_RUNTIMES)[number];
export type DevServerScope = (typeof DEV_SERVER_SCOPES)[number];
export type DevServerState = (typeof DEV_SERVER_STATES)[number];

const id = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const label = z.string().min(1).max(128);

/** A catalog file may name files below its workspace, never paths outside it. */
export const relativeServerPath = z.string().min(1).max(512).refine(
  (value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !/[\0\r\n]/.test(value),
  "server path must be a safe relative path",
);

const healthPath = z.string().min(1).max(256).refine(
  (value) => value.startsWith("/") && !value.includes("://") &&
    !/[?#\0\r\n]/.test(value),
  "healthPath must be a local absolute path without query or fragment",
);

const portRange = z.strictObject({
  min: z.number().int().min(1024).max(65_535),
  max: z.number().int().min(1024).max(65_535),
}).refine((value) => value.min <= value.max, "port range min must not exceed max");

const scopes = z.array(z.enum(DEV_SERVER_SCOPES)).min(1).max(2).refine(
  (value) => new Set(value).size === value.length,
  "server scopes must be unique",
);

const nodeService = z.strictObject({
  id, label,
  runtime: z.literal("node"),
  template: z.enum(["pnpm_dev", "npm_dev", "yarn_dev"]),
  script: id,
  workingDirectory: relativeServerPath.default("."),
  scopes,
  portRange,
  healthPath: healthPath.optional(),
});

const pythonService = z.strictObject({
  id, label,
  runtime: z.literal("python"),
  template: z.enum(["flask", "django", "uvicorn"]),
  app: z.string().regex(/^[A-Za-z0-9_.:-]{1,192}$/),
  workingDirectory: relativeServerPath.default("."),
  scopes,
  portRange,
  healthPath: healthPath.optional(),
});

const androidService = z.strictObject({
  id, label,
  runtime: z.literal("android"),
  template: z.enum(["gradle_install", "adb_reverse"]),
  target: z.string().regex(/^[A-Za-z0-9_.:-]{1,192}$/),
  workingDirectory: relativeServerPath.default("."),
  scopes,
  portRange,
  healthPath: healthPath.optional(),
});

const genericService = z.strictObject({
  id, label,
  runtime: z.literal("generic"),
  template: z.enum(["static_node"]),
  directory: relativeServerPath,
  workingDirectory: relativeServerPath.default("."),
  scopes,
  portRange,
  healthPath: healthPath.optional(),
});

/** Strict union of all catalog service declarations. */
export const devServerSchema = z.discriminatedUnion("runtime", [
  nodeService, pythonService, androidService, genericService,
]);

export type DevServer = z.infer<typeof devServerSchema>;
export type CanonicalDevServer = DevServer & { workingDirectory: string };

/** Root-free view suitable for MCP output. */
export interface PublicDevServer {
  id: string;
  label: string;
  runtime: DevServerRuntime;
  scopes: DevServerScope[];
  portRange: { min: number; max: number };
  healthPath?: string;
}

export function publicDevServer(service: DevServer): PublicDevServer {
  return {
    id: service.id,
    label: service.label,
    runtime: service.runtime,
    scopes: [...service.scopes],
    portRange: { ...service.portRange },
    ...(service.healthPath === undefined ? {} : { healthPath: service.healthPath }),
  };
}
