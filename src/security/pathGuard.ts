/**
 * Path security — directory whitelist enforcement and traversal prevention.
 *
 * Every file tool must call `validatePath()` before touching the filesystem.
 * The function:
 *   1. Resolves the requested path to an absolute path.
 *   2. Checks it falls inside one of the ALLOWED_DIRS roots.
 *   3. Detects symlink escapes (the resolved real path must also stay inside a root).
 *   4. Rejects path-traversal attempts (`../` that would escape the root).
 */

import fs from "node:fs";
import path from "node:path";
import { ALLOWED_DIRS } from "../config.js";
import { isInternalApprovalPath } from "./approvalStore.js";

export interface PathValidationResult {
  ok: boolean;
  resolvedPath?: string;
  error?: string;
}

function existsIncludingBrokenSymlink(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the nearest existing ancestor and append the still-missing suffix.
 * This catches writes such as `allowed/link-to-outside/new-file`, where the
 * final target does not exist yet but an ancestor is a symlink or junction.
 */
function resolveThroughExistingAncestor(candidate: string): string {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];

  while (!existsIncludingBrokenSymlink(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Unable to resolve an existing ancestor for ${candidate}`);
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  const realAncestor = fs.realpathSync(cursor);
  return path.resolve(realAncestor, ...missingSegments);
}

/**
 * Validate that `inputPath` resolves to a location inside one of the
 * allowed directories. Returns the resolved absolute path on success.
 */
export function validatePath(inputPath: string): PathValidationResult {
  if (ALLOWED_DIRS.length === 0) {
    return {
      ok: false,
      error:
        "No allowed directories configured. Set ALLOWED_DIRS environment variable.",
    };
  }

  let resolved: string = "";

  // Handle relative paths — resolve against the first allowed dir as CWD fallback
  if (path.isAbsolute(inputPath)) {
    resolved = path.resolve(inputPath);
  } else {
    // Try resolving relative to each allowed dir; pick the first match
    let found = false;
    for (const root of ALLOWED_DIRS) {
      const candidate = path.resolve(root, inputPath);
      if (isInsideDir(candidate, root)) {
        resolved = candidate;
        found = true;
        break;
      }
    }
    if (!found) {
      // Default resolve (CWD-relative) and let the whitelist check reject it
      resolved = path.resolve(inputPath);
    }
  }

  // Check against each allowed root
  const matchingRoot = ALLOWED_DIRS.find((root) => isInsideDir(resolved, root));

  if (!matchingRoot) {
    return {
      ok: false,
      error: `Path "${inputPath}" is outside all allowed directories.`,
    };
  }

  if (isInternalApprovalPath(resolved)) {
    return {
      ok: false,
      error: `Path "${inputPath}" is an internal protected path.`,
    };
  }

  // Resolve an existing target or its nearest existing ancestor. Checking only
  // an existing final target would allow writes through a symlinked directory.
  try {
    const physicalPath = resolveThroughExistingAncestor(resolved);
    const physicalRoots = ALLOWED_DIRS.flatMap((root) => {
      try {
        return [resolveThroughExistingAncestor(root)];
      } catch {
        return [];
      }
    });
    if (!physicalRoots.some((root) => isInsideDir(physicalPath, root))) {
      return {
        ok: false,
        error: `Path "${inputPath}" resolves (via symlink) outside allowed directories.`,
      };
    }
    if (isInternalApprovalPath(physicalPath)) {
      return {
        ok: false,
        error: `Path "${inputPath}" is an internal protected path.`,
      };
    }
    resolved = physicalPath;
  } catch {
    return {
      ok: false,
      error: `Path "${inputPath}" could not be safely resolved.`,
    };
  }

  return { ok: true, resolvedPath: resolved };
}

/**
 * Check if `target` is inside `parent` (or equals it).
 * Uses case-insensitive comparison on Windows.
 */
function isInsideDir(target: string, parent: string): boolean {
  let normalizedTarget = path.normalize(target) + path.sep;
  let normalizedParent = path.normalize(parent) + path.sep;
  if (process.platform === "win32") {
    normalizedTarget = normalizedTarget.toLowerCase();
    normalizedParent = normalizedParent.toLowerCase();
  }
  return (
    normalizedTarget === normalizedParent ||
    normalizedTarget.startsWith(normalizedParent)
  );
}

/**
 * List the configured allowed directories (for the `list_allowed_directories` tool).
 */
export function getAllowedDirectories(): string[] {
  return [...ALLOWED_DIRS];
}
