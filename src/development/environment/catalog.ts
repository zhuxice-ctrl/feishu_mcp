/**
 * Versioned trusted-component catalog loader.
 *
 * The catalog is a reviewed repository file (`config/development-package-catalog.json`)
 * that enumerates the only toolchain components the broker may discover, plan,
 * and install. It is parsed with a strict Zod schema so any caller-controlled
 * URL, executable, free-form switch, script, or registry write — anything not
 * one of the four reviewed install forms — is rejected at load time. A
 * `verified_archive` URL is accepted only when it is HTTPS on an allowlisted
 * publisher host and is never copied from an MCP argument.
 *
 * The same JSON is embedded into the C# administrator broker at build time;
 * both sides validate against the same schema, so the catalog digest binds the
 * Node plan to the exact broker-embedded component set.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DevelopmentCatalog } from "./types.js";

export const CATALOG_VERSION = 1 as const;

/**
 * Hosts permitted for `verified_archive` sources. A reviewed distribution
 * mirror is added here only after security review; an MCP caller can never
 * supply a host.
 */
export const ALLOWED_ARCHIVE_HOSTS = [
  "services.gradle.org",
  "dl.google.com",
] as const;

const HEX64 = /^[0-9a-f]{64}$/;

const installOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("winget"),
      packageId: z.string().min(1),
      source: z.literal("winget"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vs_workload"),
      workloadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("android_sdk"),
      packageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verified_archive"),
      artifactId: z.string().min(1),
      url: z
        .string()
        .url()
        .refine((value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === "https:";
          } catch {
            return false;
          }
        }, "verified_archive url must be https"),
      sha256: z.string().regex(HEX64, "sha256 must be 64 lowercase hex chars"),
    })
    .strict()
    .refine((value) => {
      try {
        const parsed = new URL(value.url);
        return (ALLOWED_ARCHIVE_HOSTS as readonly string[]).includes(parsed.hostname);
      } catch {
        return false;
      }
    }, "verified_archive url host is not allowlisted"),
]);

const discoverySchema = z
  .object({
    kind: z.enum(["registry", "vswhere", "fixed_candidates", "sdkmanager"]),
    values: z.array(z.string()).max(64),
  })
  .strict();

const componentSchema = z
  .object({
    id: z.string().min(1).max(128),
    target: z.enum(["android", "dotnet", "native", "electron"]),
    displayName: z.string().min(1).max(200),
    versions: z.array(z.string().min(1).max(64)).min(1).max(16),
    discovery: discoverySchema,
    publishers: z.array(z.string().min(1).max(200)).min(1).max(16),
    install: installOperationSchema,
  })
  .strict();

const catalogSchema = z
  .object({
    version: z.literal(CATALOG_VERSION),
    components: z.array(componentSchema).min(1),
  })
  .strict();

/**
 * Default catalog location, relative to the process working directory. In
 * production the server runs from the repository root; tests pass an explicit
 * path. The C# broker embeds the same file at build time.
 */
export const DEFAULT_CATALOG_PATH = path.resolve(
  process.cwd(),
  "config/development-package-catalog.json",
);

export class DevelopmentCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DevelopmentCatalogError";
  }
}

/**
 * Load and strictly validate the catalog from disk. Throws
 * {@link DevelopmentCatalogError} for any malformed or untrusted entry.
 */
export function loadDevelopmentCatalog(catalogPath: string = DEFAULT_CATALOG_PATH): DevelopmentCatalog {
  let raw: string;
  try {
    raw = fs.readFileSync(catalogPath, "utf8");
  } catch (cause) {
    throw new DevelopmentCatalogError(`cannot read catalog at ${catalogPath}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DevelopmentCatalogError(`catalog is not valid JSON: ${catalogPath}`, { cause });
  }
  const result = catalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new DevelopmentCatalogError(
      `invalid development catalog: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const catalog = result.data as DevelopmentCatalog;
  enforceUniqueIds(catalog);
  return catalog;
}

function enforceUniqueIds(catalog: DevelopmentCatalog): void {
  const seen = new Set<string>();
  for (const component of catalog.components) {
    if (seen.has(component.id)) {
      throw new DevelopmentCatalogError(`duplicate component id: ${component.id}`);
    }
    seen.add(component.id);
  }
}

/**
 * Stable digest of the catalog's canonical JSON form. Used to bind an
 * environment plan (and a broker request) to the exact reviewed component set
 * the plan was authored against. The digest is a plain SHA-256 (not HMAC): it
 * is public and only needs to be tamper-evident, not secret.
 */
export function catalogDigest(catalog: DevelopmentCatalog): string {
  const canonical = JSON.stringify({
    version: catalog.version,
    components: catalog.components,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
