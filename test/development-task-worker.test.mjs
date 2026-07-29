import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-worker-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "worker-test-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";
// Exercise the production default. The dedicated recovery test injects a
// 250ms stale window to cover prompt missing-worker interruption.
process.env.DEV_TASK_HEARTBEAT_MS = "2000";
process.env.DEV_TASK_CANCEL_GRACE_MS = "300";
process.env.MCP_AUTH_TOKEN = "must-not-reach-development-worker";
process.env.AUTH_PIN = "must-not-reach-development-worker-pin";

const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator, developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");

const fixture = path.resolve(import.meta.dirname, "fixtures/development-worker-fixture.mjs");
const ownerKey = developmentOwnerKey("owner");

test.after(async () => rm(root, { recursive: true, force: true }));

function newCoordinator() {
  const store = new DevelopmentTaskStore(path.join(root, "tasks-" + Math.random().toString(36).slice(2)));
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 30_000 });
  return new DevelopmentTaskCoordinator(store, scheduler);
}

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
  throw new Error(`task ${id} did not reach ${state} within ${timeoutMs}ms (last: ${JSON.stringify(store.get(id)?.state)})`);
}

async function waitForTerminal(store, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"];
  while (Date.now() < deadline) {
    const r = store.get(id);
    if (r && terminal.includes(r.state)) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${id} did not terminate within ${timeoutMs}ms (last: ${JSON.stringify(store.get(id)?.state)})`);
}

test("a successful fixture run reaches succeeded", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"], launch: launch({ args: [fixture, "--stdout", "hello"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.equal(final.exit?.code, 0);
  const log = await readFile(path.join(c.store.taskDir(task.id), "stdout.log"), "utf8");
  assert.match(log, /hello/);
});

test("a nonzero exit reaches failed", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"], launch: launch({ args: [fixture, "--exit", "3"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "failed");
  assert.equal(final.exit?.code, 3);
});

test("secret env values are redacted from logs", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({
      args: [fixture, "--env-echo", "FIXTURE_OUTPUT"],
      env: { FIXTURE_OUTPUT: "super-secret-value" },
    }),
  });
  await waitForTerminal(c.store, task.id);
  const log = await readFile(path.join(c.store.taskDir(task.id), "stdout.log"), "utf8");
  assert.doesNotMatch(log, /super-secret-value/);
  assert.match(log, /\[REDACTED\]/);
});

test("worker children do not inherit MCP credentials or worker tokens", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "environment-isolation",
    class: "default", resources: ["project:environment-isolation"],
    launch: launch({ args: [fixture, "--env-echo", "MCP_AUTH_TOKEN"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  const taskDir = c.store.taskDir(task.id);
  const stdout = await readFile(path.join(taskDir, "stdout.log"), "utf8");
  const launchJson = await readFile(path.join(taskDir, "launch.json"), "utf8");
  assert.doesNotMatch(stdout, /must-not-reach|FEISHU_MCP_WORKER_TOKEN/);
  assert.doesNotMatch(launchJson, /must-not-reach|FEISHU_MCP_WORKER_TOKEN/);
});

test("worker records only artifacts inside authorized real output roots", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "authorized-output");
  await mkdir(outputRoot, { recursive: true });
  const artifact = path.join(outputRoot, "app.apk");
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "build",
    class: "build", resources: ["project:artifact-safe"],
    launch: launch({
      args: [fixture, "--artifact", artifact],
      artifactRoots: [outputRoot],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.equal(final.artifacts.length, 1);
  assert.deepEqual(
    { name: final.artifacts[0].name, kind: final.artifacts[0].kind, size: final.artifacts[0].size },
    { name: "app.apk", kind: "fixture", size: Buffer.byteLength("artifact\n") },
  );
  assert.match(final.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(final.artifacts[0].path, await import("node:fs/promises").then((fs) => fs.realpath(artifact)));
});

test("worker rejects artifact manifests outside roots and through junctions", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "authorized-output-links");
  const outsideRoot = path.join(root, "outside-output");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const linked = path.join(outputRoot, "linked");
  await import("node:fs/promises").then((fs) =>
    fs.symlink(outsideRoot, linked, process.platform === "win32" ? "junction" : "dir")
  );
  const escapedArtifact = path.join(linked, "escaped.apk");
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "build",
    class: "build", resources: ["project:artifact-link"],
    launch: launch({
      args: [fixture, "--artifact", escapedArtifact],
      artifactRoots: [outputRoot],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.deepEqual(final.artifacts, []);
  assert.equal(await readFile(path.join(outsideRoot, "escaped.apk"), "utf8"), "artifact\n");
});

test("cancel while running reaches cancelled", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({ args: [fixture, "--sleep", "5000"], timeoutMs: 15_000 }),
  });
  await waitForState(c.store, task.id, "running");
  const res = c.cancel(task.id, ownerKey);
  assert.equal("cancelled" in res && res.cancelled, true);
  const final = await waitForTerminal(c.store, task.id, 15_000);
  assert.equal(final.state, "cancelled");
});

test("cancel before start (queued) reaches cancelled", async () => {
  const c = newCoordinator();
  // Occupy the shared resource so the second task stays queued.
  const blocker = c.enqueue({
    ownerKey, tool: "windows_development", action: "block",
    class: "build", resources: ["project:block"],
    launch: launch({ args: [fixture, "--sleep", "800"], timeoutMs: 10_000 }),
  });
  await waitForState(c.store, blocker.id, "running");
  const queued = c.enqueue({
    ownerKey, tool: "windows_development", action: "queued",
    class: "build", resources: ["project:block"],
    launch: launch({ args: [fixture, "--stdout", "queued"] }),
  });
  // same resource as the running blocker -> must be queued
  assert.equal(c.scheduler.summary().queued, 1);
  const res = c.cancel(queued.id, ownerKey);
  assert.equal("cancelled" in res && res.cancelled, true);
  const final = c.store.get(queued.id);
  assert.equal(final?.state, "cancelled");
  await waitForTerminal(c.store, blocker.id);
});

test("cross-owner cancel is denied", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({ args: [fixture, "--sleep", "2000"], timeoutMs: 10_000 }),
  });
  await waitForState(c.store, task.id, "running");
  const res = c.cancel(task.id, "wrong-key");
  assert.equal("denied" in res && res.denied, true);
  c.cancel(task.id, ownerKey);
  await waitForTerminal(c.store, task.id, 15_000);
});
