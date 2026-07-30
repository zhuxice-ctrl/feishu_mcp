/**
 * MSBuild action planning.
 *
 * Maps a strict MSBuild action to a fixed argument array using the selected
 * trusted `MSBuild.exe`. Only fixed targets `Restore`, `Build`, `Rebuild`,
 * `Clean`, `Test`, and catalog-approved MSIX packaging targets are allowed.
 * Adapter-generated configuration/platform/output properties are the only
 * `/p:` values; a caller cannot supply MSBuild properties or switches.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WindowsToolchain } from "./toolchain.js";
import { buildMsbuildCommand } from "./commands.js";
import type { MsbuildCommand } from "./types.js";

const MSIX_TARGETS = new Set(["Build", "Rebuild", "Clean"]);

export interface MsbuildActionPlan {
  executable: string;
  args: string[];
  cwd: string;
  scriptDigest: string;
  artifactRoots: string[];
  timeoutMs: number;
  successExitCodes: number[];
}

export interface MsbuildActionRequest {
  root: string;
  solutionOrProject: string;
  target: "Restore" | "Build" | "Rebuild" | "Clean" | "Test";
  configuration: string;
  platform: string;
  timeoutMs: number;
}

function readFileText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Digest the solution/project + directory build files (redacted). */
export function digestMsbuildProject(root: string, solutionOrProject: string): string {
  const entries: Record<string, string | undefined> = {
    solutionOrProject,
    file: readFileText(path.join(root, solutionOrProject)),
    directoryBuildProps: readFileText(path.join(root, "Directory.Build.props")),
    directoryBuildTargets: readFileText(path.join(root, "Directory.Build.targets")),
  };
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

function artifactRootsFor(
  root: string,
  solutionOrProject: string,
  target: MsbuildActionRequest["target"],
  configuration: string,
): string[] {
  const base = path.dirname(path.join(root, solutionOrProject));
  switch (target) {
    case "Build":
    case "Rebuild":
      return [
        path.join(base, "bin"),
        path.join(base, "obj"),
        path.join(base, "AppPackages"),
      ];
    case "Test":
      return [path.join(base, "TestResults")];
    case "Restore":
    case "Clean":
      return [];
  }
}

export function planMsbuildAction(
  toolchain: WindowsToolchain,
  request: MsbuildActionRequest,
): MsbuildActionPlan {
  const built = buildMsbuildCommand(toolchain, {
    action: request.target.toLowerCase() as "restore" | "build" | "rebuild" | "clean" | "test",
    solutionOrProject: request.solutionOrProject,
    target: request.target,
    configuration: request.configuration,
    platform: request.platform,
    maxCpuCount: 4,
  } satisfies MsbuildCommand);
  const scriptDigest = digestMsbuildProject(request.root, request.solutionOrProject);
  return {
    executable: built.executable,
    args: built.args,
    cwd: request.root,
    scriptDigest,
    artifactRoots: artifactRootsFor(request.root, request.solutionOrProject, request.target, request.configuration),
    timeoutMs: request.timeoutMs,
    successExitCodes: [0],
  };
}

/** Whether a target is one of the fixed MSBuild targets. */
export function isFixedMsbuildTarget(target: string): boolean {
  return MSIX_TARGETS.has(target) || target === "Restore" || target === "Test";
}
