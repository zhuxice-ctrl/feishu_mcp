/**
 * Android build artifact collection.
 *
 * After a Gradle action succeeds, the adapter scans only the expected output
 * directories for the action/variant combination and collects `.apk`, `.aab`,
 * JUnit XML, and HTML report entry points. Symlinks are refused outright, and
 * any file that canonicalizes outside the expected roots is refused — a build
 * can never smuggle an artifact (or a secret) from elsewhere on the host into
 * the task result.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DevelopmentArtifact } from "../tasks/types.js";

type GradleArtifactAction = "build" | "bundle" | "test_unit" | "test_instrumented" | "clean";

interface ScanRoot {
  dir: string;
  /** extensions to collect (lowercase, with dot), or null to collect index.html */
  extensions: readonly string[] | null;
  kind: (name: string) => string;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function scanRoots(root: string, module: string, variant: string, action: GradleArtifactAction): ScanRoot[] {
  const base = path.join(root, module, "build");
  const v = cap(variant);
  switch (action) {
    case "build":
      return [
        { dir: path.join(base, "outputs", "apk", variant), extensions: [".apk"], kind: () => "apk" },
        { dir: path.join(base, "outputs", "bundle", variant), extensions: [".aab"], kind: () => "aab" },
      ];
    case "bundle":
      return [
        { dir: path.join(base, "outputs", "bundle", variant), extensions: [".aab"], kind: () => "aab" },
      ];
    case "test_unit":
      return [
        { dir: path.join(base, "test-results", `test${v}UnitTest`), extensions: [".xml"], kind: () => "junit-xml" },
        { dir: path.join(base, "reports", "tests", `test${v}UnitTest`), extensions: null, kind: () => "html-report" },
      ];
    case "test_instrumented":
      return [
        { dir: path.join(base, "outputs", "androidTest-results", "connected", variant), extensions: [".xml"], kind: () => "junit-xml" },
        { dir: path.join(base, "reports", "androidTest", "connected", variant), extensions: null, kind: () => "html-report" },
      ];
    case "clean":
      return [];
  }
}

export function collectArtifacts(
  root: string,
  module: string,
  variant: string,
  action: GradleArtifactAction,
): DevelopmentArtifact[] {
  const artifacts: DevelopmentArtifact[] = [];
  for (const scan of scanRoots(root, module, variant, action)) {
    if (!fs.existsSync(scan.dir)) continue;
    const canonicalRoot = fs.realpathSync(scan.dir);
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
      // refuse anything that canonicalizes outside the expected root
      const canonical = fs.realpathSync(full);
      const rel = path.relative(canonicalRoot, canonical);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

      const ext = path.extname(name).toLowerCase();
      const isHtmlEntry = scan.extensions === null && name === "index.html";
      const isExtMatch = scan.extensions !== null && scan.extensions.includes(ext);
      if (!isHtmlEntry && !isExtMatch) continue;

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
