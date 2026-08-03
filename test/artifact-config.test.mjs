import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function readConfig(overrides = {}) {
  const source = [
    "const c = await import('./dist/config.js');",
    "process.stdout.write(JSON.stringify({",
    " approvalDataDir: c.APPROVAL_DATA_DIR,",
    " dataDir: c.BINARY_ARTIFACT_DATA_DIR,",
    " maxBytes: c.BINARY_ARTIFACT_MAX_BYTES,",
    " chunkBytes: c.BINARY_ARTIFACT_CHUNK_BYTES,",
    " uploadTtlMs: c.BINARY_ARTIFACT_UPLOAD_TTL_MS,",
    " maxUploads: c.BINARY_ARTIFACT_MAX_UPLOADS,",
    " maxBatch: c.BINARY_ARTIFACT_MAX_BATCH",
    "}));",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: projectDir,
    env: {
      ...process.env,
      AUTH_MODE: "none",
      AUTH_PIN: "",
      APPROVAL_DATA_DIR: path.join(projectDir, ".tmp-artifact-approval-data"),
      ...overrides,
    },
    encoding: "utf8",
  });
}

test("artifact configuration has bounded defaults inside approval data", () => {
  const result = readConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.maxBytes, 100 * 1024 * 1024);
  assert.equal(config.chunkBytes, 512 * 1024);
  assert.equal(config.uploadTtlMs, 15 * 60 * 1000);
  assert.equal(config.maxUploads, 8);
  assert.equal(config.maxBatch, 64);
  assert.equal(config.dataDir, path.join(config.approvalDataDir, "binary-artifacts"));
});

for (const [name, value, message] of [
  ["BINARY_ARTIFACT_MAX_BYTES", "1073741825", /BINARY_ARTIFACT_MAX_BYTES.*1073741824/i],
  ["BINARY_ARTIFACT_CHUNK_BYTES", "4194305", /BINARY_ARTIFACT_CHUNK_BYTES.*4194304/i],
  ["BINARY_ARTIFACT_UPLOAD_TTL_MS", "7200001", /BINARY_ARTIFACT_UPLOAD_TTL_MS.*7200000/i],
  ["BINARY_ARTIFACT_MAX_UPLOADS", "33", /BINARY_ARTIFACT_MAX_UPLOADS.*32/i],
  ["BINARY_ARTIFACT_MAX_BATCH", "257", /BINARY_ARTIFACT_MAX_BATCH.*256/i],
]) {
  test(`artifact configuration rejects ${name} above its maximum`, () => {
    const result = readConfig({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

test("artifact data directory must stay inside approval data", () => {
  const result = readConfig({ BINARY_ARTIFACT_DATA_DIR: path.resolve(projectDir, "..", "outside-artifacts") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BINARY_ARTIFACT_DATA_DIR.*inside APPROVAL_DATA_DIR/i);
});
