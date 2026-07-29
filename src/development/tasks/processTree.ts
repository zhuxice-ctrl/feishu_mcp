import { spawn } from "node:child_process";

export interface ProcessTreeTermination {
  cancel(): void;
}

interface SpawnedHelper {
  on?(event: "error", listener: () => void): unknown;
  unref?(): void;
}

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  graceMs: number;
  spawnHelper?: (
    executable: string,
    args: string[],
    options: { shell: false; windowsHide: true; stdio: "ignore" },
  ) => SpawnedHelper;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Terminate only a child tree created by the task worker.
 *
 * Windows has no POSIX process-group signal. Waiting before taskkill preserves
 * the configured cancellation grace, while /T /F ensures Gradle/MSBuild/Node
 * descendants do not survive. The caller must cancel the returned timer when
 * the child exits naturally, preventing a later PID-reuse kill.
 */
export function terminateProcessTree(
  pid: number,
  options: ProcessTreeTerminationOptions,
): ProcessTreeTermination {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { cancel() {} };
  }
  const platform = options.platform ?? process.platform;
  const spawnHelper = options.spawnHelper ?? ((executable, args, spawnOptions) =>
    spawn(executable, args, spawnOptions));
  const kill = options.kill ?? process.kill.bind(process);

  if (platform !== "win32") {
    try {
      try { kill(-pid, "SIGTERM"); } catch { kill(pid, "SIGTERM"); }
    } catch {
      // The child may already have exited.
    }
  }

  const timer = setTimeout(() => {
    if (platform === "win32") {
      try {
        const helper = spawnHelper(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        helper.on?.("error", () => {});
        helper.unref?.();
      } catch {
        // The child may already have exited or taskkill may be unavailable.
      }
      return;
    }
    try {
      try { kill(-pid, "SIGKILL"); } catch { kill(pid, "SIGKILL"); }
    } catch {
      // The child may already have exited.
    }
  }, Math.max(0, options.graceMs));
  timer.unref();

  return {
    cancel(): void {
      clearTimeout(timer);
    },
  };
}
