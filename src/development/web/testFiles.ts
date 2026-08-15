/**
 * Safe test-file path validation for the web verification workflow.
 *
 * Restricts caller-supplied test file paths to safe relative tokens that:
 *   - are relative (no absolute paths)
 *   - contain no `..` segments
 *   - contain no backslashes or null bytes
 *   - end with a recognized test extension
 *   - are within the configured length limit
 *
 * After validation, paths are joined to the workspace root and confirmed to
 * resolve inside it.
 */

import path from "node:path";
import fs from "node:fs";

const MAX_TEST_FILES = 128;
const MAX_PATH_LENGTH = 512;
const SAFE_TEST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export class TestFileError extends Error {}

/**
 * Validate and normalize caller-supplied test file paths against a workspace
 * root. Returns the absolute resolved paths that are confirmed to be inside
 * the root. Rejects absolute paths, `..` segments, symlinks, missing files,
 * wrong extensions, duplicates, and over-limit arrays.
 */
export function validateTestFiles(
  testFiles: string[],
  workspaceRoot: string,
): string[] {
  if (!Array.isArray(testFiles)) {
    throw new TestFileError("test files must be an array");
  }
  if (testFiles.length > MAX_TEST_FILES) {
    throw new TestFileError(`too many test files (max ${MAX_TEST_FILES})`);
  }
  const root = path.resolve(workspaceRoot);
  const realRoot = fs.realpathSync.native(root);
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const raw of testFiles) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_LENGTH) {
      throw new TestFileError("invalid test file path");
    }
    if (path.isAbsolute(raw)) {
      throw new TestFileError("test file paths must be relative");
    }
    if (raw.includes("..")) {
      throw new TestFileError("test file paths must not contain '..'");
    }
    if (raw.includes("\0") || raw.includes("\\")) {
      throw new TestFileError("test file paths must not contain backslashes or null bytes");
    }
    const ext = path.extname(raw).toLowerCase();
    if (!SAFE_TEST_EXTENSIONS.has(ext)) {
      throw new TestFileError(`unsupported test file extension: ${ext}`);
    }
    const joined = path.resolve(root, raw);
    const relative = path.relative(realRoot, joined);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TestFileError(`test file escapes workspace root: ${raw}`);
    }
    // Check for symlinks in the path.
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new TestFileError("test file paths must not traverse symlinks");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new TestFileError(`test file not found: ${raw}`);
        }
        throw error;
      }
    }
    // Must be a file.
    try {
      if (!fs.statSync(joined).isFile()) {
        throw new TestFileError(`test file is not a regular file: ${raw}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TestFileError(`test file not found: ${raw}`);
      }
      if (error instanceof TestFileError) throw error;
      throw new TestFileError(`cannot access test file: ${raw}`);
    }
    if (seen.has(joined)) {
      throw new TestFileError(`duplicate test file: ${raw}`);
    }
    seen.add(joined);
    resolved.push(joined);
  }
  return resolved;
}

/**
 * Extract the relative paths from validated absolute paths, suitable for
 * passing as command-line arguments to the test runner.
 */
export function relativeTestPaths(
  absolutePaths: string[],
  workspaceRoot: string,
): string[] {
  const root = path.resolve(workspaceRoot);
  return absolutePaths.map((abs) => path.relative(root, abs).split(path.sep).join("/"));
}
