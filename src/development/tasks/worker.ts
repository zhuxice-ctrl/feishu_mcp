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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DEV_TASK_CANCEL_GRACE_MS,
  DEV_TASK_HEARTBEAT_MS,
  DEV_TASK_MAX_RUNTIME_MS,
} from "../../config.js";
import { DevelopmentTaskStore } from "./store.js";
import { StreamingTaskRedactor } from "./redaction.js";
import type { DevelopmentBinaryStdoutSink, DevelopmentLaunchSpec } from "./types.js";
import { terminateProcessTree, type ProcessTreeTermination } from "./processTree.js";
import {
  assertAuthorizedArtifactTarget,
  collectDevelopmentArtifacts,
  inspectAuthorizedArtifact,
} from "./artifacts.js";
import { safeRuntimeEnvironment } from "./runtimeEnvironment.js";
import { WindowsDpapiCredentialResolver } from "../credentials/dpapiStore.js";
import type { CredentialResolver } from "../credentials/types.js";
import {
  TASK_DIR_ENV,
  WORKER_TOKEN_ENV,
  ARTIFACT_MANIFEST_ENV,
  artifactManifestPath,
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

export interface WorkerRunOptions {
  /** Test hooks; detached production workers use their curated environment. */
  taskDir?: string;
  token?: string;
  approvalDataDir?: string;
  credentialResolver?: CredentialResolver;
}

interface PreparedBinarySink {
  spec: DevelopmentBinaryStdoutSink;
  stagingPath: string;
  fd: number;
  writeFailed: boolean;
}

function prepareBinarySink(
  spec: DevelopmentBinaryStdoutSink,
  artifactRoots: readonly string[],
): PreparedBinarySink {
  assertAuthorizedArtifactTarget(spec.target, artifactRoots);
  const stagingPath = path.join(
    path.dirname(spec.target),
    `.${path.basename(spec.target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const fd = fs.openSync(stagingPath, "wx", 0o600);
  return { spec, stagingPath, fd, writeFailed: false };
}

function writeAll(fd: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
    if (written <= 0) throw new Error("binary stdout write failed");
    offset += written;
  }
}

function cleanupBinarySink(sink: PreparedBinarySink | undefined): void {
  if (!sink) return;
  try { fs.closeSync(sink.fd); } catch {}
  try { fs.rmSync(sink.stagingPath, { force: true }); } catch {}
}

export async function runWorker(options: WorkerRunOptions = {}): Promise<void> {
  const taskDir = options.taskDir ?? process.env[TASK_DIR_ENV];
  const token = options.token ?? process.env[WORKER_TOKEN_ENV];
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

  const secretRefs = spec.secretEnvRefs ?? {};
  let resolvedSecretEnv = new Map<string, string>();
  if (Object.keys(secretRefs).length > 0) {
    const approvalDataDir = options.approvalDataDir ?? process.env.APPROVAL_DATA_DIR;
    try {
      if (!approvalDataDir) throw new Error("missing approval data directory");
      const resolver = options.credentialResolver ?? new WindowsDpapiCredentialResolver(approvalDataDir);
      resolvedSecretEnv = resolver.resolveRefs(secretRefs);
    } catch {
      fail(store, taskId, "credential unavailable", "CREDENTIAL_UNAVAILABLE");
      return;
    }
  }

  const redactorSecrets = [
    ...Object.values(spec.env),
    ...(spec.stdin ? [spec.stdin] : []),
    ...resolvedSecretEnv.values(),
  ];

  const stdoutRedactor = new StreamingTaskRedactor(redactorSecrets);
  const stderrRedactor = new StreamingTaskRedactor(redactorSecrets);

  let binarySink: PreparedBinarySink | undefined;
  let stdoutFd = -1;
  let stderrFd = -1;
  try {
    const sinkSpec = spec.binaryStdoutSinks?.[0];
    if (sinkSpec) binarySink = prepareBinarySink(sinkSpec, spec.artifactRoots ?? []);
    if (spec.windowsSigningCleanup) {
      assertAuthorizedArtifactTarget(spec.windowsSigningCleanup.outFile, spec.artifactRoots ?? []);
      assertAuthorizedArtifactTarget(spec.windowsSigningCleanup.stagingPath, spec.artifactRoots ?? []);
      try {
        fs.lstatSync(spec.windowsSigningCleanup.stagingPath);
        throw new Error("signing staging already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    stdoutFd = fs.openSync(stdoutLogPath(taskDir), "a", 0o600);
    stderrFd = fs.openSync(stderrLogPath(taskDir), "a", 0o600);
  } catch {
    cleanupBinarySink(binarySink);
    if (stdoutFd >= 0) try { fs.closeSync(stdoutFd); } catch {}
    if (stderrFd >= 0) try { fs.closeSync(stderrFd); } catch {}
    redactorSecrets.fill("");
    resolvedSecretEnv.clear();
    fail(store, taskId, "artifact sink unavailable", "ARTIFACT_SINK_INVALID");
    return;
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...safeRuntimeEnvironment(),
    ...spec.env,
    ...Object.fromEntries(resolvedSecretEnv),
    [ARTIFACT_MANIFEST_ENV]: artifactManifestPath(taskDir),
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch {
    cleanupBinarySink(binarySink);
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    for (const envName of resolvedSecretEnv.keys()) delete childEnv[envName];
    resolvedSecretEnv.clear();
    redactorSecrets.fill("");
    fail(store, taskId, "process unavailable", "PROCESS_FAILED");
    return;
  }
  // spawn has synchronously copied the environment. Drop the extra references;
  // the redactors retain only what is required until stream finalization.
  for (const envName of resolvedSecretEnv.keys()) delete childEnv[envName];
  resolvedSecretEnv.clear();

  const nonce = token.slice(0, 16);
  const pid = child.pid ?? 0;
  let finalized = false;
  let cancelled = false;
  let timedOut = false;
  let termination: ProcessTreeTermination | undefined;
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });

  const heartbeat = () => writeHeartbeat(taskDir, { pid, nonce, heartbeatAt: new Date().toISOString() });
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, DEV_TASK_HEARTBEAT_MS);

  const cancelTimer = setInterval(() => {
    if (isCancelRequested(taskDir)) {
      cancelled = true;
      try { store.update(taskId, "running", { state: "cancel_requested" }); } catch {}
      requestTermination();
    }
  }, Math.max(250, Math.floor(DEV_TASK_HEARTBEAT_MS / 2)));

  const runtimeTimer = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, Math.min(DEV_TASK_MAX_RUNTIME_MS, spec.timeoutMs || DEV_TASK_MAX_RUNTIME_MS));

  child.stdout?.on("data", (chunk: Buffer) => {
    if (binarySink) {
      try {
        writeAll(binarySink.fd, chunk);
      } catch {
        binarySink.writeFailed = true;
        requestTermination();
      }
    } else {
      const redacted = stdoutRedactor.push(chunk.toString("utf8"));
      if (redacted) fs.writeSync(stdoutFd, redacted);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const redacted = stderrRedactor.push(chunk.toString("utf8"));
    if (redacted) fs.writeSync(stderrFd, redacted);
  });

  if (spec.stdin && child.stdin) {
    child.stdin.end(spec.stdin);
  }

  function requestTermination(): void {
    if (termination || !child.pid) return;
    termination = terminateProcessTree(child.pid, { graceMs: DEV_TASK_CANCEL_GRACE_MS });
  }

  function finalize(code: number | null): void {
    if (finalized) return;
    finalized = true;
    clearInterval(heartbeatTimer);
    clearInterval(cancelTimer);
    clearTimeout(runtimeTimer);
    termination?.cancel();
    const tailOut = binarySink ? "" : stdoutRedactor.flush();
    if (tailOut) fs.writeSync(stdoutFd, tailOut);
    const tailErr = stderrRedactor.flush();
    if (tailErr) fs.writeSync(stderrFd, tailErr);
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    redactorSecrets.fill("");
    const endedAt = new Date().toISOString();
    let success = !cancelled && !timedOut && !binarySink?.writeFailed &&
      (code !== null && spec.successExitCodes.includes(code));
    let sinkArtifact;
    if (binarySink) {
      try { fs.closeSync(binarySink.fd); } catch {}
      if (success) {
        try {
          assertAuthorizedArtifactTarget(binarySink.spec.target, spec.artifactRoots ?? []);
          fs.renameSync(binarySink.stagingPath, binarySink.spec.target);
          sinkArtifact = inspectAuthorizedArtifact(
            {
              name: binarySink.spec.name,
              path: binarySink.spec.target,
              kind: binarySink.spec.kind,
            },
            spec.artifactRoots ?? [],
          );
          if (!sinkArtifact) success = false;
        } catch {
          success = false;
        }
      }
      try { fs.rmSync(binarySink.stagingPath, { force: true }); } catch {}
    }
    if (spec.windowsSigningCleanup) {
      const signing = spec.windowsSigningCleanup;
      if (success) {
        try {
          assertAuthorizedArtifactTarget(signing.outFile, spec.artifactRoots ?? []);
          assertAuthorizedArtifactTarget(signing.stagingPath, spec.artifactRoots ?? []);
          const stagingStat = fs.lstatSync(signing.stagingPath);
          if (!stagingStat.isFile() || stagingStat.isSymbolicLink()) throw new Error("invalid signing staging");
          fs.renameSync(signing.stagingPath, signing.outFile);
        } catch {
          success = false;
        }
      }
      try { fs.rmSync(signing.stagingPath, { force: true }); } catch {}
    }
    const artifacts = cancelled
      ? []
      : collectDevelopmentArtifacts(taskDir!, spec.artifactRoots ?? []);
    if (success) {
      for (const entry of spec.directArtifacts ?? []) {
        const artifact = inspectAuthorizedArtifact(entry, spec.artifactRoots ?? []);
        if (artifact && !artifacts.some((existing) => existing.name === artifact.name)) artifacts.push(artifact);
      }
    }
    if (success && sinkArtifact && !artifacts.some((artifact) => artifact.name === sinkArtifact.name)) {
      artifacts.push(sinkArtifact);
    }
    try {
      const expected = cancelled ? "cancel_requested" : "running";
      store.update(taskId, expected, {
        state: cancelled ? "cancelled" : success ? "succeeded" : "failed",
        endedAt,
        artifacts,
        exit: {
          code,
          errorCode: cancelled
            ? "TASK_CANCELLED"
            : timedOut
              ? "PROCESS_TIMEOUT"
              : success
                ? undefined
                : "PROCESS_FAILED",
        },
      });
    } catch {
      // already terminal
    }
    // heartbeat file is kept for recovery inspection; not sensitive.
    void heartbeatPath;
    complete();
  }

  child.on("exit", (code, signal) => {
    finalize(code ?? (signal ? null : 0));
  });
  child.on("error", (error) => {
    try { fs.writeSync(stderrFd, `[worker] child error: ${error.message}\n`); } catch {}
    finalize(null);
  });
  await completion;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedAsScript) {
  void runWorker().catch((error) => {
    // Last-resort: ensure the process exits nonzero so the coordinator's
    // recovery sees an interrupted task rather than a hung one.
    void error;
    process.exit(3);
  });
}
