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
  DevelopmentArtifact,
  DevelopmentLaunchSpec,
  DevelopmentTaskCreateInput,
  DevelopmentTaskRecord,
  DevelopmentTaskState,
  DevelopmentTaskUpdatePatch,
} from "./types.js";
import { isSensitiveEnvEntry } from "./redaction.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATES: readonly DevelopmentTaskState[] = [
  "queued", "running", "succeeded", "failed",
  "cancel_requested", "cancelled", "interrupted",
];
const VALID_CLASSES = new Set(["default", "build", "privileged"]);

const MAX_STDIN_BYTES = 4096;

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
    if (!spec.executable) throw new DevelopmentTaskStoreError("executable is required");
    if (!Array.isArray(spec.args)) throw new DevelopmentTaskStoreError("args must be an array");
    if (!spec.cwd) throw new DevelopmentTaskStoreError("cwd is required");
    if (!Array.isArray(spec.successExitCodes)) {
      throw new DevelopmentTaskStoreError("successExitCodes must be an array");
    }
    if (spec.stdin && Buffer.byteLength(spec.stdin, "utf8") > MAX_STDIN_BYTES) {
      throw new DevelopmentTaskStoreError(`stdin exceeds ${MAX_STDIN_BYTES} bytes`);
    }
    for (const [name, value] of Object.entries(spec.env)) {
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
        fs.writeFileSync(fd, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
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
      return JSON.parse(fs.readFileSync(file, "utf8")) as DevelopmentLaunchSpec;
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
