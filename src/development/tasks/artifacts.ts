import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DevelopmentArtifact, DevelopmentDirectorySummary } from "./types.js";
import { artifactManifestPath } from "./workerProtocol.js";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_ARTIFACTS = 256;
const SAFE_KIND = /^[a-z0-9._-]{1,64}$/i;

export interface DevelopmentArtifactEntry {
  name: string;
  path: string;
  kind: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeManifestEntries(taskDir: string): DevelopmentArtifactEntry[] {
  const file = artifactManifestPath(taskDir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return [];
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(file, flags);
    try {
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as {
        version?: unknown;
        artifacts?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) return [];
      if (parsed.artifacts.length > MAX_ARTIFACTS) return [];
      return parsed.artifacts.filter((entry): entry is DevelopmentArtifactEntry => {
        if (!entry || typeof entry !== "object") return false;
        const value = entry as Partial<DevelopmentArtifactEntry>;
        return Boolean(
          typeof value.name === "string" && value.name.length > 0 && value.name.length <= 255 &&
          !/[\\/\0]/.test(value.name) &&
          typeof value.path === "string" && path.isAbsolute(value.path) &&
          typeof value.kind === "string" && SAFE_KIND.test(value.kind)
        );
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function hasLinkBetween(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (!isInside(root, candidate)) return true;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

export function assertAuthorizedArtifactTarget(target: string, roots: readonly string[]): void {
  const candidate = path.resolve(target);
  const parent = path.dirname(candidate);
  for (const configuredRoot of roots) {
    try {
      const root = path.resolve(configuredRoot);
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !isInside(root, candidate)) continue;
      const parentStat = fs.lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || hasLinkBetween(root, parent)) continue;
      const realRoot = fs.realpathSync.native(root);
      const realParent = fs.realpathSync.native(parent);
      if (!isInside(realRoot, realParent)) continue;
      try {
        const targetStat = fs.lstatSync(candidate);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      return;
    } catch {
      // Try another configured root.
    }
  }
  throw new Error("artifact target unavailable");
}

export function inspectAuthorizedArtifact(
  entry: DevelopmentArtifactEntry,
  roots: readonly string[],
): DevelopmentArtifact | undefined {
  const candidate = path.resolve(entry.path);
  for (const configuredRoot of roots) {
    try {
      const root = path.resolve(configuredRoot);
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !isInside(root, candidate)) continue;
      if (hasLinkBetween(root, candidate)) continue;
      const realRoot = fs.realpathSync.native(root);
      const realCandidate = fs.realpathSync.native(candidate);
      if (!isInside(realRoot, realCandidate)) continue;
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(candidate, flags);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < stat.size) {
          const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
          if (bytesRead <= 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        if (position !== stat.size) continue;
        return {
          name: entry.name,
          path: realCandidate,
          kind: entry.kind,
          size: stat.size,
          sha256: hash.digest("hex"),
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Invalid, vanished, or link-swapped entry: try the next authorized root.
    }
  }
  return undefined;
}

export function collectDevelopmentArtifacts(
  taskDir: string,
  authorizedRoots: readonly string[],
): DevelopmentArtifact[] {
  if (authorizedRoots.length === 0) return [];
  const artifacts: DevelopmentArtifact[] = [];
  for (const entry of safeManifestEntries(taskDir)) {
    const artifact = inspectAuthorizedArtifact(entry, authorizedRoots);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

// ---------------------------------------------------------------------------
// Directory artifact summaries (Phase 1 — workflow output inspection)
// ---------------------------------------------------------------------------

const MAX_DIR_ENTRIES = 100_000;
const MAX_DIR_BYTES = 1_073_741_824; // 1 GiB cap on traversal

/**
 * Inspect a configured output directory and return aggregate file count and
 * byte total. Never follows symlinks, never returns file names or paths —
 * only the aggregate summary. Returns undefined when the directory is absent,
 * is a link, escapes an authorized root, or exceeds the traversal cap.
 */
export function summarizeDirectory(
  dirPath: string,
  authorizedRoots: readonly string[],
): DevelopmentDirectorySummary | undefined {
  const candidate = path.resolve(dirPath);
  // Find an authorized root that contains this directory.
  for (const configuredRoot of authorizedRoots) {
    try {
      const root = path.resolve(configuredRoot);
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
      if (!isInside(root, candidate)) continue;
      if (hasLinkBetween(root, candidate)) continue;
      const realRoot = fs.realpathSync.native(root);
      const realCandidate = fs.realpathSync.native(candidate);
      if (!isInside(realRoot, realCandidate)) continue;
      const dirStat = fs.lstatSync(candidate);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;

      let fileCount = 0;
      let byteTotal = 0;
      const walk = (current: string): boolean => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return true; // vanished mid-walk; return what we have
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (!walk(full)) return false;
          } else if (entry.isFile()) {
            fileCount += 1;
            if (fileCount > MAX_DIR_ENTRIES) return false;
            try {
              byteTotal += fs.lstatSync(full).size;
            } catch {
              // vanished; ignore
            }
            if (byteTotal > MAX_DIR_BYTES) return false;
          }
        }
        return true;
      };
      walk(candidate);
      return {
        id: path.basename(candidate),
        kind: "directory-summary",
        path: realCandidate,
        fileCount: Math.min(fileCount, MAX_DIR_ENTRIES),
        byteTotal: Math.min(byteTotal, MAX_DIR_BYTES),
      };
    } catch {
      // try next root
    }
  }
  return undefined;
}

/**
 * Collect directory summaries for all configured artifact directories of a
 * successful workflow. Returns only summaries for directories that remain
 * inside authorized roots.
 */
export function collectDirectorySummaries(
  artifactDirs: readonly string[],
  authorizedRoots: readonly string[],
): DevelopmentDirectorySummary[] {
  if (artifactDirs.length === 0 || authorizedRoots.length === 0) return [];
  const summaries: DevelopmentDirectorySummary[] = [];
  for (const dir of artifactDirs) {
    const summary = summarizeDirectory(dir, authorizedRoots);
    if (summary) summaries.push(summary);
  }
  return summaries;
}
