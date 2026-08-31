import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function readConfig(overrides = {}) {
  const source = "const c=await import('./dist/config.js');process.stdout.write(JSON.stringify({approval:c.APPROVAL_DATA_DIR,data:c.TEXT_TRANSFER_DATA_DIR,chunk:c.TEXT_TRANSFER_CHUNK_BYTES,max:c.TEXT_TRANSFER_MAX_BYTES,ttl:c.TEXT_TRANSFER_TTL_MS,sessions:c.TEXT_TRANSFER_MAX_SESSIONS}));";
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: projectDir,
    env: { ...process.env, AUTH_MODE: "none", AUTH_PIN: "", APPROVAL_DATA_DIR: path.join(projectDir, ".tmp-text-transfer-approval-data"), ...overrides },
    encoding: "utf8",
  });
}

test("text transfer configuration is bounded and protected by approval data", () => {
  const result = readConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.chunk, 48 * 1024);
  assert.equal(config.max, 5 * 1024 * 1024);
  assert.equal(config.ttl, 60 * 60 * 1000);
  assert.equal(config.sessions, 16);
  assert.equal(config.data, path.join(config.approval, "text-transfers"));
});

test("text transfer data directory cannot escape approval data", () => {
  const result = readConfig({ TEXT_TRANSFER_DATA_DIR: path.resolve(projectDir, "..", "outside-text-transfer") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEXT_TRANSFER_DATA_DIR.*inside APPROVAL_DATA_DIR/i);
});
