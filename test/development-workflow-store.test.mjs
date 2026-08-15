import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-workflow-store-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "workflow-store-test-secret-0123456789ab";
process.env.OWNER_USER_ID = "workflow-store-owner";
process.env.LOG_LEVEL = "error";
const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");
const ownerKey = developmentOwnerKey("workflow-store-owner");

test.after(() => rm(root, { recursive: true, force: true }));

function store() {
  return new DevelopmentTaskStore(path.join(root, crypto.randomUUID()));
}

function workflow(cwd) {
  return {
    workspaceId: "zeroxcore-web",
    recipeId: "verify_web",
    recipeDigest: "a".repeat(64),
    cwd,
    timeoutMs: 60_000,
    artifactDirs: [path.join(cwd, "dist")],
    steps: [
      { id: "typecheck", kind: "typecheck", executable: process.execPath, args: ["--version"], timeoutMs: 5_000, enabled: true },
      { id: "test_selected", kind: "test_selected", executable: process.execPath, args: ["--version"], timeoutMs: 5_000, enabled: false },
    ],
  };
}

function createWorkflowTask(taskStore) {
  return taskStore.create({
    ownerKey,
    tool: "run_local_workflow",
    action: "verify_web",
    class: "build",
    resources: ["workspace:zeroxcore-web"],
    kind: "workflow",
  });
}

test("persists and reloads a validated workflow separately from metadata", () => {
  const taskStore = store();
  const task = createWorkflowTask(taskStore);
  taskStore.saveWorkflowSpec(task.id, workflow(root));

  const loaded = taskStore.loadWorkflowSpec(task.id);
  assert.deepEqual(loaded?.steps.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "typecheck", enabled: true },
    { id: "test_selected", enabled: false },
  ]);
  assert.equal(taskStore.get(task.id)?.steps, undefined);
  assert.equal(taskStore.loadLaunchSpecForTask(task.id)?.recipeId, "verify_web");
});

test("retains legacy command tasks without a kind discriminator", () => {
  const taskStore = store();
  const task = taskStore.create({ ownerKey, tool: "windows_development", action: "build", class: "build", resources: ["project:test"] });
  taskStore.saveLaunchSpec(task.id, { executable: process.execPath, args: ["--version"], cwd: root, env: {}, timeoutMs: 5_000, successExitCodes: [0] });
  assert.equal(task.kind, undefined);
  assert.equal(taskStore.loadLaunchSpecForTask(task.id)?.executable, process.execPath);
});

test("rejects malformed workflow fields and records safe step summaries", () => {
  const taskStore = store();
  const task = createWorkflowTask(taskStore);
  const invalid = workflow(root);
  invalid.steps[0].executable = "pnpm";
  assert.throws(() => taskStore.saveWorkflowSpec(task.id, invalid), /absolute path/i);

  taskStore.update(task.id, "queued", { state: "running" });
  const updated = taskStore.update(task.id, "running", {
    steps: [{ id: "typecheck", kind: "typecheck", state: "succeeded", exitCode: 0, durationMs: 12 }],
    directorySummaries: [{ id: "web-build", kind: "directory-summary", path: path.join(root, "dist"), fileCount: 2, byteTotal: 128 }],
  });
  assert.equal(updated.steps?.[0].state, "succeeded");
  assert.equal(updated.directorySummaries?.[0].byteTotal, 128);
});
