import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const { redact } = await import("../dist/android-workflow/redaction.js");
const { StateStore } = await import("../dist/android-workflow/stateStore.js");

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redacts bearer, cookie, PIN, and Windows user values", () => {
  const safe = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 PIN=12345678 C:\\Users\\Lenovo\\secret");
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz123456|12345678|Lenovo/);
});

test("redacts cookie values", () => {
  const safe = redact("Cookie: session=supersecretcookievalue123");
  assert.doesNotMatch(safe, /supersecretcookievalue123/);
  assert.match(safe, /\[REDACTED\]/);
});

test("redacts private keys", () => {
  const safe = redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----");
  assert.doesNotMatch(safe, /MIIEpAIBAAKCAQEA/);
  assert.match(safe, /\[REDACTED PRIVATE KEY\]/);
});

test("redacts generic token assignments", () => {
  const safe = redact("token=abcdefghijklmnop1234567890");
  assert.doesNotMatch(safe, /abcdefghijklmnop1234567890/);
  assert.match(safe, /\[REDACTED\]/);
});

test("redacts basic auth headers", () => {
  const safe = redact("Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=");
  assert.doesNotMatch(safe, /dXNlcjpwYXNzd29yZDEyMzQ=/);
  assert.match(safe, /\[REDACTED\]/);
});

test("redact handles non-string input gracefully", () => {
  assert.equal(redact(undefined), "");
  assert.equal(redact(null), "");
  assert.equal(redact(123), "");
});

test("does not redact non-sensitive content", () => {
  const safe = redact("emulator-5554 device is ready");
  assert.equal(safe, "emulator-5554 device is ready");
});

// ---------------------------------------------------------------------------
// StateStore — atomic save, load, resume, terminal cleanup
// ---------------------------------------------------------------------------

let tempDir;

test.before(async () => {
  tempDir = path.join(os.tmpdir(), `wf-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tempDir, { recursive: true });
});

test.after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("save creates an atomic checkpoint and load retrieves it", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r1", state: "tunnel_connected", profileVersion: 1 });
  const loaded = await store.load("r1");
  assert.equal(loaded.state, "tunnel_connected");
  assert.equal(loaded.profileVersion, 1);
  assert.equal(loaded.runId, "r1");
  assert.ok(loaded.timestamp, "timestamp should be present");
});

test("load returns null for unknown runId", async () => {
  const store = new StateStore(tempDir);
  assert.equal(await store.load("nonexistent-run"), null);
});

test("resumes the latest valid checkpoint and removes only terminal state", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r2", state: "tunnel_connected", profileVersion: 1 });
  assert.equal((await store.load("r2")).state, "tunnel_connected");
  await store.finish("r2");
  assert.equal(await store.load("r2"), null);
});

test("save rejects invalid state transitions", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r3", state: "created", profileVersion: 1 });
  // created → app_ready is not a valid transition (must go through preflight_passed)
  await assert.rejects(
    () => store.save({ runId: "r3", state: "app_ready", profileVersion: 1 }),
    /invalid transition/,
  );
  // the original checkpoint should be unchanged after a rejected save
  assert.equal((await store.load("r3")).state, "created");
});

test("save allows valid sequential transitions", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r4", state: "created", profileVersion: 1 });
  await store.save({ runId: "r4", state: "preflight_passed", profileVersion: 1 });
  await store.save({ runId: "r4", state: "tunnel_connected", profileVersion: 1 });
  assert.equal((await store.load("r4")).state, "tunnel_connected");
});

test("save rejects unknown states", async () => {
  const store = new StateStore(tempDir);
  await assert.rejects(
    () => store.save({ runId: "r5", state: "bogus_state", profileVersion: 1 }),
    /unknown state/,
  );
});

test("checkpoint metadata values are redacted before storage", async () => {
  const store = new StateStore(tempDir);
  await store.save({
    runId: "r6",
    state: "created",
    profileVersion: 1,
    metadata: {
      authHeader: "Authorization: Bearer secrettoken12345678",
      userPath: "C:\\Users\\Admin\\config",
    },
  });
  const loaded = await store.load("r6");
  assert.doesNotMatch(loaded.metadata.authHeader, /secrettoken12345678/);
  assert.doesNotMatch(loaded.metadata.userPath, /Admin/);
  assert.match(loaded.metadata.authHeader, /\[REDACTED\]/);
});

test("finish on non-existent runId does not throw", async () => {
  const store = new StateStore(tempDir);
  await assert.doesNotReject(() => store.finish("never-existed"));
});

test("runId with special characters is sanitized for filename safety", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "run/with/../traversal", state: "created", profileVersion: 1 });
  const loaded = await store.load("run/with/../traversal");
  assert.equal(loaded.state, "created");
  // ensure no file escaped tempDir via path traversal
  const files = await fs.readdir(tempDir);
  for (const f of files) {
    assert.ok(!f.includes(".."), `unexpected filename: ${f}`);
  }
});

test("atomic write leaves no temp file on success", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r7", state: "created", profileVersion: 1 });
  const files = await fs.readdir(tempDir);
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "temp file should not remain after successful save");
});
