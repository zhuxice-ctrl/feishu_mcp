import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

// AUTH_MODE=none keeps the subprocess from requiring AUTH_PIN, while still
// exercising the real config module on a clean import.
process.env.AUTH_MODE = "none";
process.env.LOG_LEVEL = "error";

function readConfig(env) {
  const script =
    "import('./dist/config.js').then(c=>console.log(JSON.stringify({total:c.DEV_MAX_TASKS,builds:c.DEV_MAX_BUILDS,days:c.DEV_TASK_RETENTION_DAYS,runtime:c.DEV_TASK_MAX_RUNTIME_MS,dir:c.DEV_TASK_DATA_DIR})))";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result;
}

test("development configuration exposes bounded defaults inside the approval data dir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-config-"));
  try {
    const result = readConfig({ APPROVAL_DATA_DIR: root, DEV_TASK_DATA_DIR: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      total: 4,
      builds: 2,
      days: 14,
      runtime: 7_200_000,
      dir: path.join(root, "tasks"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development configuration accepts in-bound overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-config-over-"));
  try {
    const result = readConfig({
      APPROVAL_DATA_DIR: root,
      DEV_TASK_DATA_DIR: path.join(root, "tasks"),
      DEV_MAX_TASKS: "16",
      DEV_MAX_BUILDS: "8",
      DEV_TASK_RETENTION_DAYS: "365",
      DEV_TASK_MAX_RUNTIME_MS: String(24 * 60 * 60_000),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      total: 16,
      builds: 8,
      days: 365,
      runtime: 24 * 60 * 60_000,
      dir: path.join(root, "tasks"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration rejects task limits above their ceilings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-config-max-"));
  try {
    const over = (extra) =>
      readConfig({ APPROVAL_DATA_DIR: root, DEV_TASK_DATA_DIR: "", ...extra });
    assert.notEqual(over({ DEV_MAX_TASKS: "17" }).status, 0);
    assert.notEqual(over({ DEV_MAX_BUILDS: "9" }).status, 0);
    assert.notEqual(over({ DEV_TASK_RETENTION_DAYS: "366" }).status, 0);
    assert.notEqual(over({ DEV_TASK_MAX_RUNTIME_MS: String(24 * 60 * 60_000 + 1) }).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration rejects a task data directory outside APPROVAL_DATA_DIR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-config-out-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-config-outside-"));
  try {
    const result = readConfig({
      APPROVAL_DATA_DIR: root,
      DEV_TASK_DATA_DIR: outside,
    });
    assert.notEqual(result.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
