import fs from "node:fs";
import path from "node:path";

export type DirectoryScopeKind = "file" | "directory";

export interface CanonicalDirectoryRoot {
  logicalRoot: string;
  physicalRoot: string;
}

export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveThroughExistingAncestor(candidate: string): string {
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(cursor);
      return path.resolve(fs.realpathSync(cursor), ...missing);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor for ${candidate}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalizeDirectoryScope(
  candidate: string,
  kind: DirectoryScopeKind,
): CanonicalDirectoryRoot {
  const absolute = path.resolve(candidate);
  const logicalRoot = kind === "file" ? path.dirname(absolute) : absolute;
  return {
    logicalRoot,
    physicalRoot: resolveThroughExistingAncestor(logicalRoot),
  };
}

export function deduplicateRoots(
  roots: readonly CanonicalDirectoryRoot[],
): CanonicalDirectoryRoot[] {
  const sorted = roots
    .map((root) => ({ ...root }))
    .sort((a, b) => pathKey(a.logicalRoot).localeCompare(pathKey(b.logicalRoot)));
  const seen = new Set<string>();
  return sorted.filter((root) => {
    const key = pathKey(root.physicalRoot);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
