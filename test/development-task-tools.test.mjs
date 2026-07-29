import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-tools-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "tools-test-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";
process.env.DEV_TASK_HEARTBEAT_MS = "1000";
process.env.DEV_TASK_CANCEL_GRACE_MS = "300";

const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator } = await import("../dist/development/tasks/coordinator.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");
const {
  getDevelopmentTask,
  readDevelopmentTaskLogs,
  cancelDevelopmentTask,
  MAX_LOG_BYTES,
  MAX_LOG_LINES,
} = await import("../dist/tools/developmentTasks.js");

test.after(async () => rm(root, { recursive: true, force: true }));

const ownerKey = developmentOwnerKey("owner");
const otherKey = developmentOwnerKey("intruder");
const authorizedRoot = path.join(root, "authorized");
await import("node:fs/promises").then((fsm) => fsm.mkdir(authorizedRoot, { recursive: true }));

let counter = 0;
function freshCoordinator(schedulerOptions = { total: 4, builds: 2, queueTimeoutMs: 0 }) {
  counter += 1;
  const store = new DevelopmentTaskStore(path.join(root, `store-${counter}`));
  const scheduler = new DevelopmentTaskScheduler(schedulerOptions);
  return new DevelopmentTaskCoordinator(store, scheduler);
}

function deps(coordinator, userId = "owner") {
  return {
    coordinator,
    userId: () => userId,
    hasDirectoryAccess: (_userId, candidate) =>
      path.resolve(candidate).startsWith(path.resolve(authorizedRoot) + path.sep),
  };
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

// ---------------------------------------------------------------- get task ---

test("get_development_task returns the public shape without internal fields", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  coordinator.store.update(record.id, "queued", {
    state: "succeeded",
    endedAt: new Date().toISOString(),
    exit: { code: 0, message: "build ok" },
  });
  const result = await getDevelopmentTask({ taskId: record.id }, deps(coordinator));
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.task.id, record.id);
  assert.equal(body.task.tool, "android_build");
  assert.equal(body.task.action, "assembleDebug");
  assert.equal(body.task.class, "build");
  assert.equal(body.task.state, "succeeded");
  assert.equal(body.task.exit.code, 0);
  assert.equal("ownerKey" in body.task, false);
  assert.equal("worker" in body.task, false);
  assert.equal("launch" in body.task, false);
  assert.equal("resources" in body.task, false);
});

test("get_development_task hides artifact paths outside authorized directories", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const insidePath = path.join(authorizedRoot, "app-debug.apk");
  const outsidePath = path.join(root, "secret-output.apk");
  coordinator.store.update(record.id, "queued", {
    state: "succeeded",
    endedAt: new Date().toISOString(),
  });
  coordinator.store.recordArtifact(record.id, {
    name: "app-debug.apk",
    path: insidePath,
    kind: "apk",
    size: 123,
    sha256: "abc123",
  });
  coordinator.store.recordArtifact(record.id, {
    name: "secret-output.apk",
    path: outsidePath,
    kind: "apk",
    size: 456,
  });
  const first = JSON.parse(
    (await getDevelopmentTask({ taskId: record.id }, deps(coordinator))).content[0].text,
  );
  const second = JSON.parse(
    (await getDevelopmentTask({ taskId: record.id }, deps(coordinator))).content[0].text,
  );
  const [inside, outside] = first.task.artifacts;
  assert.equal(inside.path, insidePath);
  assert.equal(inside.sha256, "abc123");
  assert.equal("artifactId" in inside, false);
  assert.equal("path" in outside, false);
  assert.match(outside.artifactId, /^[0-9a-f]{24}$/);
  assert.equal(second.task.artifacts[1].artifactId, outside.artifactId, "artifactId must be stable");
  assert.equal(JSON.stringify(first).includes(outsidePath), false);
});

test("get_development_task denies cross-owner and unknown tasks identically", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const crossOwner = await getDevelopmentTask({ taskId: record.id }, deps(coordinator, "intruder"));
  assert.equal(crossOwner.isError, true);
  assert.equal(JSON.parse(crossOwner.content[0].text).code, "TASK_NOT_FOUND");
  const unknown = await getDevelopmentTask(
    { taskId: "11111111-2222-3333-4444-555555555555" },
    deps(coordinator),
  );
  assert.equal(unknown.isError, true);
  assert.equal(JSON.parse(unknown.content[0].text).code, "TASK_NOT_FOUND");
  assert.equal(
    JSON.parse(crossOwner.content[0].text).message,
    JSON.parse(unknown.content[0].text).message,
    "cross-owner and unknown-task responses must be indistinguishable",
  );
});

// ---------------------------------------------------------------- log read ---

test("read_development_task_logs paginates bytes with independent stream cursors", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const dir = coordinator.store.taskDir(record.id);
  await writeFile(path.join(dir, "stdout.log"), "alpha\nbeta\ngamma\ndelta\n");
  await writeFile(path.join(dir, "stderr.log"), "err-one\nerr-two\n");

  const first = JSON.parse(
    (await readDevelopmentTaskLogs(
      { taskId: record.id, stream: "both", maxBytes: 11 },
      deps(coordinator),
    )).content[0].text,
  );
  assert.equal(first.ok, true);
  assert.equal(first.stdout, "alpha\nbeta\n");
  assert.equal(first.stderr, "err-one\nerr");
  assert.deepEqual(first.cursors, { stdout: 0, stderr: 0 });
  assert.equal(first.nextCursors.stdout, 11);
  assert.equal(first.nextCursors.stderr, 11);
  assert.equal(first.truncated.stdout, true);
  assert.equal(first.truncated.stderr, true);
  assert.equal(first.eof.stdout, false);

  const second = JSON.parse(
    (await readDevelopmentTaskLogs(
      {
        taskId: record.id,
        stream: "stdout",
        cursorStdout: first.nextCursors.stdout,
      },
      deps(coordinator),
    )).content[0].text,
  );
  assert.equal(second.stdout, "gamma\ndelta\n");
  assert.equal(second.eof.stdout, true);
  assert.equal(second.truncated.stdout, false);
  assert.equal("stderr" in second, false, "stderr was not requested");
  assert.equal(second.nextCursors.stderr, 0, "stderr cursor must not move");
});

test("read_development_task_logs enforces the line cap and resumes exactly", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const dir = coordinator.store.taskDir(record.id);
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
  await writeFile(path.join(dir, "stdout.log"), `${lines.join("\n")}\n`);

  const first = JSON.parse(
    (await readDevelopmentTaskLogs(
      { taskId: record.id, stream: "stdout", maxLines: 3 },
      deps(coordinator),
    )).content[0].text,
  );
  assert.deepEqual(first.stdout.split("\n").filter(Boolean), ["line-0", "line-1", "line-2"]);
  assert.equal(first.truncated.stdout, true);

  const rest = JSON.parse(
    (await readDevelopmentTaskLogs(
      { taskId: record.id, stream: "stdout", cursorStdout: first.nextCursors.stdout },
      deps(coordinator),
    )).content[0].text,
  );
  assert.deepEqual(
    rest.stdout.split("\n").filter(Boolean),
    lines.slice(3),
    "resuming at nextCursors must continue at line-3 exactly",
  );
  assert.equal(rest.eof.stdout, true);
});

test("read_development_task_logs starts at a UTF-8 safe boundary", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const dir = coordinator.store.taskDir(record.id);
  const text = "ab汉字cd\n"; // 汉/字 are 3 bytes each in UTF-8
  const bytes = Buffer.byteLength(text, "utf8");
  await writeFile(path.join(dir, "stdout.log"), text);

  // cursor lands in the middle of the multi-byte character 汉 (starts at byte 2)
  const result = JSON.parse(
    (await readDevelopmentTaskLogs(
      { taskId: record.id, stream: "stdout", cursorStdout: 3 },
      deps(coordinator),
    )).content[0].text,
  );
  assert.equal(result.stdout.includes("�"), false, "no replacement characters");
  assert.equal(result.stdout, "字cd\n");
  assert.equal(result.nextCursors.stdout, bytes);
  assert.equal(result.eof.stdout, true);
});

test("read_development_task_logs refuses symlinked log files", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const dir = coordinator.store.taskDir(record.id);
  const target = path.join(root, "elsewhere.log");
  await writeFile(target, "outside content\n");
  await symlink(target, path.join(dir, "stdout.log"));

  const result = await readDevelopmentTaskLogs(
    { taskId: record.id, stream: "stdout" },
    deps(coordinator),
  );
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, "INVALID_ARGUMENT");
});

test("read_development_task_logs caps maxBytes and maxLines at server limits", async () => {
  assert.equal(MAX_LOG_BYTES, 65_536);
  assert.equal(MAX_LOG_LINES, 500);
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const dir = coordinator.store.taskDir(record.id);
  await writeFile(path.join(dir, "stdout.log"), `${"x".repeat(200)}\n`);
  const result = JSON.parse(
    (await readDevelopmentTaskLogs(
      { taskId: record.id, stream: "stdout", maxBytes: 10_000_000, maxLines: 10_000 },
      deps(coordinator),
    )).content[0].text,
  );
  assert.equal(result.eof.stdout, true, "small file fully returned even with huge requested limits");
});

// ------------------------------------------------------------------- cancel ---

test("cancel_development_task cancels queued work through the scheduler", async () => {
  const coordinator = freshCoordinator({ total: 1, builds: 1, queueTimeoutMs: 0 });
  const blocker = createTask(coordinator.store);
  const queued = createTask(coordinator.store);
  const never = () => new Promise(() => {});
  // Capacity 1: the blocker starts synchronously (do not await — it never settles).
  void coordinator.scheduler.run(blocker.id, "default", [], never).catch(() => {});
  const waitPromise = coordinator.scheduler.run(queued.id, "default", [], never);
  waitPromise.catch(() => {});

  const result = JSON.parse(
    (await cancelDevelopmentTask({ taskId: queued.id }, deps(coordinator))).content[0].text,
  );
  assert.equal(result.ok, true);
  assert.equal(result.alreadyTerminal, false);
  const updated = coordinator.store.get(queued.id);
  assert.equal(updated.state, "cancelled");
  assert.equal(updated.exit.errorCode, "TASK_CANCELLED");
});

test("cancel_development_task requests cancellation of running work", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  coordinator.store.update(record.id, "queued", {
    state: "running",
    startedAt: new Date().toISOString(),
  });
  const result = JSON.parse(
    (await cancelDevelopmentTask({ taskId: record.id }, deps(coordinator))).content[0].text,
  );
  assert.equal(result.ok, true);
  assert.equal(result.alreadyTerminal, false);
  assert.equal(result.state, "cancel_requested");
  assert.equal(
    fs.existsSync(path.join(coordinator.store.taskDir(record.id), "cancel-request")),
    true,
    "cancel-request file must be created for the worker",
  );
});

test("cancel_development_task is idempotent for terminal tasks", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  coordinator.store.update(record.id, "queued", {
    state: "succeeded",
    endedAt: new Date().toISOString(),
    exit: { code: 0 },
  });
  const result = JSON.parse(
    (await cancelDevelopmentTask({ taskId: record.id }, deps(coordinator))).content[0].text,
  );
  assert.equal(result.ok, true);
  assert.equal(result.alreadyTerminal, true);
  assert.equal(result.state, "succeeded");
  assert.equal(
    fs.existsSync(path.join(coordinator.store.taskDir(record.id), "cancel-request")),
    false,
    "terminal tasks must not get a cancel-request file",
  );
});

test("cancel_development_task denies cross-owner access", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const result = await cancelDevelopmentTask({ taskId: record.id }, deps(coordinator, "intruder"));
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, "TASK_NOT_FOUND");
  assert.equal(coordinator.store.get(record.id).state, "queued", "state must be unchanged");
});

test("handlers never persist or return the raw owner id", async () => {
  const coordinator = freshCoordinator();
  const record = createTask(coordinator.store);
  const raw = fs.readFileSync(coordinator.store.metadataPath(record.id), "utf8");
  assert.equal(raw.includes('"owner"'), false);
  const result = JSON.parse(
    (await getDevelopmentTask({ taskId: record.id }, deps(coordinator))).content[0].text,
  );
  assert.equal(JSON.stringify(result).includes(otherKey), false);
  assert.equal(JSON.stringify(result).includes(ownerKey), false);
});
