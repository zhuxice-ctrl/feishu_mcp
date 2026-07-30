/**
 * Windows project ecosystem detection.
 *
 * Inspects a project root by reading only fixed manifest file names
 * (`.sln`, `.csproj`, `.vcxproj`, `CMakeLists.txt`, `CMakePresets.json`,
 * `package.json`, lockfiles). It never executes MSBuild evaluation, package
 * scripts, or any tool during inspection. Entrypoints are canonicalized to
 * POSIX-style relative paths. A caller must select a single entrypoint when a
 * root contains more than one valid solution/project.
 *
 * Junction escapes are rejected: a manifest that is a reparse point or that
 * resolves outside the inspected root is never reported.
 */

import fs from "node:fs";
import path from "node:path";
import type { DevelopmentEcosystem } from "../projects/types.js";

export type WindowsEcosystem = Extract<DevelopmentEcosystem, "dotnet" | "native" | "electron">;

export interface WindowsProjectEntrypoint {
  kind: "solution" | "project";
  relativePath: string;
  ecosystem: WindowsEcosystem;
}

export interface WindowsPackageManager {
  manager: "npm" | "pnpm" | "yarn";
  lockfile: string;
}

export interface WindowsProjectInspection {
  ecosystems: WindowsEcosystem[];
  entrypoints: WindowsProjectEntrypoint[];
  packageManager: WindowsPackageManager | null;
}

const DOTNET_EXTENSIONS = [".csproj", ".vbproj", ".fsproj"] as const;
const NATIVE_PROJECT_EXTENSIONS = [".vcxproj"] as const;
const LOCKFILE_MAP: ReadonlyArray<[string, "npm" | "pnpm" | "yarn"]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

/**
 * Resolve and canonicalize a manifest path inside `root`, rejecting reparse
 * points (junctions/symlinks) and any real path that escapes the root.
 */
function safeManifestPath(root: string, name: string): string | null {
  const candidate = path.join(root, name);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  // Reject reparse points (junctions/symlinks).
  if (stat.isSymbolicLink()) return null;
  if (!stat.isFile()) return null;
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const rootReal = safeRealpath(root);
  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return candidate;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function relPosix(root: string, full: string): string {
  return toPosix(path.relative(root, full));
}

/**
 * Detect the development ecosystem(s) present in `root` by reading only fixed
 * manifest names. Returns deterministic, sorted results. A root may report
 * multiple ecosystems (mixed-project reporting) — e.g. a native project with a
 * Node-based Electron shell.
 */
export async function detectWindowsProject(root: string): Promise<WindowsProjectInspection> {
  const rootReal = safeRealpath(root);
  const ecosystems = new Set<WindowsEcosystem>();
  const entrypoints: WindowsProjectEntrypoint[] = [];

  // .NET: solutions then projects.
  const sln = safeManifestPath(root, /* detect any .sln */ "") ?? detectByGlob(root, ".sln");
  void sln;
  for (const name of listDir(root)) {
    if (name.toLowerCase().endsWith(".sln")) {
      const full = safeManifestPath(root, name);
      if (full) {
        ecosystems.add("dotnet");
        entrypoints.push({
          kind: "solution",
          relativePath: relPosix(rootReal, full),
          ecosystem: "dotnet",
        });
      }
    } else if (DOTNET_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
      const full = safeManifestPath(root, name);
      if (full) {
        ecosystems.add("dotnet");
        entrypoints.push({
          kind: "project",
          relativePath: relPosix(rootReal, full),
          ecosystem: "dotnet",
        });
      }
    } else if (NATIVE_PROJECT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
      const full = safeManifestPath(root, name);
      if (full) {
        ecosystems.add("native");
        entrypoints.push({
          kind: "project",
          relativePath: relPosix(rootReal, full),
          ecosystem: "native",
        });
      }
    }
  }

  // Native: CMakeLists.txt + optional CMakePresets.json.
  const cmakeLists = safeManifestPath(root, "CMakeLists.txt");
  if (cmakeLists) {
    ecosystems.add("native");
    entrypoints.push({
      kind: "project",
      relativePath: relPosix(rootReal, cmakeLists),
      ecosystem: "native",
    });
  }
  const cmakePresets = safeManifestPath(root, "CMakePresets.json");
  if (cmakePresets && !ecosystems.has("native")) {
    // Presets alone do not constitute a native project; require CMakeLists.
  }

  // Electron: package.json + recognized lockfile.
  const pkgJson = safeManifestPath(root, "package.json");
  let packageManager: WindowsPackageManager | null = null;
  if (pkgJson) {
    for (const [lockfile, manager] of LOCKFILE_MAP) {
      if (safeManifestPath(root, lockfile)) {
        packageManager = { manager, lockfile };
        break;
      }
    }
    // package.json with an Electron dependency signals the electron ecosystem.
    if (hasElectronDependency(pkgJson)) {
      ecosystems.add("electron");
      entrypoints.push({
        kind: "project",
        relativePath: relPosix(rootReal, pkgJson),
        ecosystem: "electron",
      });
    }
  }

  const candidates: WindowsEcosystem[] = ["dotnet", "native", "electron"];
  const ordered = candidates.filter((e) => ecosystems.has(e));

  // Stable sort: solutions first (by relative path), then projects.
  entrypoints.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "solution" ? -1 : 1;
    return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  });

  return {
    ecosystems: ordered,
    entrypoints,
    packageManager,
  };
}

function listDir(root: string): string[] {
  try {
    return fs.readdirSync(root);
  } catch {
    return [];
  }
}

function detectByGlob(_root: string, _ext: string): null {
  return null;
}

/**
 * Parse package.json (without prototype pollution) and report whether it
 * declares an Electron dependency. Only top-level `dependencies` and
 * `devDependencies` are inspected; scripts are never executed.
 */
function hasElectronDependency(pkgJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const deps = parsed.dependencies;
    const devDeps = parsed.devDependencies;
    const combined: Record<string, unknown> = {};
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      Object.assign(combined, deps);
    }
    if (devDeps && typeof devDeps === "object" && !Array.isArray(devDeps)) {
      Object.assign(combined, devDeps);
    }
    return Object.prototype.hasOwnProperty.call(combined, "electron");
  } catch {
    return false;
  }
}

/** Architecture/configuration enums exposed for callers/tests. */
export const ARCHITECTURES = ["x64", "x86", "ARM64"] as const;
export const CONFIGURATIONS = ["Debug", "Release"] as const;

/**
 * Lockfile → package-manager mapping. Exactly one lockfile is recognized per
 * project; a project with multiple lockfiles is reported as the first match in
 * canonical order (npm, pnpm, yarn) — `detectWindowsProject` already enforces
 * single-lockfile selection via `safeManifestPath`.
 */
export function lockfileToManager(lockfile: string): "npm" | "pnpm" | "yarn" | null {
  for (const [name, manager] of LOCKFILE_MAP) {
    if (lockfile === name) return manager;
  }
  return null;
}
