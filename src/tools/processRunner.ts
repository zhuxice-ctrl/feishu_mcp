import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

export function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let settled = false;
    let termination = Promise.resolve();

    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, options.maxOutputBytes - captured);
      const kept = chunk.subarray(0, remaining);
      if (kept.length < chunk.length) truncated = true;
      captured += kept.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const stop = () => {
      if (!child.pid || killed) return;
      killed = true;
      termination = terminateTree(child.pid).finally(() => {
        try { child.kill("SIGKILL"); } catch {}
      });
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      void termination.finally(() => resolve({
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          exitCode,
          killed,
          timedOut,
          truncated,
          durationMs: Math.round(performance.now() - started),
        }));
    });
  });
}
