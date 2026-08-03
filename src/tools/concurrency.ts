import {
  BINARY_ARTIFACT_MAX_UPLOADS,
  MAX_CONCURRENT_COMMANDS,
  MAX_CONCURRENT_FETCHES,
  MAX_CONCURRENT_SEARCHES,
  MAX_CONCURRENT_TOOLS,
  TOOL_QUEUE_TIMEOUT_MS,
} from "../config.js";

export type ConcurrencyClass = "default" | "command" | "search" | "fetch" | "artifact" | "ungated";

export interface ConcurrencyStats {
  active: number;
  queued: number;
  limit: number;
}

export class QueueTimeoutError extends Error {
  readonly code = "QUEUE_TIMEOUT";

  constructor(gateName: string, timeoutMs: number) {
    super(`${gateName} queue timeout after ${timeoutMs}ms`);
    this.name = "QueueTimeoutError";
  }
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: QueueTimeoutError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** A FIFO semaphore with bounded wait time and observable, non-sensitive statistics. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly name: string,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`${name} concurrency limit must be a positive integer`);
    }
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`${this.name} queue timeout must be a positive integer`);
    }
    if (this.waiters.length === 0 && this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new QueueTimeoutError(this.name, timeoutMs));
        }, timeoutMs),
        settled: false,
      };
      this.waiters.push(waiter);
    });
  }

  summary(): ConcurrencyStats {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.grantNext();
    };
  }

  private grantNext(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timeout);
      this.active += 1;
      waiter.resolve(this.releaseFunction());
    }
  }
}

const globalGate = new Semaphore(MAX_CONCURRENT_TOOLS, "tools");
const commandGate = new Semaphore(MAX_CONCURRENT_COMMANDS, "commands");
const searchGate = new Semaphore(MAX_CONCURRENT_SEARCHES, "searches");
const fetchGate = new Semaphore(MAX_CONCURRENT_FETCHES, "fetches");
const artifactGate = new Semaphore(BINARY_ARTIFACT_MAX_UPLOADS, "artifacts");

function childGate(kind: Exclude<ConcurrencyClass, "ungated">): Semaphore | null {
  switch (kind) {
    case "command": return commandGate;
    case "search": return searchGate;
    case "fetch": return fetchGate;
    case "artifact": return artifactGate;
    case "default": return null;
  }
}

export async function withConcurrency<T>(
  kind: ConcurrencyClass,
  run: () => Promise<T>,
): Promise<T> {
  if (kind === "ungated") return run();
  const child = childGate(kind);
  const releaseChild = child ? await child.acquire(TOOL_QUEUE_TIMEOUT_MS) : null;
  try {
    const releaseGlobal = await globalGate.acquire(TOOL_QUEUE_TIMEOUT_MS);
    try {
      return await run();
    } finally {
      releaseGlobal();
    }
  } finally {
    releaseChild?.();
  }
}

export function concurrencySummary(): Record<"global" | "command" | "search" | "fetch" | "artifact", ConcurrencyStats> {
  return {
    global: globalGate.summary(),
    command: commandGate.summary(),
    search: searchGate.summary(),
    fetch: fetchGate.summary(),
    artifact: artifactGate.summary(),
  };
}
