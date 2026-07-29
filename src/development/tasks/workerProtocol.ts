/**
 * On-disk protocol shared between the coordinator and detached workers.
 *
 * Each task directory contains:
 *   metadata.json   — task record (atomic, 0600)
 *   launch.json     — validated launch spec (0600, never returned to clients)
 *   worker-token    — 32 random bytes hex (0600); worker exits if it mismatches
 *   heartbeat.json  — { pid, nonce, heartbeatAt } refreshed by the worker
 *   stdout.log      — redacted worker child stdout (append-only)
 *   stderr.log      — redacted worker child stderr (append-only)
 *   cancel-request  — presence signals cancellation
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const TASK_DIR_ENV = "FEISHU_MCP_TASK_DIR";
export const WORKER_TOKEN_ENV = "FEISHU_MCP_WORKER_TOKEN";

export interface WorkerHeartbeat {
  pid: number;
  nonce: string;
  heartbeatAt: string;
}

export function workerTokenPath(taskDir: string): string {
  return path.join(taskDir, "worker-token");
}

export function heartbeatPath(taskDir: string): string {
  return path.join(taskDir, "heartbeat.json");
}

export function cancelRequestPath(taskDir: string): string {
  return path.join(taskDir, "cancel-request");
}

export function stdoutLogPath(taskDir: string): string {
  return path.join(taskDir, "stdout.log");
}

export function stderrLogPath(taskDir: string): string {
  return path.join(taskDir, "stderr.log");
}

/** Generate and persist a fresh 32-byte worker token (mode 0600). */
export function issueWorkerToken(taskDir: string): string {
  const token = randomBytes(32).toString("hex");
  const file = workerTokenPath(taskDir);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, token, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return token;
}

/** Read and verify the token file against the worker's env token. */
export function verifyWorkerToken(taskDir: string, expected: string): boolean {
  try {
    const actual = fs.readFileSync(workerTokenPath(taskDir), "utf8").trim();
    return actual.length > 0 && actual === expected;
  } catch {
    return false;
  }
}

/** Atomically refresh the heartbeat file. */
export function writeHeartbeat(taskDir: string, beat: WorkerHeartbeat): void {
  const file = heartbeatPath(taskDir);
  const temporary = path.join(taskDir, `.heartbeat-${process.pid}-${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(beat)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

export function readHeartbeat(taskDir: string): WorkerHeartbeat | undefined {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath(taskDir), "utf8")) as WorkerHeartbeat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export function requestCancel(taskDir: string): void {
  try {
    const fd = fs.openSync(cancelRequestPath(taskDir), "wx", 0o600);
    fs.writeFileSync(fd, `${new Date().toISOString()}\n`, "utf8");
    fs.closeSync(fd);
  } catch {
    // already present; that's fine
  }
}

export function isCancelRequested(taskDir: string): boolean {
  try {
    fs.accessSync(cancelRequestPath(taskDir));
    return true;
  } catch {
    return false;
  }
}
