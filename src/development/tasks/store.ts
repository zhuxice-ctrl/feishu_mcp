/**
 * Atomic development-task metadata store.
 *
 * Each task lives in its own directory under the protected approval data
 * directory. Metadata is written atomically (exclusive temp file, fsync,
 * rename) with mode 0600. Corrupt metadata is quarantined rather than
 * silently treated as a successful terminal task. Every state transition
 * requires the expected current state to prevent lost updates.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DevelopmentBinaryStdoutSink,
  DevelopmentDirectArtifact,
  DevelopmentWindowsSigningCleanup,
  DevelopmentArtifact,
  DevelopmentDirectorySummary,
  DevelopmentLaunchSpec,
  DevelopmentTaskCreateInput,
  DevelopmentTaskKind,
  DevelopmentTaskRecord,
  DevelopmentTaskState,
  DevelopmentTaskStepResult,
  DevelopmentTaskUpdatePatch,
  DevelopmentWorkflowLaunchSpec,
  DevelopmentWorkflowStep,
  DevelopmentStepState,
} from "./types.js";
import { isSensitiveEnvEntry } from "./redaction.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_ID_RE = /^[a-z0-9_-]{1,64}$/;
const VALID_STATES: readonly DevelopmentTaskState[] = [
  "queued", "running", "succeeded", "failed",
  "cancel_requested", "cancelled", "interrupted",
];
const VALID_CLASSES = new Set(["default", "build", "privileged"]);
const VALID_KINDS = new Set<DevelopmentTaskKind>(["command", "workflow"]);
const VALID_STEP_STATES: readonly DevelopmentStepState[] = [
  "pending", "running", "succeeded", "failed", "skipped", "cancelled",
];
const VALID_STEP_KINDS = new Set(["typecheck", "lint", "test_selected", "build"]);

const MAX_STDIN_BYTES = 4096;
const MAX_LAUNCH_BYTES = 1_048_576;
const MAX_WORKFLOW_BYTES = 1_048_576;
const MAX_ARGUMENTS = 1024;
const MAX_WORKFLOW_STEPS = 8;
const BINARY_SINK_KEYS = new Set(["stream", "type", "target", "name", "kind"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringRecord(value: unknown, field: string, maxEntries: number): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maxEntries) {
    throw new DevelopmentTaskStoreError(`invalid launch ${field}`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 32_768) {
      throw new DevelopmentTaskStoreError(`invalid launch ${field}`);
    }
    result[key] = entry;
  }
  return result;
}

function validateBinaryStdoutSinks(value: unknown): DevelopmentBinaryStdoutSink[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new DevelopmentTaskStoreError("invalid launch binaryStdoutSinks");
  }
  const sink = value[0];
  if (
    !isRecord(sink) ||
    Object.keys(sink).length !== BINARY_SINK_KEYS.size ||
    Object.keys(sink).some((key) => !BINARY_SINK_KEYS.has(key)) ||
    sink.stream !== "stdout" ||
    sink.type !== "png" ||
    sink.kind !== "screenshot" ||
    typeof sink.target !== "string" ||
    !path.isAbsolute(sink.target) ||
    Buffer.byteLength(sink.target, "utf8") > 4096 ||
    typeof sink.name !== "string" ||
    sink.name.length === 0 ||
    Buffer.byteLength(sink.name, "utf8") > 255 ||
    /[\\/\0]/.test(sink.name) ||
    sink.name !== path.basename(sink.target)
  ) {
    throw new DevelopmentTaskStoreError("invalid launch binaryStdoutSinks");
  }
  return [{
    stream: "stdout",
    type: "png",
    target: sink.target,
    name: sink.name,
    kind: "screenshot",
  }];
}

function validateDirectArtifacts(value: unknown): DevelopmentDirectArtifact[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new DevelopmentTaskStoreError("invalid launch directArtifacts");
  }
  const artifact = value[0];
  if (
    !isRecord(artifact) || Object.keys(artifact).length !== 3 ||
    !["name", "path", "kind"].every((key) => key in artifact) ||
    artifact.kind !== "windows-signed" ||
    typeof artifact.path !== "string" || !path.isAbsolute(artifact.path) ||
    Buffer.byteLength(artifact.path, "utf8") > 4096 ||
    typeof artifact.name !== "string" || artifact.name.length === 0 ||
    Buffer.byteLength(artifact.name, "utf8") > 255 || /[\\/\0]/.test(artifact.name) ||
    artifact.name !== path.basename(artifact.path)
  ) {
    throw new DevelopmentTaskStoreError("invalid launch directArtifacts");
  }
  return [{ name: artifact.name, path: artifact.path, kind: "windows-signed" }];
}

function validateWindowsSigningCleanup(value: unknown): DevelopmentWindowsSigningCleanup {
  if (
    !isRecord(value) || Object.keys(value).length !== 2 ||
    typeof value.stagingPath !== "string" || !path.isAbsolute(value.stagingPath) ||
    typeof value.outFile !== "string" || !path.isAbsolute(value.outFile) ||
    path.dirname(value.stagingPath) !== path.dirname(value.outFile) ||
    value.stagingPath === value.outFile ||
    !path.basename(value.stagingPath).startsWith(`.${path.basename(value.outFile, path.extname(value.outFile))}.`)
  ) {
    throw new DevelopmentTaskStoreError("invalid launch windowsSigningCleanup");
  }
  return { stagingPath: value.stagingPath, outFile: value.outFile };
}

function validateLaunchSpec(value: unknown): DevelopmentLaunchSpec {
  if (!isRecord(value)) throw new DevelopmentTaskStoreError("invalid launch spec");
  if (typeof value.executable !== "string" || !path.isAbsolute(value.executable)) {
    throw new DevelopmentTaskStoreError("launch executable must be an absolute path");
  }
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) {
    throw new DevelopmentTaskStoreError("launch cwd must be an absolute path");
  }
  if (
    !Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS ||
    value.args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 32_768)
  ) {
    throw new DevelopmentTaskStoreError("invalid launch args");
  }
  const env = stringRecord(value.env, "env", 256);
  const secretEnvRefs = value.secretEnvRefs === undefined
    ? undefined
    : stringRecord(value.secretEnvRefs, "secretEnvRefs", 64);
  if (secretEnvRefs !== undefined) {
    for (const [envName, credentialId] of Object.entries(secretEnvRefs)) {
      if (!ENV_NAME_RE.test(envName) || !CREDENTIAL_ID_RE.test(credentialId)) {
        throw new DevelopmentTaskStoreError("invalid launch secretEnvRefs");
      }
    }
  }
  if (
    value.stdin !== undefined &&
    (typeof value.stdin !== "string" || Buffer.byteLength(value.stdin, "utf8") > MAX_STDIN_BYTES)
  ) {
    throw new DevelopmentTaskStoreError(`stdin exceeds ${MAX_STDIN_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0 || (value.timeoutMs as number) > 86_400_000) {
    throw new DevelopmentTaskStoreError("invalid launch timeoutMs");
  }
  if (
    !Array.isArray(value.successExitCodes) || value.successExitCodes.length === 0 ||
    value.successExitCodes.length > 256 ||
    value.successExitCodes.some((code) => !Number.isSafeInteger(code))
  ) {
    throw new DevelopmentTaskStoreError("invalid launch successExitCodes");
  }
  let artifactRoots: string[] | undefined;
  if (value.artifactRoots !== undefined) {
    if (
      !Array.isArray(value.artifactRoots) || value.artifactRoots.length > 64 ||
      value.artifactRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))
    ) {
      throw new DevelopmentTaskStoreError("artifactRoots must contain absolute paths");
    }
    artifactRoots = [...new Set(value.artifactRoots as string[])];
  }
  const binaryStdoutSinks = value.binaryStdoutSinks === undefined
    ? undefined
    : validateBinaryStdoutSinks(value.binaryStdoutSinks);
  const directArtifacts = value.directArtifacts === undefined
    ? undefined
    : validateDirectArtifacts(value.directArtifacts);
  const windowsSigningCleanup = value.windowsSigningCleanup === undefined
    ? undefined
    : validateWindowsSigningCleanup(value.windowsSigningCleanup);
  if (windowsSigningCleanup && !directArtifacts?.some((entry) => entry.path === windowsSigningCleanup.outFile)) {
    throw new DevelopmentTaskStoreError("invalid launch windowsSigningCleanup");
  }
  return {
    executable: value.executable,
    args: [...value.args] as string[],
    cwd: value.cwd,
    env,
    ...(secretEnvRefs === undefined ? {} : { secretEnvRefs }),
    ...(value.stdin === undefined ? {} : { stdin: value.stdin as string }),
    timeoutMs: value.timeoutMs as number,
    successExitCodes: [...value.successExitCodes] as number[],
    ...(artifactRoots === undefined ? {} : { artifactRoots }),
    ...(binaryStdoutSinks === undefined ? {} : { binaryStdoutSinks }),
    ...(directArtifacts === undefined ? {} : { directArtifacts }),
    ...(windowsSigningCleanup === undefined ? {} : { windowsSigningCleanup }),
  };
}

function validateWorkflowStep(value: unknown, index: number): DevelopmentWorkflowStep {
  if (!isRecord(value)) {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index}`);
  }
  if (typeof value.id !== "string" || !STEP_ID_RE.test(value.id)) {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index} id`);
  }
  if (typeof value.kind !== "string" || !VALID_STEP_KINDS.has(value.kind)) {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index} kind`);
  }
  if (typeof value.executable !== "string" || !path.isAbsolute(value.executable)) {
    throw new DevelopmentTaskStoreError(`workflow step ${index} executable must be an absolute path`);
  }
  if (
    !Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS ||
    value.args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 32_768)
  ) {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index} args`);
  }
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0 || (value.timeoutMs as number) > 86_400_000) {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index} timeoutMs`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new DevelopmentTaskStoreError(`invalid workflow step ${index} enabled`);
  }
  return {
    id: value.id,
    kind: value.kind as DevelopmentWorkflowStep["kind"],
    executable: value.executable,
    args: [...value.args] as string[],
    timeoutMs: value.timeoutMs as number,
    enabled: value.enabled,
  };
}

function validateWorkflowSpec(value: unknown): DevelopmentWorkflowLaunchSpec {
  if (!isRecord(value)) throw new DevelopmentTaskStoreError("invalid workflow spec");
  if (typeof value.workspaceId !== "string" || !STEP_ID_RE.test(value.workspaceId)) {
    throw new DevelopmentTaskStoreError("invalid workflow workspaceId");
  }
  if (typeof value.recipeId !== "string" || !STEP_ID_RE.test(value.recipeId)) {
    throw new DevelopmentTaskStoreError("invalid workflow recipeId");
  }
  if (typeof value.recipeDigest !== "string" || value.recipeDigest.length !== 64) {
    throw new DevelopmentTaskStoreError("invalid workflow recipeDigest");
  }
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) {
    throw new DevelopmentTaskStoreError("workflow cwd must be an absolute path");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_WORKFLOW_STEPS) {
    throw new DevelopmentTaskStoreError(`workflow must have 1-${MAX_WORKFLOW_STEPS} steps`);
  }
  const steps = value.steps.map((step, i) => validateWorkflowStep(step, i));
  // Reject duplicate step IDs.
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw new DevelopmentTaskStoreError(`duplicate workflow step id: ${step.id}`);
    }
    stepIds.add(step.id);
  }
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0 || (value.timeoutMs as number) > 86_400_000) {
    throw new DevelopmentTaskStoreError("invalid workflow timeoutMs");
  }
  let artifactDirs: string[] | undefined;
  if (value.artifactDirs !== undefined) {
    if (
      !Array.isArray(value.artifactDirs) || value.artifactDirs.length > 16 ||
      value.artifactDirs.some((dir) => typeof dir !== "string" || !path.isAbsolute(dir))
    ) {
      throw new DevelopmentTaskStoreError("workflow artifactDirs must contain absolute paths");
    }
    artifactDirs = [...value.artifactDirs as string[]];
  }
  return {
    workspaceId: value.workspaceId,
    recipeId: value.recipeId,
    recipeDigest: value.recipeDigest,
    cwd: value.cwd,
    steps,
    timeoutMs: value.timeoutMs as number,
    ...(artifactDirs === undefined ? {} : { artifactDirs }),
  };
}

function validateStepResults(value: unknown): DevelopmentTaskStepResult[] {
  if (!Array.isArray(value) || value.length > MAX_WORKFLOW_STEPS) {
    throw new DevelopmentTaskStoreError("invalid step results");
  }
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new DevelopmentTaskStoreError(`invalid step result ${i}`);
    if (typeof entry.id !== "string" || !STEP_ID_RE.test(entry.id)) {
      throw new DevelopmentTaskStoreError(`invalid step result ${i} id`);
    }
    if (typeof entry.kind !== "string" || !VALID_STEP_KINDS.has(entry.kind)) {
      throw new DevelopmentTaskStoreError(`invalid step result ${i} kind`);
    }
    if (typeof entry.state !== "string" || !VALID_STEP_STATES.includes(entry.state as DevelopmentStepState)) {
      throw new DevelopmentTaskStoreError(`invalid step result ${i} state`);
    }
    if (entry.exitCode !== null && !Number.isSafeInteger(entry.exitCode)) {
      throw new DevelopmentTaskStoreError(`invalid step result ${i} exitCode`);
    }
    const result: DevelopmentTaskStepResult = {
      id: entry.id,
      kind: entry.kind as DevelopmentTaskStepResult["kind"],
      state: entry.state as DevelopmentStepState,
      exitCode: entry.exitCode === null ? null : entry.exitCode as number,
    };
    if (typeof entry.startedAt === "string") result.startedAt = entry.startedAt;
    if (typeof entry.endedAt === "string") result.endedAt = entry.endedAt;
    if (typeof entry.durationMs === "number" && Number.isSafeInteger(entry.durationMs)) {
      result.durationMs = entry.durationMs;
    }
    return result;
  });
}

function validateDirectorySummaries(value: unknown): DevelopmentDirectorySummary[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new DevelopmentTaskStoreError("invalid directory summaries");
  }
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new DevelopmentTaskStoreError(`invalid directory summary ${i}`);
    if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 255) {
      throw new DevelopmentTaskStoreError(`invalid directory summary ${i} id`);
    }
    if (entry.kind !== "directory-summary") {
      throw new DevelopmentTaskStoreError(`invalid directory summary ${i} kind`);
    }
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
      throw new DevelopmentTaskStoreError(`invalid directory summary ${i} path`);
    }
    const fileCount = entry.fileCount;
    if (typeof fileCount !== "number" || !Number.isSafeInteger(fileCount) || fileCount < 0) {
      throw new DevelopmentTaskStoreError(`invalid directory summary ${i} fileCount`);
    }
    const byteTotal = entry.byteTotal;
    if (typeof byteTotal !== "number" || !Number.isSafeInteger(byteTotal) || byteTotal < 0) {
      throw new DevelopmentTaskStoreError(`invalid directory summary ${i} byteTotal`);
    }
    return {
      id: entry.id,
      kind: "directory-summary" as const,
      path: entry.path,
      fileCount,
      byteTotal,
    };
  });
}

export class DevelopmentTaskStoreError extends Error {}

function validateTaskId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new DevelopmentTaskStoreError(`invalid task id: ${id}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function quarantine(id: string, file: string): void {
  const dest = path.join(path.dirname(file), `${id}.corrupt-${Date.now()}.json`);
  try {
    fs.renameSync(file, dest);
  } catch {
    // Best-effort; if rename fails leave the file in place rather than
    // treating it as valid.
  }
}

export class DevelopmentTaskStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  taskDir(id: string): string {
    return path.join(this.root, id);
  }

  metadataPath(id: string): string {
    return path.join(this.taskDir(id), "metadata.json");
  }

  launchPath(id: string): string {
    return path.join(this.taskDir(id), "launch.json");
  }

  workflowPath(id: string): string {
    return path.join(this.taskDir(id), "workflow.json");
  }

  create(input: DevelopmentTaskCreateInput): DevelopmentTaskRecord {
    if (!input.ownerKey) throw new DevelopmentTaskStoreError("ownerKey is required");
    if (!input.tool) throw new DevelopmentTaskStoreError("tool is required");
    if (!input.action) throw new DevelopmentTaskStoreError("action is required");
    if (!VALID_CLASSES.has(input.class)) {
      throw new DevelopmentTaskStoreError(`invalid task class: ${input.class}`);
    }
    const id = randomUUID();
    const dir = this.taskDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: DevelopmentTaskRecord = {
      version: 1,
      id,
      ownerKey: input.ownerKey,
      tool: input.tool,
      action: input.action,
      class: input.class,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      resources: [...new Set(input.resources)].sort((a, b) => a.localeCompare(b)),
      state: "queued",
      stage: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      artifacts: [],
    };
    this.persistMetadata(record);
    return record;
  }

  get(id: string): DevelopmentTaskRecord | undefined {
    validateTaskId(id);
    const file = this.metadataPath(id);
    return this.readMetadata(id, file);
  }

  /**
   * Compare-and-set transition. The current persisted state must equal
   * `expectedState` or the update is rejected.
   */
  update(
    id: string,
    expectedState: DevelopmentTaskState,
    patch: DevelopmentTaskUpdatePatch,
  ): DevelopmentTaskRecord {
    validateTaskId(id);
    const file = this.metadataPath(id);
    const current = this.readMetadata(id, file);
    if (!current) throw new DevelopmentTaskStoreError(`task not found: ${id}`);
    if (current.state !== expectedState) {
      throw new DevelopmentTaskStoreError(
        `state changed: expected ${expectedState}, found ${current.state}`,
      );
    }
    const next: DevelopmentTaskRecord = { ...current };
    if (patch.state !== undefined) {
      if (!VALID_STATES.includes(patch.state)) {
        throw new DevelopmentTaskStoreError(`invalid state: ${patch.state}`);
      }
      next.state = patch.state;
    }
    if (patch.stage !== undefined) next.stage = patch.stage;
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) next.endedAt = patch.endedAt;
    if (patch.worker !== undefined) next.worker = patch.worker;
    if (patch.exit !== undefined) next.exit = patch.exit;
    if (patch.artifacts !== undefined) next.artifacts = patch.artifacts;
    if (patch.steps !== undefined) {
      next.steps = validateStepResults(patch.steps);
    }
    if (patch.directorySummaries !== undefined) {
      next.directorySummaries = validateDirectorySummaries(patch.directorySummaries);
    }
    next.updatedAt = nowIso();
    this.persistMetadata(next);
    return next;
  }

  list(ownerKey?: string): DevelopmentTaskRecord[] {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && UUID_RE.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
    const records: DevelopmentTaskRecord[] = [];
    for (const id of entries) {
      const record = this.get(id);
      if (!record) continue;
      if (ownerKey !== undefined && record.ownerKey !== ownerKey) continue;
      records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Persist the launch spec to a separate mode-0600 file. Task-query tools
   * never read this file. Rejects sensitive env keys and configured secret
   * values before writing.
   */
  saveLaunchSpec(
    id: string,
    spec: DevelopmentLaunchSpec,
    secrets: readonly string[] = [],
  ): void {
    validateTaskId(id);
    if (!this.get(id)) throw new DevelopmentTaskStoreError(`task not found: ${id}`);
    const validated = validateLaunchSpec(spec);
    for (const [name, value] of Object.entries(validated.env)) {
      if (isSensitiveEnvEntry(name, value, secrets)) {
        throw new DevelopmentTaskStoreError(
          `refusing to persist sensitive env entry: ${name}`,
        );
      }
    }
    this.atomicWrite(this.launchPath(id), validated);
  }

  loadLaunchSpec(id: string): DevelopmentLaunchSpec | undefined {
    validateTaskId(id);
    return this.loadValidated<DevelopmentLaunchSpec>(
      this.launchPath(id), MAX_LAUNCH_BYTES, validateLaunchSpec,
    );
  }

  /**
   * Persist the workflow launch spec to a separate mode-0600 file. Like the
   * command launch spec, this file is never returned to MCP callers.
   */
  saveWorkflowSpec(id: string, spec: DevelopmentWorkflowLaunchSpec): void {
    validateTaskId(id);
    if (!this.get(id)) throw new DevelopmentTaskStoreError(`task not found: ${id}`);
    const validated = validateWorkflowSpec(spec);
    this.atomicWrite(this.workflowPath(id), validated);
  }

  loadWorkflowSpec(id: string): DevelopmentWorkflowLaunchSpec | undefined {
    validateTaskId(id);
    return this.loadValidated<DevelopmentWorkflowLaunchSpec>(
      this.workflowPath(id), MAX_WORKFLOW_BYTES, validateWorkflowSpec,
    );
  }

  /**
   * Load either launch spec type based on the task's kind field.
   * Returns undefined when neither file exists.
   */
  loadLaunchSpecForTask(id: string): DevelopmentLaunchSpec | DevelopmentWorkflowLaunchSpec | undefined {
    validateTaskId(id);
    const record = this.get(id);
    if (!record) return undefined;
    if (record.kind === "workflow") return this.loadWorkflowSpec(id);
    return this.loadLaunchSpec(id);
  }

  recordArtifact(id: string, artifact: DevelopmentArtifact): DevelopmentTaskRecord {
    validateTaskId(id);
    const file = this.metadataPath(id);
    const current = this.readMetadata(id, file);
    if (!current) throw new DevelopmentTaskStoreError(`task not found: ${id}`);
    const artifacts = [...current.artifacts.filter((a) => a.name !== artifact.name), artifact];
    return this.update(current.id, current.state, { artifacts });
  }

  /** IDs of every real task directory (exact UUID names; symlinks excluded). */
  listIds(): string[] {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && UUID_RE.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  /** Total bytes inside a task directory, never following symlinks. */
  directorySize(id: string): number {
    validateTaskId(id);
    let total = 0;
    const walk = (current: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += fs.lstatSync(full).size;
          } catch {
            // vanished mid-walk; ignore
          }
        }
      }
    };
    walk(this.taskDir(id));
    return total;
  }

  /**
   * Permanently delete a task directory. Only a real directory with an exact
   * UUID name directly under the store root is eligible — symlinks and any
   * other entries are refused, so project artifacts are never touched.
   */
  remove(id: string): void {
    validateTaskId(id);
    const dir = this.taskDir(id);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DevelopmentTaskStoreError(`refusing to remove non-directory task entry: ${id}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private readMetadata(id: string, file: string): DevelopmentTaskRecord | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantine(id, file);
      return undefined;
    }
    const record = parsed as Partial<DevelopmentTaskRecord>;
    if (
      !record ||
      record.version !== 1 ||
      typeof record.id !== "string" || record.id !== id ||
      typeof record.ownerKey !== "string" ||
      typeof record.tool !== "string" ||
      typeof record.action !== "string" ||
      typeof record.class !== "string" || !VALID_CLASSES.has(record.class) ||
      typeof record.state !== "string" || !VALID_STATES.includes(record.state as DevelopmentTaskState) ||
      typeof record.stage !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string" ||
      !Array.isArray(record.resources) ||
      !Array.isArray(record.artifacts)
    ) {
      quarantine(id, file);
      return undefined;
    }
    // Validate optional new fields if present.
    if (record.kind !== undefined) {
      if (typeof record.kind !== "string" || !VALID_KINDS.has(record.kind as DevelopmentTaskKind)) {
        quarantine(id, file);
        return undefined;
      }
    }
    if (record.steps !== undefined) {
      try { validateStepResults(record.steps); } catch { quarantine(id, file); return undefined; }
    }
    if (record.directorySummaries !== undefined) {
      try { validateDirectorySummaries(record.directorySummaries); } catch { quarantine(id, file); return undefined; }
    }
    return record as DevelopmentTaskRecord;
  }

  private persistMetadata(record: DevelopmentTaskRecord): void {
    this.atomicWrite(this.metadataPath(record.id), record);
  }

  private atomicWrite(targetPath: string, value: unknown): void {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.${path.basename(targetPath)}-${process.pid}-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, targetPath);
      try { fs.chmodSync(targetPath, 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  private loadValidated<T>(
    file: string,
    maxBytes: number,
    validator: (value: unknown) => T,
  ): T | undefined {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
        throw new DevelopmentTaskStoreError("invalid file");
      }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(file, flags);
      try {
        return validator(JSON.parse(fs.readFileSync(fd, "utf8")));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}


// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const TERMINAL_TASK_STATES: ReadonlySet<DevelopmentTaskState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface DevelopmentRetentionOptions {
  retentionDays: number;
  maxTotalBytes: number;
  now?: number;
}

/** Aggregate counts only — never task IDs, owner keys, or paths. */
export interface DevelopmentRetentionResult {
  removed: number;
  bytesFreed: number;
  remainingBytes: number;
}

/**
 * Delete terminal tasks past the retention age, then — if the store still
 * exceeds the byte cap — delete remaining terminal tasks oldest-first until
 * under the cap. Queued and running tasks are never deleted (their bytes do
 * count toward the cap). Only canonical task directories are removed.
 */
export function cleanupDevelopmentTasks(
  store: DevelopmentTaskStore,
  options: DevelopmentRetentionOptions,
): DevelopmentRetentionResult {
  const now = options.now ?? Date.now();
  const cutoff = now - options.retentionDays * 86_400_000;
  const terminal = store.list().filter((record) => TERMINAL_TASK_STATES.has(record.state));
  const endedAt = (record: DevelopmentTaskRecord): string => record.endedAt ?? record.updatedAt;

  let removed = 0;
  let bytesFreed = 0;
  const remaining = new Map(terminal.map((record) => [record.id, record]));

  for (const record of terminal) {
    const ended = Date.parse(endedAt(record));
    if (Number.isFinite(ended) && ended < cutoff) {
      const size = store.directorySize(record.id);
      store.remove(record.id);
      remaining.delete(record.id);
      removed += 1;
      bytesFreed += size;
    }
  }

  let total = 0;
  const sizes = new Map<string, number>();
  for (const id of store.listIds()) {
    const size = store.directorySize(id);
    sizes.set(id, size);
    total += size;
  }

  if (total > options.maxTotalBytes) {
    const deletable = [...remaining.values()]
      .sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
    for (const record of deletable) {
      if (total <= options.maxTotalBytes) break;
      const size = sizes.get(record.id) ?? store.directorySize(record.id);
      store.remove(record.id);
      removed += 1;
      bytesFreed += size;
      total -= size;
    }
  }

  return { removed, bytesFreed, remainingBytes: total };
}
