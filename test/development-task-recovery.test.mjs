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

test("a fresh adopted task restores health, capacity, and resource occupancy", async () => {
  const taskDir = path.join(root, "tasks-adopt-locks");
  const store = new DevelopmentTaskStore(taskDir);
  const record = store.create({
    ownerKey, tool: "windows_development", action: "adopted",
    class: "build", resources: ["project:shared", "device:emulator-1"],
  });
  const startedAt = new Date().toISOString();
  store.update(record.id, "queued", {
    state: "running",
    startedAt,
    worker: { pid: 12345, nonce: "fresh-nonce", heartbeatAt: startedAt },
  });
  const { writeHeartbeat } = await import("../dist/development/tasks/workerProtocol.js");
  writeHeartbeat(store.taskDir(record.id), {
    pid: 12345, nonce: "fresh-nonce", heartbeatAt: new Date().toISOString(),
  });

  const scheduler = new DevelopmentTaskScheduler({ total: 1, builds: 1, queueTimeoutMs: 5_000 });
  const coordinator = new DevelopmentTaskCoordinator(store, scheduler, {
    heartbeatStaleMs: 5_000,
    pollIntervalMs: 20,
  });
  assert.deepEqual(coordinator.healthSummary(), {
    queued: 0, running: 1, terminal: 0, totalLimit: 1, buildLimit: 1,
  });

  const next = scheduler.run("next", "build", ["project:shared"], async () => "started");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scheduler.summary().queued, 1);
  store.update(record.id, "running", { state: "succeeded", endedAt: new Date().toISOString() });
  assert.equal(await next, "started");
  assert.equal(scheduler.summary().active, 0);
});

test("a worker that exits before heartbeat becomes interrupted and releases locks", async () => {
  const taskDir = path.join(root, "tasks-worker-died");
  const store = new DevelopmentTaskStore(taskDir);
  const scheduler = new DevelopmentTaskScheduler({ total: 1, builds: 1, queueTimeoutMs: 5_000 });
  const coordinator = new DevelopmentTaskCoordinator(store, scheduler, {
    workerScript: path.join(root, "missing-worker-script.mjs"),
    heartbeatStaleMs: 250,
    startupGraceMs: 250,
    pollIntervalMs: 20,
  });
  const task = coordinator.enqueue({
    ownerKey, tool: "windows_development", action: "missing-worker",
    class: "build", resources: ["project:worker-died"],
    launch: launch(),
  });
  const final = await waitForState(store, task.id, "interrupted", 3_000);
  assert.equal(final.exit?.errorCode, "TASK_INTERRUPTED");
  const releaseDeadline = Date.now() + 1_000;
  while (scheduler.summary().active !== 0 && Date.now() < releaseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(scheduler.summary().active, 0);
  assert.equal(scheduler.summary().queued, 0);
});

test("queued recovery rejects an invalid owner key or tampered launch spec", async () => {
  const taskDir = path.join(root, "tasks-invalid-recovery");
  const store = new DevelopmentTaskStore(taskDir);
  const invalidOwner = store.create({
    ownerKey: "raw-owner-id", tool: "windows_development", action: "invalid-owner",
    class: "default", resources: [],
  });
  store.saveLaunchSpec(invalidOwner.id, launch());

  const invalidLaunch = store.create({
    ownerKey, tool: "windows_development", action: "invalid-launch",
    class: "default", resources: [],
  });
  store.saveLaunchSpec(invalidLaunch.id, launch());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(store.launchPath(invalidLaunch.id), JSON.stringify({
    executable: "cmd.exe", args: ["/c", "whoami"], cwd: root,
    env: {}, timeoutMs: 1000, successExitCodes: [0],
  }));

  const scheduler = new DevelopmentTaskScheduler({ total: 2, builds: 1, queueTimeoutMs: 5_000 });
  new DevelopmentTaskCoordinator(store, scheduler);
  assert.equal(store.get(invalidOwner.id)?.state, "interrupted");
  assert.equal(store.get(invalidLaunch.id)?.state, "interrupted");
  assert.deepEqual(scheduler.summary(), { active: 0, queued: 0, totalLimit: 2, buildLimit: 1 });
});
