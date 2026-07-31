/**
 * Development task coordinator.
 *
 * Owns the task store and the resource scheduler. Internal adapters call
 * `enqueueInternal` to persist a queued record plus its launch spec, admit it
 * through the scheduler, and spawn a detached worker when capacity frees up.
 * MCP tool callers never reach this surface directly.
 *
 * On construction the coordinator reconciles existing task records: running
 * work with a fresh heartbeat is adopted, stale work is marked interrupted,
 * and previously queued work is re-admitted. The coordinator never
 * force-kills a PID it did not spawn itself.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import {
  DEV_TASK_HEARTBEAT_MS,
  DEV_TASK_CANCEL_GRACE_MS,
  DEV_TASK_MAX_RUNTIME_MS,
  DEV_TASK_MAX_TOTAL_BYTES,
  DEV_TASK_RETENTION_DAYS,
} from "../../config.js";
import {
  DevelopmentTaskStore,
  cleanupDevelopmentTasks,
  type DevelopmentRetentionResult,
} from "./store.js";
import {
  DevelopmentTaskScheduler,
} from "./scheduler.js";
import type {
  DevelopmentLaunchSpec,
  DevelopmentTaskClass,
  DevelopmentTaskCreateInput,
  DevelopmentTaskRecord,
} from "./types.js";
import {
  developmentOwnerKey,
} from "./ownerKey.js";
import {
  heartbeatPath,
  issueWorkerToken,
  readHeartbeat,
  requestCancel,
} from "./workerProtocol.js";
import { safeRuntimeEnvironment } from "./runtimeEnvironment.js";

const STALE_HEARTBEAT_MS = DEV_TASK_HEARTBEAT_MS * 3;
const OWNER_KEY_RE = /^[0-9a-f]{64}$/;

export interface DevelopmentCoordinatorOptions {
  workerScript?: string;
  /** Test hook; production uses three configured heartbeat intervals. */
  heartbeatStaleMs?: number;
  /** Test hook; production allows slow Windows worker bootstrap. */
  startupGraceMs?: number;
  /** Test hook for deterministic heartbeat-loss checks. */
  pollIntervalMs?: number;
}

export interface DevelopmentEnqueueInput extends DevelopmentTaskCreateInput {
  launch: DevelopmentLaunchSpec;
  secretValues?: string[];
}

function defaultWorkerScript(): string {
  return path.resolve(process.cwd(), "dist/development/tasks/worker.js");
}

export class DevelopmentTaskCoordinator {
  readonly store: DevelopmentTaskStore;
  readonly scheduler: DevelopmentTaskScheduler;
  private readonly workerScript: string;
  private readonly heartbeatStaleMs: number;
  private readonly startupGraceMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    store: DevelopmentTaskStore,
    scheduler: DevelopmentTaskScheduler,
    options: DevelopmentCoordinatorOptions = {},
  ) {
    this.store = store;
    this.scheduler = scheduler;
    this.workerScript = options.workerScript ?? path.resolve(process.cwd(), "dist/development/tasks/worker.js");
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? STALE_HEARTBEAT_MS;
    this.startupGraceMs = options.startupGraceMs ?? Math.max(this.heartbeatStaleMs, 5_000);
    this.pollIntervalMs = options.pollIntervalMs ?? Math.min(250, DEV_TASK_HEARTBEAT_MS);
    this.recover();
  }

  enqueue(input: DevelopmentEnqueueInput): DevelopmentTaskRecord {
    if (!OWNER_KEY_RE.test(input.ownerKey)) {
      throw new Error("invalid development task owner key");
    }
    const record = this.store.create({
      ownerKey: input.ownerKey,
      tool: input.tool,
      action: input.action,
      class: input.class,
      resources: input.resources,
    });
    this.store.saveLaunchSpec(record.id, input.launch, input.secretValues ?? []);
    this.dispatch(record.id, input.class, input.resources).catch(() => {
      // If admission is cancelled or fails, ensure the record reflects it.
      const current = this.store.get(record.id);
      if (current && (current.state === "queued" || current.state === "running")) {
        try { this.store.update(record.id, current.state, { state: "interrupted", endedAt: new Date().toISOString() }); } catch {}
      }
    });
    return record;
  }

  cancel(
    taskId: string,
    ownerKey: string,
  ): { alreadyTerminal: boolean } | { cancelled: true } | { denied: true } {
    const record = this.store.get(taskId);
    if (!record) throw new Error(`task not found: ${taskId}`);
    if (record.ownerKey !== ownerKey) return { denied: true };
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(record.state)) {
      return { alreadyTerminal: true };
    }
    if (record.state === "queued") {
      if (this.scheduler.cancel(taskId)) {
        try { this.store.update(taskId, "queued", { state: "cancelled", endedAt: new Date().toISOString(), exit: { code: null, errorCode: "TASK_CANCELLED" } }); } catch {}
        return { cancelled: true };
      }
      // Not in scheduler (maybe adopted running) — fall through to running path.
    }
    // running or cancel_requested
    try { this.store.update(taskId, record.state, { state: "cancel_requested" }); } catch {}
    requestCancel(this.store.taskDir(taskId));
    return { cancelled: true };
  }

  private async dispatch(
    taskId: string,
    taskClass: DevelopmentTaskClass,
    resources: string[],
  ): Promise<void> {
    await this.scheduler.run(taskId, taskClass, resources, async () => {
      const token = issueWorkerToken(this.store.taskDir(taskId));
      const nonce = token.slice(0, 16);
      const startedAt = new Date().toISOString();
      try {
        this.store.update(taskId, "queued", {
          state: "running",
          stage: "spawn",
          startedAt,
          worker: { pid: 0, nonce, heartbeatAt: startedAt },
        });
      } catch {
        // already moved on (e.g. cancelled before start)
      }
      const child = spawn(process.execPath, [this.workerScript], {
        cwd: process.cwd(),
        env: {
          ...safeRuntimeEnvironment(),
          AUTH_MODE: "none",
          APPROVAL_DATA_DIR: path.dirname(this.store.root),
          DEV_TASK_DATA_DIR: this.store.root,
          DEV_TASK_HEARTBEAT_MS: String(DEV_TASK_HEARTBEAT_MS),
          DEV_TASK_CANCEL_GRACE_MS: String(DEV_TASK_CANCEL_GRACE_MS),
          DEV_TASK_MAX_RUNTIME_MS: String(DEV_TASK_MAX_RUNTIME_MS),
          FEISHU_MCP_TASK_DIR: this.store.taskDir(taskId),
          FEISHU_MCP_WORKER_TOKEN: token,
        },
        detached: true,
        stdio: "ignore",
      });
      if (child.pid) {
        const current = this.store.get(taskId);
        if (current?.state === "running") {
          try {
            this.store.update(taskId, "running", {
              worker: { pid: child.pid, nonce, heartbeatAt: startedAt },
            });
          } catch {}
        }
      }
      try { child.unref(); } catch {}
      await this.waitForTerminal(
        taskId,
        () => child.exitCode === null && child.signalCode === null,
      );
    });
  }

  private waitForTerminal(
    taskId: string,
    spawnedWorkerIsAlive?: () => boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      const initial = this.store.get(taskId);
      let lastFreshAt = Date.parse(initial?.startedAt ?? initial?.updatedAt ?? "");
      if (!Number.isFinite(lastFreshAt)) lastFreshAt = Date.now();
      let observedHeartbeat = false;
      const poll = () => {
        const record = this.store.get(taskId);
        if (!record || ["succeeded", "failed", "cancelled", "interrupted"].includes(record.state)) {
          resolve();
          return;
        }
        const now = Date.now();
        const beat = readHeartbeat(this.store.taskDir(taskId));
        const beatAt = beat ? Date.parse(beat.heartbeatAt) : Number.NaN;
        const validBeat = Boolean(
          beat &&
          Number.isInteger(beat.pid) && beat.pid > 0 &&
          record.worker?.nonce && beat.nonce === record.worker.nonce &&
          Number.isFinite(beatAt) && beatAt <= now + this.heartbeatStaleMs &&
          now - beatAt < this.heartbeatStaleMs
        );
        if (validBeat && beat) {
          observedHeartbeat = true;
          lastFreshAt = Math.max(lastFreshAt, beatAt);
          // The heartbeat file is the authoritative liveness record. Rewriting
          // metadata for every beat creates an inter-process lost-update race:
          // the coordinator can overwrite the worker's terminal state with a
          // stale running snapshot. The spawn record already persists the pid
          // and nonce needed for recovery, so no metadata write is necessary.
        } else if (
          // A freshly spawned Node worker may be alive but not yet scheduled
          // under full-suite/host load. The direct ChildProcess handle is
          // stronger startup evidence than an arbitrary grace interval. Once
          // the first heartbeat arrives, normal heartbeat expiry applies.
          !(!observedHeartbeat && spawnedWorkerIsAlive?.()) &&
          now - lastFreshAt >= (observedHeartbeat ? this.heartbeatStaleMs : this.startupGraceMs)
        ) {
          try {
            this.store.update(taskId, record.state, {
              state: "interrupted",
              endedAt: new Date(now).toISOString(),
              exit: {
                code: null,
                errorCode: "TASK_INTERRUPTED",
                message: "worker heartbeat lost",
              },
            });
          } catch {}
          resolve();
          return;
        }
        setTimeout(poll, this.pollIntervalMs).unref();
      };
      poll();
    });
  }

  private recover(): void {
    const records = this.store.list();
    const now = Date.now();
    for (const record of records) {
      if (
        ["queued", "running", "cancel_requested"].includes(record.state) &&
        !OWNER_KEY_RE.test(record.ownerKey)
      ) {
        try {
          this.store.update(record.id, record.state, {
            state: "interrupted",
            endedAt: new Date().toISOString(),
            exit: { code: null, errorCode: "TASK_INTERRUPTED", message: "invalid recovered owner key" },
          });
        } catch {}
        continue;
      }
      if (record.state === "queued") {
        try {
          if (!this.store.loadLaunchSpec(record.id)) throw new Error("launch spec missing");
        } catch {
          try {
            this.store.update(record.id, "queued", {
              state: "interrupted",
              endedAt: new Date().toISOString(),
              exit: { code: null, errorCode: "TASK_INTERRUPTED", message: "invalid recovered launch spec" },
            });
          } catch {}
          continue;
        }
        // Re-admit previously queued work.
        this.dispatch(record.id, record.class, record.resources).catch(() => {
          try { this.store.update(record.id, "queued", { state: "interrupted", endedAt: new Date().toISOString() }); } catch {}
        });
        continue;
      }
      if (record.state === "running" || record.state === "cancel_requested") {
        const beat = readHeartbeat(this.store.taskDir(record.id));
        const beatAt = beat ? Date.parse(beat.heartbeatAt) : Number.NaN;
        const fresh = Boolean(
          beat &&
          Number.isInteger(beat.pid) && beat.pid > 0 &&
          record.worker?.nonce && beat.nonce === record.worker.nonce &&
          Number.isFinite(beatAt) && beatAt <= now + this.heartbeatStaleMs &&
          now - beatAt < this.heartbeatStaleMs
        );
        if (fresh) {
          // Adopt the already-running worker and restore every scheduler
          // counter/resource lock until its persisted state becomes terminal.
          this.scheduler.adopt(
            record.id,
            record.class,
            record.resources,
            () => this.waitForTerminal(record.id),
          );
        } else {
          try {
            this.store.update(record.id, record.state, {
              state: "interrupted",
              endedAt: new Date().toISOString(),
              exit: { code: null, errorCode: "TASK_INTERRUPTED", message: "stale heartbeat on recovery" },
            });
          } catch {}
        }
      }
    }
  }

  summary(): {
    active: number;
    queued: number;
    totalLimit: number;
    buildLimit: number;
  } {
    return this.scheduler.summary();
  }

  /**
   * Aggregate health view for the /health endpoint: counts and configured
   * limits only — never task IDs, owner keys, resources, or worker data.
   */
  healthSummary(): {
    queued: number;
    running: number;
    terminal: number;
    totalLimit: number;
    buildLimit: number;
  } {
    const scheduler = this.scheduler.summary();
    const terminal = this.store.list().filter((record) =>
      ["succeeded", "failed", "cancelled", "interrupted"].includes(record.state)
    ).length;
    return {
      queued: scheduler.queued,
      running: scheduler.active,
      terminal,
      totalLimit: scheduler.totalLimit,
      buildLimit: scheduler.buildLimit,
    };
  }

  /** Run one retention pass; returns aggregate counts only. */
  cleanup(options: { now?: number } = {}): DevelopmentRetentionResult {
    return cleanupDevelopmentTasks(this.store, {
      retentionDays: DEV_TASK_RETENTION_DAYS,
      maxTotalBytes: DEV_TASK_MAX_TOTAL_BYTES,
      now: options.now,
    });
  }
}

export { developmentOwnerKey };
void heartbeatPath;
void defaultWorkerScript;
