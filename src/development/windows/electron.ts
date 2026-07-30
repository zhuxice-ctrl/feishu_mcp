/**
 * Electron dependency, script, test, and package action planning.
 *
 * Uses the locked manifest inspection to derive the package manager and
 * available scripts. Frozen-install commands are built from the trusted
 * toolchain. Script execution accepts only names that exist in the current
 * manifest, re-reads the manifest+lock digest immediately before queueing,
 * and invokes `["run", scriptName]` with no `--` suffix or extra switches.
 * Package artifacts are collected from configured output directories.
 */

import path from "node:path";
import type { WindowsToolchain } from "./toolchain.js";
import { buildElectronCommand } from "./commands.js";
import {
  inspectElectronManifest,
  currentManifestLockDigest,
  type ElectronManifestInspection,
} from "./electronManifest.js";
import { collectWindowsArtifacts } from "./windowsArtifacts.js";
import type { DevelopmentArtifact } from "../tasks/types.js";

export interface ElectronActionPlan {
  executable: string;
  args: string[];
  cwd: string;
  scriptDigest: string;
  artifactRoots: string[];
  timeoutMs: number;
  successExitCodes: number[];
  /** Package manager resolved from the lockfile. */
  packageManager: "npm" | "pnpm" | "yarn";
  /** Manifest+lock digest bound to this approval. */
  manifestLockDigest: string;
  /** Lifecycle scripts that will execute during install (for approval). */
  lifecycleScripts: { phase: string; sha256: string }[];
  /** Artifacts collected after a successful action. */
  artifacts?: DevelopmentArtifact[];
}

export interface ElectronActionRequest {
  root: string;
  action: "install" | "run_script" | "test" | "package";
  scriptName?: string;
  timeoutMs: number;
}

/**
 * Plan an Electron action. The manifest is inspected on every call to ensure
 * the current state matches what was approved. For `run_script`/`test`/`package`
 * the script name must exist in the current manifest.
 */
export function planElectronAction(
  toolchain: WindowsToolchain,
  request: ElectronActionRequest,
): ElectronActionPlan {
  const manifest = inspectElectronManifest(request.root);
  const digest = currentManifestLockDigest(request.root);

  // For script-based actions, the script name must exist in the manifest.
  if (request.action !== "install") {
    if (!request.scriptName) {
      throw new Error(`scriptName is required for action: ${request.action}`);
    }
    const found = manifest.scripts.find((s) => s.name === request.scriptName);
    if (!found) {
      throw new Error(`script not found in manifest: ${request.scriptName}`);
    }
  }

  const input: Record<string, unknown> = {
    action: request.action,
    projectDir: request.root,
    packageManager: manifest.packageManager,
  };
  if (request.action !== "install") {
    input.scriptName = request.scriptName;
  }

  const built = buildElectronCommand(toolchain, input);

  // Collect artifacts for package action.
  let artifacts: DevelopmentArtifact[] | undefined;
  if (request.action === "package") {
    artifacts = collectWindowsArtifacts(request.root, "package.json", "package", "Release");
  }

  return {
    executable: built.executable,
    args: built.args,
    cwd: request.root,
    scriptDigest: digest,
    artifactRoots: request.action === "package" ? ["dist", "release"] : [],
    timeoutMs: request.timeoutMs,
    successExitCodes: [0],
    packageManager: manifest.packageManager,
    manifestLockDigest: digest,
    lifecycleScripts: manifest.lifecycleScripts.map((l) => ({
      phase: l.phase,
      sha256: l.sha256,
    })),
    artifacts,
  };
}

/**
 * Check if the manifest+lock digest has changed since an approval was issued.
 * Returns true if the digest is stale (changed), false if it matches.
 */
export function isManifestDigestStale(
  root: string,
  approvedDigest: string,
): boolean {
  return currentManifestLockDigest(root) !== approvedDigest;
}

export type { ElectronManifestInspection };
