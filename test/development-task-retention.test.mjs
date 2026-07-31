import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-retention-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "retention-test-secret-0123456789ab";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";
process.env.DEV_TASK_HEARTBEAT_MS = "1000";
process.env.DEV_TASK_CANCEL_GRACE_MS = "300";

const { DevelopmentTaskStore, cleanupDevelopmentTasks } = await import(
  "../dist/development/tasks/store.js"
);
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator } = await import("../dist/development/tasks/coordinator.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");

test.after(async () => rm(root, { recursive: true, force: true }));

const ownerKey = developmentOwnerKey("owner");

let counter = 0;
function freshStore() {
  counter += 1;
  return new DevelopmentTaskStore(path.join(root, `store-${counter}`));
}

function createTask(store, overrides = {}) {
  return store.create({
    ownerKey,
    tool: "android_build",
    action: "assembleDebug",
    class: "build",
    resources: ["project-alpha"],
    ...overrides,
  });
}

function finalize(store, id, state, when = new Date()) {
  store.update(id, "queued", { state, endedAt: when.toISOString(), exit: { code: 0 } });
}

/** Backdate a record's timestamps by rewriting metadata directly. */
function age(store, id, isoDate) {
  const file = store.metadataPath(id);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.createdAt = isoDate;
  record.updatedAt = isoDate;
  if (record.endedAt) record.endedAt = isoDate;
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------

test("cleanup deletes only terminal tasks older than retention", async () => {
  const store = freshStore();
  const oldSucceeded = createTask(store);
  finalize(store, oldSucceeded.id, "succeeded");
  age(store, oldSucceeded.id, daysAgo(30));

  const recentSucceeded = createTask(store);
  finalize(store, recentSucceeded.id, "succeeded");

  const oldQueued = createTask(store);
  age(store, oldQueued.id, daysAgo(60));

  const oldRunning = createTask(store);
  store.update(oldRunning.id, "queued", { state: "running", startedAt: new Date().toISOString() });
  age(store, oldRunning.id, daysAgo(60));

  const result = cleanupDevelopmentTasks(store, {
    retentionDays: 14,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(store.taskDir(oldSucceeded.id)), false);
  assert.equal(fs.existsSync(store.taskDir(recentSucceeded.id)), true, "recent terminal kept");
  assert.equal(fs.existsSync(store.taskDir(oldQueued.id)), true, "queued never deleted");
  assert.equal(fs.existsSync(store.taskDir(oldRunning.id)), true, "running never deleted");
});

test("cleanup respects the total-byte cap oldest-first", async () => {
  const store = freshStore();
  const tasks = [];
  for (let i = 0; i < 3; i += 1) {
    const record = createTask(store);
    finalize(store, record.id, "succeeded");
    await writeFile(path.join(store.taskDir(record.id), "blob.bin"), Buffer.alloc(1000, i + 1));
    tasks.push(record);
  }
  // Distinct ages: oldest first.
  age(store, tasks[0].id, daysAgo(3));
  age(store, tasks[1].id, daysAgo(2));
  age(store, tasks[2].id, daysAgo(1));

  const sizeOf = (t) => store.directorySize(t.id);
  const cap = sizeOf(tasks[1]) + sizeOf(tasks[2]);
  const result = cleanupDevelopmentTasks(store, {
    retentionDays: 365, // age path must not trigger
    maxTotalBytes: cap,
  });

  assert.equal(result.removed, 1, "exactly the oldest terminal task is removed");
  assert.equal(fs.existsSync(store.taskDir(tasks[0].id)), false);
  assert.equal(fs.existsSync(store.taskDir(tasks[1].id)), true);
  assert.equal(fs.existsSync(store.taskDir(tasks[2].id)), true);
  assert.equal(result.bytesFreed >= 1000, true);
});

test("cleanup leaves queued and running tasks untouched even when oversized", async () => {
  const store = freshStore();
  const running = createTask(store);
  store.update(running.id, "queued", { state: "running", startedAt: new Date().toISOString() });
  await writeFile(path.join(store.taskDir(running.id), "huge.bin"), Buffer.alloc(4096, 7));

  const result = cleanupDevelopmentTasks(store, {
    retentionDays: 365,
    maxTotalBytes: 1, // absurdly small; still must not delete active work
  });

  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(path.join(store.taskDir(running.id), "huge.bin")), true);
});

test("cleanup never touches non-UUID entries or follows symlinks", async () => {
  const store = freshStore();
  const terminal = createTask(store);
  finalize(store, terminal.id, "succeeded");

  // A project-artifact-looking directory inside the store root.
  const foreign = path.join(store.root, "project-artifacts");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "keep.apk"), "do not delete");

  // A UUID-named symlink pointing outside the store.
  const outside = path.join(root, "outside-target");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "do not delete");
  const linkName = path.join(store.root, "11111111-2222-3333-4444-555555555555");
  await symlink(outside, linkName, process.platform === "win32" ? "junction" : "dir");

  cleanupDevelopmentTasks(store, { retentionDays: 0, maxTotalBytes: 0 });

  assert.equal(fs.existsSync(path.join(foreign, "keep.apk")), true);
  assert.equal(fs.lstatSync(linkName).isSymbolicLink(), true, "symlink itself untouched");
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "symlink target untouched");
});

test("directorySize does not follow symlinks", async () => {
  const store = freshStore();
  const record = createTask(store);
  const dir = store.taskDir(record.id);
  await writeFile(path.join(dir, "real.bin"), Buffer.alloc(512, 1));
  const outside = path.join(root, "size-outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "large.bin"), Buffer.alloc(8192, 2));
  await symlink(outside, path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");

  const size = store.directorySize(record.id);
  assert.equal(size < 8192, true, "symlinked content must not be counted");
});

test("health summary exposes only aggregate counts and limits", () => {
  const store = freshStore();
  const terminal = createTask(store);
  finalize(store, terminal.id, "succeeded");
  const coordinator = new DevelopmentTaskCoordinator(
    store,
    new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 0 }),
  );

  const summary = coordinator.healthSummary();
  assert.deepEqual(summary, {
    queued: 0,
    running: 0,
    terminal: 1,
    totalLimit: 4,
    buildLimit: 2,
  });
  assert.doesNotMatch(JSON.stringify(summary), /taskId|ownerKey|device|project|worker|heartbeat/i);
});

test("cleanup result reports counts only", () => {
  const store = freshStore();
  const old = createTask(store);
  finalize(store, old.id, "failed");
  age(store, old.id, daysAgo(30));

  const result = cleanupDevelopmentTasks(store, { retentionDays: 14, maxTotalBytes: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(Object.keys(result).sort(), ["bytesFreed", "remainingBytes", "removed"]);
  assert.equal(result.removed, 1);
  assert.doesNotMatch(JSON.stringify(result), /taskId|ownerKey|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});
