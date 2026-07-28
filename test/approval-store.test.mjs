import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { ApprovalStore } = await import("../dist/security/approvalStore.js");

test("approval store isolates session grants and persists exact permanent grants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-approval-store-"));
  try {
    const store = new ApprovalStore(root);
    store.rememberSession("alice", "execute_command", "one");
    assert.equal(store.has("alice", "execute_command", "one"), true);
    assert.equal(store.has("bob", "execute_command", "one"), false);

    const record = store.rememberPermanent("alice", "web_fetch", "origin", "https://example.com:443", "example");
    const reloaded = new ApprovalStore(root);
    assert.equal(reloaded.has("alice", "web_fetch", "https://example.com:443"), true);
    assert.equal(reloaded.isInternalPath(path.join(root, "approval.key")), true);
    assert.equal(reloaded.isInternalPath(path.join(root, "..", "outside.txt")), false);
    assert.equal(reloaded.containsInternalPath(root), true);
    assert.equal(reloaded.containsInternalPath(path.join(root, "..", "outside")), false);
    assert.equal(reloaded.revoke(record.id), true);
    assert.equal(reloaded.has("alice", "web_fetch", "https://example.com:443"), false);
    const parsed = JSON.parse(await readFile(path.join(root, "approvals.json"), "utf8"));
    assert.deepEqual(parsed, { version: 1, approvals: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
