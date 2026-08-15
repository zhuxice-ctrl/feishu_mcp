/**
 * StateStore — atomic checkpoint persistence for the Android workflow.
 *
 * Each run gets a single JSON checkpoint file under the configured directory.
 * Writes are atomic (temp file + rename in the same directory). Every
 * transition is validated against the contract topology before persistence.
 * Metadata values are redacted before storage so no secrets ever reach disk.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "StateStore 原子保存节点状态、Profile 版本、commit、设备和 APK 摘要。
 *  重复请求按 runId 从最近安全检查点恢复，终端状态不可再次执行副作用。"
 */

import fs from "node:fs/promises";
import path from "node:path";

import { validateTransition, WORKFLOW_STATES } from "./contracts.js";
import { redact } from "./redaction.js";

// ---------------------------------------------------------------------------
// Checkpoint shape
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly runId: string;
  readonly state: string;
  readonly profileVersion: number;
  readonly profileId?: string;
  readonly nodeId?: string;
  readonly previousState?: string;
  readonly timestamp: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** On-disk record (metadata already redacted). */
interface StoredCheckpoint {
  readonly runId: string;
  readonly state: string;
  readonly profileVersion: number;
  readonly profileId?: string;
  readonly nodeId?: string;
  readonly previousState?: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Persist a checkpoint atomically.
   *
   * Validation before write:
   * - target state must be a known workflow state
   * - transition from the previous checkpoint (if any) must be legal
   * - all metadata values are redacted before touching disk
   *
   * On validation failure the existing checkpoint is left intact.
   */
  async save(checkpoint: Checkpoint): Promise<void> {
    if (!WORKFLOW_STATES.has(checkpoint.state)) {
      throw new Error(`unknown state: ${checkpoint.state}`);
    }

    // Load existing checkpoint to validate the transition
    const existing = await this.loadRaw(checkpoint.runId);
    const previousState = existing?.state;

    if (previousState !== undefined && previousState !== checkpoint.state) {
      validateTransition(previousState, checkpoint.state);
    }

    // Redact all metadata values before persistence
    const redactedMetadata: Record<string, string> = {};
    if (checkpoint.metadata) {
      for (const [key, value] of Object.entries(checkpoint.metadata)) {
        redactedMetadata[key] = redact(value);
      }
    }

    const record: StoredCheckpoint = {
      runId: checkpoint.runId,
      state: checkpoint.state,
      profileVersion: checkpoint.profileVersion,
      profileId: checkpoint.profileId,
      nodeId: checkpoint.nodeId,
      previousState: previousState ?? checkpoint.previousState,
      timestamp: new Date().toISOString(),
      metadata: Object.keys(redactedMetadata).length > 0 ? redactedMetadata : undefined,
    };

    await fs.mkdir(this.dir, { recursive: true });

    // Atomic write: temp file in the same directory, then rename
    const finalPath = this.filePath(checkpoint.runId);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
  }

  /**
   * Load the latest checkpoint for a runId, or `null` if none exists.
   */
  async load(runId: string): Promise<Checkpoint | null> {
    return this.loadRaw(runId);
  }

  /**
   * Remove the checkpoint for a runId after terminal cleanup completes.
   * No-op (does not throw) if the checkpoint does not exist.
   */
  async finish(runId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(runId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the on-disk path for a runId.
   * Sanitizes the runId to alphanumeric + dash + underscore to prevent
   * path traversal — every other character becomes `_`.
   */
  private filePath(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  /** Internal load returning the raw stored record. */
  private async loadRaw(runId: string): Promise<StoredCheckpoint | null> {
    try {
      const content = await fs.readFile(this.filePath(runId), "utf-8");
      return JSON.parse(content) as StoredCheckpoint;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
