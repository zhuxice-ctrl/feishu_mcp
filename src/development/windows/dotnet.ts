/**
 * Pure .NET command builders and action planning.
 *
 * Each builder takes a resolved {@link WindowsToolchain} and a validated
 * action, and returns a fixed `{ executable, args, stdin? }` triple. Builders
 * are pure: they never read `process.env`, never touch the filesystem, and
 * never concatenate a shell string. Every eventual execution path uses
 * `shell: false`.
 *
 * Lock policy: when `packages.lock.json` exists, `restore` maps to
 * `restore --locked-mode`. When it is absent, a separate
 * `generate_dependency_lock` action (exact approval) invokes
 * `restore --use-lock-file`; ordinary restore never silently creates or
 * changes a lock. The remaining actions map to fixed `--no-restore` /
 * `--no-build` forms. Configuration, framework, runtime, and output are
 * separately validated fields — a caller cannot supply MSBuild properties or
 * switches.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WindowsToolchain } from "./toolchain.js";
import { buildDotnetCommand } from "./commands.js";

const SENSITIVE_PROP_RE = /(password|secret|key|token|credential|nuget)/i;

export interface DotnetActionPlan {
  executable: string;
  args: string[];
  cwd: string;
  scriptDigest: string;
  artifactRoots: string[];
  timeoutMs: number;
  successExitCodes: number[];
}

export interface DotnetActionRequest {
  root: string;
  projectOrSolution: string;
  action: "restore" | "build" | "test" | "publish" | "pack" | "generate_dependency_lock";
  configuration?: string;
  framework?: string;
  runtime?: string;
  timeoutMs: number;
}

function readFileText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function redactSensitive(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) return line;
      const key = m[1].trim();
      if (SENSITIVE_PROP_RE.test(key)) return `${key}=<redacted>`;
      return line;
    })
    .join("\n");
}

/** Digest the executable project scripts (with sensitive entries redacted). */
export function digestDotnetProject(root: string, projectOrSolution: string): string {
  const entries: Record<string, string | undefined> = {
    projectOrSolution,
    projectFile: readFileText(path.join(root, projectOrSolution)),
    directoryBuildProps: redactSensitive(
      readFileText(path.join(root, "Directory.Build.props")),
    ),
    directoryPackagesProps: redactSensitive(
      readFileText(path.join(root, "Directory.Packages.props")),
    ),
    nugetConfig: redactSensitive(readFileText(path.join(root, "nuget.config"))),
    packagesLock: readFileText(path.join(root, "packages.lock.json")),
    globalJson: readFileText(path.join(root, "global.json")),
  };
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

/** Whether a `packages.lock.json` exists at the project root. */
export function hasDependencyLock(root: string): boolean {
  return fs.existsSync(path.join(root, "packages.lock.json"));
}

function artifactRootsFor(
  root: string,
  projectOrSolution: string,
  action: DotnetActionRequest["action"],
  configuration: string,
): string[] {
  const base = path.dirname(path.join(root, projectOrSolution));
  switch (action) {
    case "build":
      return [path.join(base, "bin"), path.join(base, "obj")];
    case "publish":
      return [path.join(base, "bin", configuration, "publish")];
    case "pack":
      return [path.join(base, "bin", configuration)];
    case "test":
      return [path.join(base, "TestResults")];
    case "restore":
    case "generate_dependency_lock":
      return [];
  }
}

export function planDotnetAction(
  toolchain: WindowsToolchain,
  request: DotnetActionRequest,
): DotnetActionPlan {
  const input: Record<string, unknown> = {
    action: request.action,
    projectOrSolution: request.projectOrSolution,
  };
  if (request.action === "restore") {
    input.lockedMode = hasDependencyLock(request.root);
  }
  if (request.configuration) input.configuration = request.configuration;
  if (request.framework) input.framework = request.framework;
  if (request.action === "publish" && request.runtime) input.runtime = request.runtime;
  const built = buildDotnetCommand(toolchain, input);
  const scriptDigest = digestDotnetProject(request.root, request.projectOrSolution);
  const configuration = request.configuration ?? "Debug";
  return {
    executable: built.executable,
    args: built.args,
    cwd: request.root,
    scriptDigest,
    artifactRoots: artifactRootsFor(request.root, request.projectOrSolution, request.action, configuration),
    timeoutMs: request.timeoutMs,
    successExitCodes: [0],
  };
}
