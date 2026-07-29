/**
 * Detached development-task worker.
 *
 * Started by the coordinator with `detached: true` and `stdio: "ignore"`. The
 * worker receives only the task directory and a one-time token through
 * environment variables; it exits immediately if the token file does not match.
 *
 * The worker spawns the validated launch spec with `shell: false`, streams
 * redacted stdout/stderr to disk, refreshes a heartbeat, polls for
 * cancellation, and finalizes the task metadata exactly once. It never
 * force-kills a PID it did not spawn itself.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DEV_TASK_CANCEL_GRACE_MS,
  DEV_TASK_HEARTBEAT_MS,
  DEV_TASK_MAX_RUNTIME_MS,
} from "../../config.js";
import { DevelopmentTaskStore } from "./store.js";
import { StreamingTaskRedactor } from "./redaction.js";
import type { DevelopmentLaunchSpec } from "./types.js";
import {
  TASK_DIR_ENV,
  WORKER_TOKEN_ENV,
  heartbeatPath,
  isCancelRequested,
  stdoutLogPath,
  stderrLogPath,
  verifyWorkerToken,
  writeHeartbeat,
} from "./workerProtocol.js";

function fail(store: DevelopmentTaskStore, taskId: string, message: string, code = "TASK_INTERRUPTED"): void {
  try {
    store.update(taskId, "running", { state: "failed", endedAt: new Date().toISOString(), exit: { code: null, errorCode: code, message } });
  } catch {
    // metadata may already be terminal; best-effort
  }
}

async function runWorker(): Promise<void> {
  const taskDir = process.env[TASK_DIR_ENV];
  const token = process.env[WORKER_TOKEN_ENV];
  if (!taskDir || !token || !verifyWorkerToken(taskDir, token)) {
    process.exit(2);
    return;
  }
  const taskId = path.basename(taskDir);
  const root = path.dirname(taskDir);
  const store = new DevelopmentTaskStore(root);

  let spec: DevelopmentLaunchSpec;
  try {
    const loaded = store.loadLaunchSpec(taskId);
    if (!loaded) throw new Error("launch spec missing");
    spec = loaded;
  } catch (error) {
    fail(store, taskId, `launch load failed: ${(error as Error).message}`);
    return;
  }

  // Phase 1: secretEnvRefs must be empty. Resolution is added with DPAPI later.
  const secretRefs = spec.secretEnvRefs ?? {};
  if (Object.keys(secretRefs).length > 0) {
    fail(store, taskId, "secretEnvRefs resolution is not available in Phase 1");
    return;
  }

  // The worker is the only place resolved secrets would live; in Phase 1 the
  // redaction set is the adapter-provided env values plus any stdin.
  const redactorSecrets = [
    ...Object.values(spec.env),
    ...(spec.stdin ? [spec.stdin] : []),
  ];

  const stdoutRedactor = new StreamingTaskRedactor(redactorSecrets);
  const stderrRedactor = new StreamingTaskRedactor(redactorSecrets);

  const stdoutFd = fs.openSync(stdoutLogPath(taskDir), "a", 0o600);
  const stderrFd = fs.openSync(stderrLogPath(taskDir), "a", 0o600);

  const childEnv = { ...process.env, ...spec.env };
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  const nonce = token.slice(0, 16);
  const pid = child.pid ?? 0;
  let finalized = false;
  let cancelled = false;

  const heartbeat = () => writeHeartbeat(taskDir, { pid, nonce, heartbeatAt: new Date().toISOString() });
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, DEV_TASK_HEARTBEAT_MS);

  const cancelTimer = setInterval(() => {
    if (isCancelRequested(taskDir)) {
      cancelled = true;
      try { store.update(taskId, "running", { state: "cancel_requested" }); } catch {}
      safeKill(child);
    }
  }, Math.max(250, Math.floor(DEV_TASK_HEARTBEAT_MS / 2)));

  const runtimeTimer = setTimeout(() => {
    safeKill(child);
  }, Math.min(DEV_TASK_MAX_RUNTIME_MS, spec.timeoutMs || DEV_TASK_MAX_RUNTIME_MS));

  child.stdout?.on("data", (chunk: Buffer) => {
    const redacted = stdoutRedactor.push(chunk.toString("utf8"));
    if (redacted) fs.writeSync(stdoutFd, redacted);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const redacted = stderrRedactor.push(chunk.toString("utf8"));
    if (redacted) fs.writeSync(stderrFd, redacted);
  });

  if (spec.stdin && child.stdin) {
    child.stdin.end(spec.stdin);
  }

  function safeKill(target: ReturnType<typeof spawn>): void {
    try {
      if (target.pid) {
        // Signal the whole process group (child was spawned detached).
        try { process.kill(-target.pid, "SIGTERM"); } catch { process.kill(target.pid, "SIGTERM"); }
      }
    } catch {
      // already dead
    }
    setTimeout(() => {
      try {
        if (target.pid) {
          try { process.kill(-target.pid, "SIGKILL"); } catch { process.kill(target.pid, "SIGKILL"); }
        }
      } catch {
        // already dead
      }
    }, DEV_TASK_CANCEL_GRACE_MS).unref();
  }

  function finalize(code: number | null): void {
    if (finalized) return;
    finalized = true;
    clearInterval(heartbeatTimer);
    clearInterval(cancelTimer);
    clearTimeout(runtimeTimer);
    const tailOut = stdoutRedactor.flush();
    if (tailOut) fs.writeSync(stdoutFd, tailOut);
    const tailErr = stderrRedactor.flush();
    if (tailErr) fs.writeSync(stderrFd, tailErr);
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    const endedAt = new Date().toISOString();
    const success = !cancelled && (code !== null && spec.successExitCodes.includes(code));
    try {
      const expected = cancelled ? "cancel_requested" : "running";
      store.update(taskId, expected, {
        state: cancelled ? "cancelled" : success ? "succeeded" : "failed",
        endedAt,
        exit: { code, errorCode: cancelled ? "TASK_CANCELLED" : success ? undefined : "PROCESS_FAILED" },
      });
    } catch {
      // already terminal
    }
    // heartbeat file is kept for recovery inspection; not sensitive.
    void heartbeatPath;
  }

  child.on("exit", (code, signal) => {
    finalize(code ?? (signal ? null : 0));
  });
  child.on("error", (error) => {
    try { fs.writeSync(stderrFd, `[worker] child error: ${error.message}\n`); } catch {}
    finalize(null);
  });
}

void runWorker().catch((error) => {
  // Last-resort: ensure the process exits nonzero so the coordinator's
  // recovery sees an interrupted task rather than a hung one.
  void error;
  process.exit(3);
});
