import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-workflow-worker-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "workflow-worker-test-secret-0123456789ab";
process.env.OWNER_USER_ID = "workflow-worker-owner";
process.env.LOG_LEVEL = "error";
const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");
const { issueWorkerToken } = await import("../dist/development/tasks/workerProtocol.js");
const { runWorker } = await import("../dist/development/tasks/worker.js");
const fixture = path.resolve(import.meta.dirname, "fixtures/development-workflow-fixture.mjs");
const ownerKey = developmentOwnerKey("workflow-worker-owner");
test.after(() => rm(root, { recursive: true, force: true }));

function createTask() {
  const store = new DevelopmentTaskStore(path.join(root, crypto.randomUUID()));
  const task = store.create({ ownerKey, tool: "run_local_workflow", action: "verify_web", class: "build", resources: ["workspace:zeroxcore-web"], kind: "workflow" });
  return { store, task };
}

function spec(steps) {
  return { workspaceId: "zeroxcore-web", recipeId: "verify_web", recipeDigest: "a".repeat(64), cwd: root, timeoutMs: 30_000, steps };
}

function step(id, options = {}) {
  return {
    id, kind: id, executable: process.execPath,
    args: [fixture, "--step", id, ...(options.stdout ? ["--stdout", options.stdout] : []), ...(options.exit ? ["--exit", String(options.exit)] : [])],
    timeoutMs: 5_000, enabled: options.enabled ?? true,
  };
}

test("runs enabled steps serially and records a skipped optional test", async () => {
  const { store, task } = createTask();
  store.saveWorkflowSpec(task.id, spec([
    step("typecheck", { stdout: "type-ok" }),
    step("test_selected", { enabled: false }),
    step("build", { stdout: "build-ok" }),
  ]));
  await runWorker({ taskDir: store.taskDir(task.id), token: issueWorkerToken(store.taskDir(task.id)) });
  const final = store.get(task.id);
  assert.equal(final?.state, "succeeded");
  assert.deepEqual(final?.steps?.map(({ id, state }) => ({ id, state })), [
    { id: "typecheck", state: "succeeded" },
    { id: "test_selected", state: "skipped" },
    { id: "build", state: "succeeded" },
  ]);
  const stdout = await readFile(path.join(store.taskDir(task.id), "stdout.log"), "utf8");
  assert.match(stdout, /step typecheck/);
  assert.match(stdout, /type-ok/);
  assert.match(stdout, /build-ok/);
});

test("stops the workflow after a failed step and marks remaining work skipped", async () => {
  const { store, task } = createTask();
  store.saveWorkflowSpec(task.id, spec([step("typecheck"), step("lint", { exit: 3 }), step("build")]));
  await runWorker({ taskDir: store.taskDir(task.id), token: issueWorkerToken(store.taskDir(task.id)) });
  const final = store.get(task.id);
  assert.equal(final?.state, "failed");
  assert.deepEqual(final?.steps?.map(({ id, state, exitCode }) => ({ id, state, exitCode })), [
    { id: "typecheck", state: "succeeded", exitCode: 0 },
    { id: "lint", state: "failed", exitCode: 3 },
    { id: "build", state: "skipped", exitCode: null },
  ]);
});
