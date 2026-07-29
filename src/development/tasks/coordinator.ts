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
} from "../../config.js";
import { DevelopmentTaskStore } from "./store.js";
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

const STALE_HEARTBEAT_MS = DEV_TASK_HEARTBEAT_MS * 3;

export interface DevelopmentCoordinatorOptions {
  workerScript?: string;
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
  private readonly adopted = new Set<string>();

  constructor(
    store: DevelopmentTaskStore,
    scheduler: DevelopmentTaskScheduler,
    options: DevelopmentCoordinatorOptions = {},
  ) {
    this.store = store;
    this.scheduler = scheduler;
    this.workerScript = options.workerScript ?? path.resolve(process.cwd(), "dist/development/tasks/worker.js");
    this.recover();
  }

  enqueue(input: DevelopmentEnqueueInput): DevelopmentTaskRecord {
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
          ...process.env,
          FEISHU_MCP_TASK_DIR: this.store.taskDir(taskId),
          FEISHU_MCP_WORKER_TOKEN: token,
        },
        detached: true,
        stdio: "ignore",
      });
      try { child.unref(); } catch {}
      await this.waitForTerminal(taskId);
    });
  }

  private waitForTerminal(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        const record = this.store.get(taskId);
        if (!record || ["succeeded", "failed", "cancelled", "interrupted"].includes(record.state)) {
          resolve();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  private recover(): void {
    const records = this.store.list();
    const now = Date.now();
    for (const record of records) {
      if (record.state === "queued") {
        // Re-admit previously queued work.
        this.dispatch(record.id, record.class, record.resources).catch(() => {
          try { this.store.update(record.id, "queued", { state: "interrupted", endedAt: new Date().toISOString() }); } catch {}
        });
        continue;
      }
      if (record.state === "running" || record.state === "cancel_requested") {
        const beat = readHeartbeat(this.store.taskDir(record.id));
        const fresh = beat && now - Date.parse(beat.heartbeatAt) < STALE_HEARTBEAT_MS;
        if (fresh) {
          // Adopt: keep the record as-is and watch for its terminal state.
          this.adopted.add(record.id);
          this.waitForTerminal(record.id).catch(() => {});
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
}

export { developmentOwnerKey };
void heartbeatPath;
void defaultWorkerScript;
