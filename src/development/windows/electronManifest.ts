/**
 * Strict Electron package-manifest inspection.
 *
 * Parses `package.json` without prototype pollution, requires exactly one
 * recognized lockfile, maps it to exactly one package manager, and returns
 * each script name plus a SHA-256 of its exact script text. Lifecycle scripts
 * that dependency installation may execute are summarized — never executed.
 * Registry credentials are never returned.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SCRIPT_NAME_REGEX } from "./types.js";

export interface ElectronManifestScript {
  name: string;
  sha256: string;
}

export interface ElectronLifecycleScript {
  phase: "preinstall" | "install" | "postinstall" | "prepare" | "prepublish";
  sha256: string;
}

export interface ElectronManifestInspection {
  name: string | null;
  packageManager: "npm" | "pnpm" | "yarn";
  lockfile: string;
  scripts: ElectronManifestScript[];
  lifecycleScripts: ElectronLifecycleScript[];
  /** SHA-256 of manifest+lockfile content; changes invalidate approvals. */
  manifestLockDigest: string;
}

const LOCKFILE_MAP: ReadonlyArray<[string, "npm" | "pnpm" | "yarn"]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

const LIFECYCLE_PHASES = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse JSON without prototype pollution. Rejects `__proto__` keys and
 * constructor-polluting payloads.
 */
export function safeParseJson(raw: string): unknown {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not a JSON object");
  }
  return parsed;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Inspect an Electron project root. Requires exactly one recognized lockfile;
 * throws if zero or multiple lockfiles are present. Script names are validated
 * against a conservative charset — names containing whitespace, shell
 * suffixes, prefixes, or missing manifest entries are rejected.
 */
export function inspectElectronManifest(root: string): ElectronManifestInspection {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error("package.json not found");
  }
  const raw = fs.readFileSync(pkgPath, "utf8");
  const parsed = safeParseJson(raw) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
    throw new Error("package.json contains __proto__ key");
  }

  // Require exactly one recognized lockfile.
  const present = LOCKFILE_MAP.filter(([name]) =>
    fs.existsSync(path.join(root, name)),
  );
  if (present.length === 0) {
    throw new Error("no recognized lockfile found");
  }
  if (present.length > 1) {
    throw new Error(`multiple lockfiles found: ${present.map((p) => p[0]).join(", ")}`);
  }
  const [lockfile, manager] = present[0];
  const lockRaw = fs.readFileSync(path.join(root, lockfile), "utf8");

  const scripts = asStringRecord(parsed.scripts);
  const scriptEntries: ElectronManifestScript[] = [];
  for (const [name, text] of Object.entries(scripts)) {
    if (!SCRIPT_NAME_REGEX.test(name)) {
      throw new Error(`invalid script name: ${name}`);
    }
    scriptEntries.push({ name, sha256: sha256(text) });
  }

  const lifecycleScripts: ElectronLifecycleScript[] = [];
  for (const phase of LIFECYCLE_PHASES) {
    const text = scripts[phase];
    if (typeof text === "string") {
      lifecycleScripts.push({ phase, sha256: sha256(text) });
    }
  }

  const manifestLockDigest = sha256(raw + "\n" + lockRaw);

  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    packageManager: manager,
    lockfile,
    scripts: scriptEntries,
    lifecycleScripts,
    manifestLockDigest,
  };
}

/**
 * Re-read and digest a manifest+lockfile immediately before queueing a script
 * run. A changed digest invalidates a prior approval.
 */
export function currentManifestLockDigest(root: string): string {
  const pkgRaw = fs.readFileSync(path.join(root, "package.json"), "utf8");
  for (const [lockfile] of LOCKFILE_MAP) {
    const lockPath = path.join(root, lockfile);
    if (fs.existsSync(lockPath)) {
      return sha256(pkgRaw + "\n" + fs.readFileSync(lockPath, "utf8"));
    }
  }
  throw new Error("no recognized lockfile found");
}
