/**
 * Owned Windows process execution.
 *
 * Only an artifact produced or explicitly selected inside an authorized
 * project/output root may be run. The caller never supplies an executable
 * path outside the authorized root, never supplies arguments, and never
 * supplies a process id. A running application is treated as a development
 * task: its canonical path hash is persisted in the launch spec, and a `stop`
 * resolves to the same task id (routed through `cancel_development_task` or a
 * `stop` action) — never a caller-supplied PID.
 *
 * Restart recovery is handled by the shared task coordinator: a run task is a
 * standard launch spec, so the coordinator's existing recovery sweep reaps
 * orphaned processes whose heartbeat went stale after a server restart.
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalPathHash } from "./signing.js";

/** Executable artifact extensions that may be run. */
export const RUNNABLE_EXTENSIONS = [".exe"] as const;

export interface WindowsRunRequest {
  /** Absolute path to the artifact inside an authorized output root. */
  artifactPath: string;
  /** Working directory (must be inside the authorized root). */
  cwd: string;
  timeoutMs: number;
}

export interface WindowsRunPlan {
  executable: string;
  args: string[];
  cwd: string;
  /** SHA-256 of the canonical (real) artifact path, bound to the approval. */
  canonicalPathHash: string;
  timeoutMs: number;
  /** Run tasks succeed on any exit code (an app may exit non-zero by design). */
  successExitCodes: number[];
}

export interface RunPlanOptions {
  authorizeHostPath: (hostPath: string) => boolean;
}

function authorize(p: string, authorizeHostPath: (p: string) => boolean): void {
  if (!authorizeHostPath(p)) {
    throw new Error(`host path outside authorized directory: ${p}`);
  }
}

/**
 * Plan a run of a produced artifact. The artifact must exist, be a regular
 * file (no symlinks), have a runnable extension, and canonicalize inside the
 * authorized root. No caller arguments are accepted — `args` is always empty.
 */
export function planWindowsRun(
  request: WindowsRunRequest,
  options: RunPlanOptions,
): WindowsRunPlan {
  authorize(request.artifactPath, options.authorizeHostPath);
  authorize(request.cwd, options.authorizeHostPath);

  const ext = path.extname(request.artifactPath).toLowerCase();
  if (!(RUNNABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`not a runnable artifact: ${request.artifactPath}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(request.artifactPath);
  } catch {
    throw new Error(`artifact not found: ${request.artifactPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink artifact refused: ${request.artifactPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`not a file: ${request.artifactPath}`);
  }

  // Canonicalize and confirm the real path is still inside the authorized
  // root (defends against junction escapes resolved after lstat).
  const real = safeRealpath(request.artifactPath);
  authorize(real, options.authorizeHostPath);

  const cwdReal = safeRealpath(request.cwd);
  authorize(cwdReal, options.authorizeHostPath);

  return {
    executable: real,
    args: [],
    cwd: cwdReal,
    canonicalPathHash: canonicalPathHash(real),
    timeoutMs: request.timeoutMs,
    successExitCodes: [], // any exit code is acceptable for a run task
  };
}

/**
 * Resolve a stop request to a task id. The caller must supply the task id
 * returned by the original run enqueue — never a process id. Returns the
 * matching task record id, or null if the task is unknown/terminal.
 */
export function resolveStopTaskId(
  taskId: string,
  isTerminal: (id: string) => boolean,
): { taskId: string } | { alreadyTerminal: true } | { notFound: true } {
  if (!taskId || typeof taskId !== "string") {
    return { notFound: true };
  }
  if (isTerminal(taskId)) {
    return { alreadyTerminal: true };
  }
  return { taskId };
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
