import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-store-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "store-test-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");

test.after(async () => rm(root, { recursive: true, force: true }));

const ownerKey = developmentOwnerKey("owner");

function create(store, overrides = {}) {
  return store.create({
    ownerKey,
    tool: "android_development",
    action: "build",
    class: "build",
    resources: ["project:c:/tmp/app"],
    ...overrides,
  });
}

test("create persists a queued task with a uuid id", () => {
  const store = new DevelopmentTaskStore(path.join(root, "a"));
  const created = create(store);
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.equal(created.state, "queued");
  assert.equal(created.stage, "queued");
  assert.deepEqual(created.resources, ["project:c:/tmp/app"]);
  assert.equal(created.artifacts.length, 0);
  assert.equal(created.version, 1);
});

test("get reads back the persisted record", () => {
  const store = new DevelopmentTaskStore(path.join(root, "b"));
  const created = create(store);
  const round = store.get(created.id);
  assert.equal(round?.id, created.id);
  assert.equal(round?.state, "queued");
  assert.equal(round?.ownerKey, ownerKey);
});

test("update applies a compare-and-set transition", () => {
  const store = new DevelopmentTaskStore(path.join(root, "c"));
  const created = create(store);
  const running = store.update(created.id, "queued", { state: "running", stage: "spawn" });
  assert.equal(running.state, "running");
  assert.equal(running.stage, "spawn");
  assert.equal(store.get(created.id)?.state, "running");
});

test("update rejects a stale expected state", () => {
  const store = new DevelopmentTaskStore(path.join(root, "d"));
  const created = create(store);
  store.update(created.id, "queued", { state: "running" });
  assert.throws(
    () => store.update(created.id, "queued", { state: "failed" }),
    /state changed/i,
  );
});

test("list filters by owner key", () => {
  const store = new DevelopmentTaskStore(path.join(root, "e"));
  const mine = create(store);
  const other = store.create({
    ownerKey: "different-key",
    tool: "windows_development",
    action: "test",
    class: "default",
    resources: ["project:x"],
  });
  const mineOnly = store.list(ownerKey);
  assert.equal(mineOnly.length, 1);
  assert.equal(mineOnly[0].id, mine.id);
  const all = store.list();
  assert.equal(all.length, 2);
  assert.ok(all.some((r) => r.id === other.id));
});

test("atomic metadata replacement does not leave partial files", () => {
  const store = new DevelopmentTaskStore(path.join(root, "f"));
  const created = create(store);
  store.update(created.id, "queued", { state: "running" });
  store.update(created.id, "running", { state: "succeeded" });
  assert.equal(store.get(created.id)?.state, "succeeded");
});

test("corrupt metadata is quarantined and reported as missing", async () => {
  const dir = path.join(root, "g");
  const store = new DevelopmentTaskStore(dir);
  const created = create(store);
  await writeFile(store.metadataPath(created.id), "{ not valid json", "utf8");
  assert.equal(store.get(created.id), undefined);
  // The corrupt file should have been renamed aside.
  const entries = await import("node:fs/promises").then((m) => m.readdir(path.join(dir, created.id)));
  assert.ok(entries.some((name) => name.startsWith("metadata.json") === false && name.includes("corrupt")));
});

test("invalid task ids are rejected", () => {
  const store = new DevelopmentTaskStore(path.join(root, "h"));
  assert.throws(() => store.get("not-a-uuid"), /invalid task id/i);
  assert.throws(() => store.update("also-not-a-uuid", "queued", {}), /invalid task id/i);
});

test("launch spec is persisted mode 0600 and rejects sensitive env", () => {
  const store = new DevelopmentTaskStore(path.join(root, "i"));
  const created = create(store);
  store.saveLaunchSpec(created.id, {
    executable: process.execPath,
    args: ["-v"],
    cwd: root,
    env: { PATH: "/usr/bin" },
    timeoutMs: 1000,
    successExitCodes: [0],
  });
  const spec = store.loadLaunchSpec(created.id);
  assert.equal(spec?.executable, process.execPath);
  assert.throws(
    () =>
      store.saveLaunchSpec(created.id, {
        executable: process.execPath,
        args: [],
        cwd: root,
        env: { MY_PASSWORD: "hunter2" },
        timeoutMs: 1000,
        successExitCodes: [0],
      }),
    /sensitive env/i,
  );
});

test("loadLaunchSpec rejects a tampered executable", async () => {
  const store = new DevelopmentTaskStore(path.join(root, "j"));
  const created = create(store);
  await writeFile(store.launchPath(created.id), JSON.stringify({
    executable: "cmd.exe",
    args: ["/c", "whoami"],
    cwd: root,
    env: {},
    timeoutMs: 1000,
    successExitCodes: [0],
  }));
  assert.throws(() => store.loadLaunchSpec(created.id), /absolute|invalid launch/i);
});
