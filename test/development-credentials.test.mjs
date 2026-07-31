import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { LocalCredentialStore } from "../dist/development/credentials/dpapiStore.js";
import { InMemoryCredentialResolver } from "../dist/development/credentials/dpapiStore.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "creds-"));
}

test("register returns an opaque credential id", () => {
  const store = new LocalCredentialStore(tmpDir());
  const c = store.register({ kind: "keystore", alias: "release", fingerprint: "ab:cd" });
  assert.ok(typeof c.id === "string");
  assert.match(c.id, /^[0-9a-f-]{36}$/); // uuid-like
});

test("list returns only non-secret metadata", () => {
  const dir = tmpDir();
  const store = new LocalCredentialStore(dir);
  store.register({ kind: "keystore", alias: "release", fingerprint: "ab:cd" });
  const list = store.list();
  assert.equal(list.length, 1);
  const meta = list[0];
  assert.ok(meta.id);
  assert.equal(meta.kind, "keystore");
  assert.equal(meta.alias, "release");
  assert.equal(meta.fingerprint, "ab:cd");
  assert.ok(meta.createdAt);
  // no secret field exposed
  assert.ok(!("secret" in meta) && !("value" in meta) && !("pass" in meta));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("store is owner-only on disk", () => {
  const dir = tmpDir();
  const store = new LocalCredentialStore(dir);
  store.register({ kind: "key", alias: "k", fingerprint: "01:02" });
  const stat = fs.statSync(path.join(dir, "credentials", "index.json"));
  // POSIX exposes the requested 0600 mode directly. Windows ACLs are not
  // represented by stat.mode, so the DPAPI/ACL PowerShell tests cover that
  // platform-specific boundary instead.
  if (process.platform !== "win32") assert.equal(stat.mode & 0o077, 0);
  else assert.equal(stat.isFile(), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("has returns true only for registered ids", () => {
  const store = new LocalCredentialStore(tmpDir());
  const c = store.register({ kind: "keystore", alias: "a", fingerprint: "x" });
  assert.equal(store.has(c.id), true);
  assert.equal(store.has("nope"), false);
});

test("remove deletes a credential metadata entry", () => {
  const dir = tmpDir();
  const store = new LocalCredentialStore(dir);
  const c = store.register({ kind: "keystore", alias: "a", fingerprint: "x" });
  store.remove(c.id);
  assert.equal(store.has(c.id), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("InMemoryCredentialResolver resolves refs without leaking secrets in toString", () => {
  const resolver = new InMemoryCredentialResolver();
  resolver.set("cred-1", "supersecret");
  const values = resolver.resolveRefs({ FEISHU_MCP_KS_PASS: "cred-1" });
  assert.equal(values.get("FEISHU_MCP_KS_PASS"), "supersecret");
  // resolver itself must not expose the secret via its metadata
  assert.ok(!resolver.describe().includes("supersecret"));
});

test("InMemoryCredentialResolver throws on unknown ref", () => {
  const resolver = new InMemoryCredentialResolver();
  assert.throws(() => resolver.resolveRefs({ X: "missing" }), /missing|unknown/i);
});

test("register rejects invalid kind", () => {
  const store = new LocalCredentialStore(tmpDir());
  assert.throws(() => store.register({ kind: "evil", alias: "a", fingerprint: "x" }), /kind/i);
});
