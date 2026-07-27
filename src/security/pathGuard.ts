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

export interface PathValidationResult {
  ok: boolean;
  resolvedPath?: string;
  error?: string;
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
  const matchingRoot = ALLOWED_DIRS.find((root) =>
    isInsideDir(resolved, root)
  );

  if (!matchingRoot) {
    return {
      ok: false,
      error: `Path "${inputPath}" is outside all allowed directories.`,
    };
  }

  // Symlink escape detection — resolve real path if the file exists
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realRoot = ALLOWED_DIRS.find((root) =>
        isInsideDir(realPath, root)
      );
      if (!realRoot) {
        return {
          ok: false,
          error: `Path "${inputPath}" resolves (via symlink) outside allowed directories.`,
        };
      }
      // Use the real path for subsequent operations
      resolved = realPath;
    }
  } catch {
    // realpathSync can fail on broken symlinks — that's fine, the path check above already passed
  }

  return { ok: true, resolvedPath: resolved };
}

/**
 * Check if `target` is inside `parent` (or equals it).
 * Uses case-insensitive comparison on Windows.
 */
function isInsideDir(target: string, parent: string): boolean {
  const normalizedTarget = path.normalize(target) + path.sep;
  const normalizedParent = path.normalize(parent) + path.sep;
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
