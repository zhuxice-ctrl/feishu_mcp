import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DevelopmentArtifact } from "./types.js";
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
