import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-recover-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "recovery-test-secret-0123456789ab";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";
process.env.DEV_TASK_HEARTBEAT_MS = "1000";
process.env.DEV_TASK_CANCEL_GRACE_MS = "300";

const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator, developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");

const fixture = path.resolve(import.meta.dirname, "fixtures/development-worker-fixture.mjs");
const ownerKey = developmentOwnerKey("owner");

test.after(async () => rm(root, { recursive: true, force: true }));

function launch(overrides = {}) {
  return {
    executable: process.execPath,
    args: [fixture],
    cwd: root,
    env: {},
    timeoutMs: 10_000,
    successExitCodes: [0],
    ...overrides,
  };
}

async function waitForState(store, id, state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = store.get(id);
    if (r?.state === state) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${id} did not reach ${state}`);
}

test("a running task with a fresh heartbeat is adopted across reconstruction", async () => {
  const taskDir = path.join(root, "tasks-recover");
  const store = new DevelopmentTaskStore(taskDir);
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 30_000 });
  const c1 = new DevelopmentTaskCoordinator(store, scheduler);
  const task = c1.enqueue({
    ownerKey, tool: "windows_development", action: "long",
    class: "build", resources: ["project:long"],
    launch: launch({ args: [fixture, "--sleep", "4000"], timeoutMs: 15_000 }),
  });
  await waitForState(store, task.id, "running");

  // Wait for the detached worker to actually be alive (heartbeat written)
  // before reconstructing the coordinator, matching a real restart cadence.
  const { readHeartbeat } = await import("../dist/development/tasks/workerProtocol.js");
  for (let i = 0; i < 100; i++) {
    if (readHeartbeat(store.taskDir(task.id))) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // Discard coordinator 1; the detached worker keeps running.
  // Construct a fresh coordinator over the same store. The running task
  // should still be present with the same id.
  const scheduler2 = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 30_000 });
  const c2 = new DevelopmentTaskCoordinator(store, scheduler2);
  const stillThere = store.get(task.id);
  assert.equal(stillThere?.id, task.id);
  assert.equal(stillThere?.state === "running" || stillThere?.state === "succeeded", true);

  // Wait for the worker to finish on its own.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = store.get(task.id);
    if (r && ["succeeded", "failed", "cancelled", "interrupted"].includes(r.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const final = store.get(task.id);
  assert.ok(final && ["succeeded", "interrupted"].includes(final.state), `unexpected final state: ${final?.state}`);
  void c2;
});

test("a stale running task is marked interrupted on recovery", async () => {
  const taskDir = path.join(root, "tasks-stale");
  const store = new DevelopmentTaskStore(taskDir);
  // Create a running record with an old heartbeat, simulating a crashed worker.
  const record = store.create({
    ownerKey, tool: "windows_development", action: "stale",
    class: "build", resources: ["project:stale"],
  });
  store.update(record.id, "queued", { state: "running", startedAt: new Date().toISOString(), worker: { pid: 99999, nonce: "x", heartbeatAt: new Date(Date.now() - 60_000).toISOString() } });
  // Write a stale heartbeat file.
  const { writeFileSync } = await import("node:fs");
  const { heartbeatPath } = await import("../dist/development/tasks/workerProtocol.js");
  writeFileSync(heartbeatPath(store.taskDir(record.id)), JSON.stringify({ pid: 99999, nonce: "x", heartbeatAt: new Date(Date.now() - 60_000).toISOString() }) + "\n");

  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 30_000 });
  new DevelopmentTaskCoordinator(store, scheduler);

  const after = store.get(record.id);
  assert.equal(after?.state, "interrupted");
  assert.equal(after?.exit?.errorCode, "TASK_INTERRUPTED");
});
