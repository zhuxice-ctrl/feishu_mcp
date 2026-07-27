/**
 * Transaction-safe file replacement with soft-delete history.
 *
 * The sibling temporary file is fully written and flushed before the original
 * is moved. If preservation or final replacement fails, the temporary/partial
 * output is removed and the original is restored before the error escapes.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { moveToTrash } from "../security/trash.js";

export interface AtomicWriteOptions {
  trashOriginal?: boolean;
  encoding?: BufferEncoding;
}

export interface AtomicWriteRuntime {
  exists(filePath: string): boolean;
  mkdir(directory: string): void;
  writeAndSync(filePath: string, content: string, encoding: BufferEncoding): void;
  rename(source: string, destination: string): void;
  remove(filePath: string): void;
  moveToTrash(filePath: string): string | null;
}

const defaultRuntime: AtomicWriteRuntime = {
  exists: (filePath) => fs.existsSync(filePath),
  mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
  writeAndSync: (filePath, content, encoding) => {
    fs.writeFileSync(filePath, content, encoding);
    // Windows requires a writable descriptor for fsyncSync.
    const descriptor = fs.openSync(filePath, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  },
  rename: (source, destination) => fs.renameSync(source, destination),
  remove: (filePath) => fs.rmSync(filePath, { force: true, recursive: true }),
  moveToTrash,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bestEffortRemove(runtime: AtomicWriteRuntime, filePath: string): void {
  try {
    if (runtime.exists(filePath)) runtime.remove(filePath);
  } catch {
    // Cleanup must not hide the primary failure.
  }
}

/**
 * The optional runtime overrides are intentionally exposed for deterministic
 * failure-injection tests; production callers use the default runtime.
 */
export function atomicWriteFile(
  target: string,
  content: string,
  opts: AtomicWriteOptions = {},
  runtimeOverrides: Partial<AtomicWriteRuntime> = {}
): { bytes: number; tempPath: string } {
  const { trashOriginal = true, encoding = "utf-8" } = opts;
  const runtime: AtomicWriteRuntime = { ...defaultRuntime, ...runtimeOverrides };
  const bytes = Buffer.byteLength(content, encoding);
  const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const hadOriginal = runtime.exists(target);
  let trashedPath: string | null = null;

  runtime.mkdir(path.dirname(target));

  // Do not disturb the original until a complete sibling replacement exists.
  try {
    runtime.writeAndSync(tempPath, content, encoding);
  } catch (error) {
    bestEffortRemove(runtime, tempPath);
    throw error;
  }

  if (hadOriginal && trashOriginal) {
    trashedPath = runtime.moveToTrash(target);
    if (!trashedPath) {
      bestEffortRemove(runtime, tempPath);
      throw new Error(`Atomic write aborted: failed to preserve original ${target}`);
    }
  }

  try {
    runtime.rename(tempPath, target);
  } catch (primaryError) {
    bestEffortRemove(runtime, target);
    let restoreError: unknown;
    if (trashedPath) {
      try {
        runtime.rename(trashedPath, target);
      } catch (error) {
        restoreError = error;
      }
    }
    bestEffortRemove(runtime, tempPath);

    if (restoreError) {
      throw new Error(
        `Atomic write failed (${messageOf(primaryError)}); original restore failed (${messageOf(restoreError)})`,
        { cause: primaryError }
      );
    }
    throw new Error(
      `Atomic write failed: ${messageOf(primaryError)}${trashedPath ? "; original restored" : ""}`,
      { cause: primaryError }
    );
  }

  if (!runtime.exists(target)) {
    throw new Error(`Atomic write failed: replacement missing after rename: ${target}`);
  }
  return { bytes, tempPath };
}
