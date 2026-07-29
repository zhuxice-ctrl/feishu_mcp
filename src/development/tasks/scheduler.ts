/**
 * Fixed-order resource scheduler for development tasks.
 *
 * Enforces a global concurrency cap, a separate build cap, and exclusive
 * serialized access to named resources (projects, devices). Waiters are kept
 * in a single FIFO list and admitted only when global/class capacity and
 * every requested resource are simultaneously free — a task never holds a
 * partial resource set. Queued work can be cancelled or time out; locks are
 * always released when a task settles, whether it succeeded or failed.
 */

export class DevelopmentTaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`development task cancelled while queued: ${taskId}`);
    this.name = "DevelopmentTaskCancelledError";
  }
}

export class DevelopmentTaskQueueTimeoutError extends Error {
  constructor(taskId: string) {
    super(`development task timed out waiting in queue: ${taskId}`);
    this.name = "DevelopmentTaskQueueTimeoutError";
  }
}

export interface DevelopmentSchedulerOptions {
  total: number;
  builds: number;
  queueTimeoutMs: number;
  privileged?: number;
}

interface Waiter<T> {
  taskId: string;
  taskClass: "default" | "build" | "privileged";
  resources: string[];
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ActiveRecord {
  taskId: string;
  taskClass: "default" | "build" | "privileged";
  resources: string[];
}

function normalize(resources: readonly string[]): string[] {
  return [...new Set(resources)].sort((a, b) => a.localeCompare(b));
}

export class DevelopmentTaskScheduler {
  private readonly options: Required<DevelopmentSchedulerOptions>;
  private readonly active = new Map<string, ActiveRecord>();
  private readonly heldResources = new Map<string, number>();
  private readonly waiters: Waiter<unknown>[] = [];
  private activeBuilds = 0;
  private activePrivileged = 0;

  constructor(options: DevelopmentSchedulerOptions) {
    this.options = {
      privileged: 1,
      ...options,
    };
  }

  summary(): {
    active: number;
    queued: number;
    totalLimit: number;
    buildLimit: number;
  } {
    return {
      active: this.active.size,
      queued: this.waiters.length,
      totalLimit: this.options.total,
      buildLimit: this.options.builds,
    };
  }

  run<T>(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const normalized = normalize(resources);
    return new Promise<T>((resolve, reject) => {
      if (this.active.has(taskId) || this.waiters.some((waiter) => waiter.taskId === taskId)) {
        reject(new Error(`development task is already scheduled: ${taskId}`));
        return;
      }
      const attempt = (): boolean => {
        if (this.canStart(taskClass, normalized)) {
          this.start(taskId, taskClass, normalized, fn, resolve, reject);
          return true;
        }
        return false;
      };
      if (!attempt()) {
        const timer =
          this.options.queueTimeoutMs > 0
            ? setTimeout(() => {
                const idx = this.waiters.findIndex((w) => w.taskId === taskId);
                if (idx !== -1) {
                  this.waiters.splice(idx, 1);
                  reject(new DevelopmentTaskQueueTimeoutError(taskId));
                  this.drain();
                }
              }, this.options.queueTimeoutMs)
            : null;
        this.waiters.push({
          taskId,
          taskClass,
          resources: normalized,
          fn,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
      }
    });
  }

  /**
   * Restore occupancy for a worker that survived a coordinator restart.
   * Adoption deliberately bypasses admission limits because the work is
   * already running; counting it prevents a restart from creating extra
   * capacity or releasing its project/device locks early.
   */
  adopt(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
    watch: () => Promise<unknown>,
  ): boolean {
    if (this.active.has(taskId) || this.waiters.some((waiter) => waiter.taskId === taskId)) {
      return false;
    }
    const normalized = normalize(resources);
    this.reserve(taskId, taskClass, normalized);
    void this.runAdopted(taskId, taskClass, normalized, watch);
    return true;
  }

  cancel(taskId: string): boolean {
    const idx = this.waiters.findIndex((w) => w.taskId === taskId);
    if (idx === -1) return false;
    const [waiter] = this.waiters.splice(idx, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(new DevelopmentTaskCancelledError(taskId));
    this.drain();
    return true;
  }

  private canStart(
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
  ): boolean {
    if (this.active.size >= this.options.total) return false;
    if (taskClass === "build" && this.activeBuilds >= this.options.builds) return false;
    if (taskClass === "privileged" && this.activePrivileged >= this.options.privileged) return false;
    return resources.every((r) => !this.heldResources.has(r));
  }

  private start<T>(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
    fn: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ): void {
    this.reserve(taskId, taskClass, resources);
    void this.runTask(taskId, taskClass, resources, fn, resolve, reject);
  }

  private reserve(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
  ): void {
    for (const resource of resources) {
      this.heldResources.set(resource, (this.heldResources.get(resource) ?? 0) + 1);
    }
    this.active.set(taskId, { taskId, taskClass, resources: [...resources] });
    if (taskClass === "build") this.activeBuilds += 1;
    if (taskClass === "privileged") this.activePrivileged += 1;
  }

  private async runAdopted(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
    watch: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await watch();
    } catch {
      // The persisted task state is authoritative. Occupancy must still be
      // released if the watcher fails while reconciling it.
    } finally {
      this.release(taskId, taskClass, resources);
      this.drain();
    }
  }

  private async runTask<T>(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
    fn: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    try {
      resolve(await fn());
    } catch (error) {
      reject(error);
    } finally {
      this.release(taskId, taskClass, resources);
      this.drain();
    }
  }

  private release(
    taskId: string,
    taskClass: "default" | "build" | "privileged",
    resources: readonly string[],
  ): void {
    if (!this.active.delete(taskId)) return;
    for (const resource of resources) {
      const remaining = (this.heldResources.get(resource) ?? 1) - 1;
      if (remaining <= 0) this.heldResources.delete(resource);
      else this.heldResources.set(resource, remaining);
    }
    if (taskClass === "build") this.activeBuilds -= 1;
    if (taskClass === "privileged") this.activePrivileged -= 1;
  }

  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (this.canStart(w.taskClass, w.resources)) {
          this.waiters.splice(i, 1);
          if (w.timer) clearTimeout(w.timer);
          this.start(w.taskId, w.taskClass, w.resources, w.fn, w.resolve, w.reject);
          progressed = true;
          break;
        }
      }
    }
  }
}
