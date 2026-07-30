/**
 * Windows build artifact collection.
 *
 * After a .NET/MSBuild/native/Electron action succeeds, the adapter scans only
 * the known output, package, publish, TestResults, and AppPackages roots.
 * Canonicalize and hash installers/packages/binaries; record test reports as
 * reports. Symlinks are refused outright, and any file that canonicalizes
 * outside the expected roots is refused — a build can never smuggle an
 * artifact (or a secret) from elsewhere on the host into the task result.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DevelopmentArtifact } from "../tasks/types.js";

type WindowsArtifactAction =
  | "restore"
  | "build"
  | "test"
  | "publish"
  | "pack"
  | "generate_dependency_lock"
  | "rebuild"
  | "clean"
  | "configure"
  | "install"
  | "package";

interface ScanRoot {
  dir: string;
  extensions: readonly string[] | null;
  kind: (name: string) => string;
}

const BINARY_EXTENSIONS = [".exe", ".dll", ".msi", ".msix", ".nupkg", ".zip", ".appx"] as const;
const REPORT_EXTENSIONS = [".xml", ".trx"] as const;

function binaryKind(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".exe") return "executable";
  if (ext === ".dll") return "library";
  if (ext === ".msi" || ext === ".msix" || ext === ".appx") return "installer";
  if (ext === ".nupkg") return "nuget-package";
  if (ext === ".zip") return "archive";
  return "binary";
}

/**
 * Resolve the scan roots for a .NET/MSBuild/native action. Only known output
 * directories are inspected — never the entire project or user profile.
 */
export function scanRootsFor(
  root: string,
  projectOrSolution: string,
  action: WindowsArtifactAction,
  configuration: string,
): ScanRoot[] {
  const base = path.dirname(path.join(root, projectOrSolution));
  switch (action) {
    case "build":
    case "rebuild":
      return [
        { dir: path.join(base, "bin"), extensions: BINARY_EXTENSIONS, kind: binaryKind },
        { dir: path.join(base, "AppPackages"), extensions: BINARY_EXTENSIONS, kind: binaryKind },
      ];
    case "publish":
      return [
        { dir: path.join(base, "bin", configuration, "publish"), extensions: BINARY_EXTENSIONS, kind: binaryKind },
      ];
    case "pack":
      return [
        { dir: path.join(base, "bin", configuration), extensions: [".nupkg"], kind: () => "nuget-package" },
      ];
    case "test":
      return [
        { dir: path.join(base, "TestResults"), extensions: REPORT_EXTENSIONS, kind: () => "test-report" },
      ];
    case "restore":
    case "generate_dependency_lock":
    case "clean":
    case "configure":
    case "install":
      return [];
    case "package":
      return [
        { dir: path.join(base, "dist"), extensions: BINARY_EXTENSIONS, kind: binaryKind },
        { dir: path.join(base, "release"), extensions: BINARY_EXTENSIONS, kind: binaryKind },
      ];
  }
}

export function collectWindowsArtifacts(
  root: string,
  projectOrSolution: string,
  action: WindowsArtifactAction,
  configuration: string,
): DevelopmentArtifact[] {
  const artifacts: DevelopmentArtifact[] = [];
  for (const scan of scanRootsFor(root, projectOrSolution, action, configuration)) {
    if (!fs.existsSync(scan.dir)) continue;
    const canonicalRoot = safeRealpath(scan.dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(scan.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(scan.dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue; // refuse symlinks
      if (!stat.isFile()) continue;
      const canonical = safeRealpath(full);
      const rel = path.relative(canonicalRoot, canonical);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

      const ext = path.extname(name).toLowerCase();
      const isExtMatch = scan.extensions !== null && scan.extensions.includes(ext as never);
      if (!isExtMatch) continue;

      const content = fs.readFileSync(full);
      artifacts.push({
        name,
        path: full,
        kind: scan.kind(name),
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return artifacts;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
