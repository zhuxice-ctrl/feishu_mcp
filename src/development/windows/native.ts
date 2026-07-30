/**
 * Native (CMake/Ninja/CTest) action planning.
 *
 * Maps a strict native action to a fixed CMake/Ninja/CTest argument array
 * using the trusted toolchain. Preferred project presets are limited to the
 * catalog allowlist (`msvc-debug`, `msvc-release`, `ninja-debug`,
 * `ninja-release`). Build targets must come from CMake File API replies, not
 * caller strings. Install destinations require directory authorization and
 * use `cmake --install`; package uses `cpack --config` in the verified build
 * root. Malicious cache variables or target inputs are rejected at the schema
 * layer.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WindowsToolchain } from "./toolchain.js";
import { buildNativeCommand } from "./commands.js";
import { CMAKE_PRESET_REGEX, CMAKE_CONFIG_REGEX } from "./types.js";

export interface NativeActionPlan {
  executable: string;
  args: string[];
  cwd: string;
  scriptDigest: string;
  artifactRoots: string[];
  timeoutMs: number;
  successExitCodes: number[];
}

export interface NativeActionRequest {
  root: string;
  sourceDir: string;
  buildDir: string;
  action: "configure" | "build" | "test" | "install" | "package";
  preset?: string;
  configuration: string;
  target?: string;
  prefix?: string;
  timeoutMs: number;
  /** Parallelism cap for build/test. */
  parallelism?: number;
}

function readFileText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Digest the CMake project scripts (CMakeLists + presets). */
export function digestNativeProject(root: string, sourceDir: string): string {
  const entries: Record<string, string | undefined> = {
    sourceDir,
    cmakeLists: readFileText(path.join(sourceDir, "CMakeLists.txt")),
    cmakePresets: readFileText(path.join(sourceDir, "CMakePresets.json")),
    cache: readFileText(path.join(sourceDir, "CMakeCache.txt")),
  };
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

const MAX_PARALLELISM = 64;

function artifactRootsFor(
  buildDir: string,
  action: NativeActionRequest["action"],
): string[] {
  switch (action) {
    case "build":
      return [buildDir];
    case "package":
      return [buildDir];
    case "configure":
    case "test":
    case "install":
      return [];
  }
}

/**
 * Validate that `buildDir` is confined within `root` (no escape via `..` or
 * absolute paths outside the project).
 */
export function isBuildDirConfined(root: string, buildDir: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(buildDir));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function planNativeAction(
  toolchain: WindowsToolchain,
  request: NativeActionRequest,
): NativeActionPlan {
  if (request.preset && !CMAKE_PRESET_REGEX.test(request.preset)) {
    throw new Error(`unapproved cmake preset: ${request.preset}`);
  }
  if (!CMAKE_CONFIG_REGEX.test(request.configuration)) {
    throw new Error(`invalid cmake configuration: ${request.configuration}`);
  }
  if (!isBuildDirConfined(request.root, request.buildDir)) {
    throw new Error(`build directory escapes project root: ${request.buildDir}`);
  }
  if (request.parallelism !== undefined) {
    if (!Number.isInteger(request.parallelism) || request.parallelism < 1 || request.parallelism > MAX_PARALLELISM) {
      throw new Error(`invalid parallelism: ${request.parallelism}`);
    }
  }

  const input: Record<string, unknown> = {
    action: request.action,
    configuration: request.configuration,
  };
  if (request.action === "configure") {
    input.sourceDir = request.sourceDir;
    input.buildDir = request.buildDir;
    if (request.preset) input.preset = request.preset;
  } else {
    input.buildDir = request.buildDir;
  }
  if (request.action === "build" && request.target) input.target = request.target;
  if (request.action === "install" && request.prefix) input.prefix = request.prefix;

  const built = buildNativeCommand(toolchain, input);
  const scriptDigest = digestNativeProject(request.root, request.sourceDir);
  return {
    executable: built.executable,
    args: built.args,
    cwd: request.root,
    scriptDigest,
    artifactRoots: artifactRootsFor(request.buildDir, request.action),
    timeoutMs: request.timeoutMs,
    successExitCodes: [0],
  };
}

/** Read build targets from CMake File API replies (mocked in tests). */
export function discoverCmakeTargets(buildDir: string): string[] {
  const replyDir = path.join(buildDir, ".cmake", "api", "v1", "reply");
  if (!fs.existsSync(replyDir)) return [];
  const targets: string[] = [];
  for (const name of fs.readdirSync(replyDir)) {
    if (!name.includes("target")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(replyDir, name), "utf8"));
      if (Array.isArray(data?.targets)) {
        for (const t of data.targets) {
          if (typeof t?.name === "string") targets.push(t.name);
        }
      }
    } catch {
      // ignore malformed reply files
    }
  }
  return targets;
}
