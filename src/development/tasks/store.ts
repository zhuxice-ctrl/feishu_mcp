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
  DevelopmentLaunchSpec,
  DevelopmentTaskCreateInput,
  DevelopmentTaskRecord,
  DevelopmentTaskState,
  DevelopmentTaskUpdatePatch,
} from "./types.js";
import { isSensitiveEnvEntry } from "./redaction.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_STATES: readonly DevelopmentTaskState[] = [
  "queued", "running", "succeeded", "failed",
  "cancel_requested", "cancelled", "interrupted",
];
const VALID_CLASSES = new Set(["default", "build", "privileged"]);

const MAX_STDIN_BYTES = 4096;
const MAX_LAUNCH_BYTES = 1_048_576;
const MAX_ARGUMENTS = 1024;
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
    const dir = this.taskDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.launch-${process.pid}-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.launchPath(id));
      try { fs.chmodSync(this.launchPath(id), 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  loadLaunchSpec(id: string): DevelopmentLaunchSpec | undefined {
    validateTaskId(id);
    const file = this.launchPath(id);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LAUNCH_BYTES) {
        throw new DevelopmentTaskStoreError("invalid launch file");
      }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(file, flags);
      try {
        return validateLaunchSpec(JSON.parse(fs.readFileSync(fd, "utf8")));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
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
    return record as DevelopmentTaskRecord;
  }

  private persistMetadata(record: DevelopmentTaskRecord): void {
    const dir = this.taskDir(record.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.metadata-${process.pid}-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.metadataPath(record.id));
      try { fs.chmodSync(this.metadataPath(record.id), 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
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
