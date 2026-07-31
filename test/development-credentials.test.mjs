import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { LocalCredentialStore } from "../dist/development/credentials/dpapiStore.js";
import {
  CredentialResolutionError,
  InMemoryCredentialResolver,
  WindowsDpapiCredentialResolver,
} from "../dist/development/credentials/dpapiStore.js";

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

test("Windows DPAPI resolver uses only the fixed helper, shell false, and an isolated environment", () => {
  const calls = [];
  const secret = "\ufeffp\u00e4ssword with trailing newline\n";
  const approvalDataDir = path.resolve(tmpDir(), "approval-data");
  const resolver = new WindowsDpapiCredentialResolver(approvalDataDir, (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, stdout: Buffer.from(secret, "utf8"), stderr: Buffer.alloc(0) };
  });

  const values = resolver.resolveRefs({ FEISHU_MCP_KS_PASS: "11111111-1111-4111-8111-111111111111" });
  assert.equal(values.get("FEISHU_MCP_KS_PASS"), secret, "secret bytes must not be trimmed");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.APPROVAL_DATA_DIR, approvalDataDir);
  assert.equal(call.options.env.MCP_AUTH_TOKEN, undefined);
  assert.equal(call.options.env.FEISHU_MCP_WORKER_TOKEN, undefined);
  assert.equal(call.args.includes("-Command"), false);
  assert.deepEqual(call.args.slice(-2), ["-CredentialId", "11111111-1111-4111-8111-111111111111"]);
  const fileIndex = call.args.indexOf("-File");
  assert.ok(fileIndex >= 0);
  assert.equal(call.args[fileIndex + 1], path.resolve("scripts", "resolve-development-credential.ps1"));
  assert.equal(call.options.maxBuffer, 4096);
});

test("Windows DPAPI resolver resolves a repeated id only once", () => {
  let calls = 0;
  const resolver = new WindowsDpapiCredentialResolver("C:\\approval-data", () => {
    calls += 1;
    return { status: 0, stdout: Buffer.from("same-secret"), stderr: Buffer.alloc(0) };
  });
  const values = resolver.resolveRefs({
    FIRST_SECRET: "11111111-1111-4111-8111-111111111111",
    SECOND_SECRET: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(calls, 1);
  assert.equal(values.get("FIRST_SECRET"), "same-secret");
  assert.equal(values.get("SECOND_SECRET"), "same-secret");
});

test("Windows DPAPI resolver returns one stable generic failure for every failure mode", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const cases = [
    ["malformed id", { BAD_SECRET: "..\\outside.blob" }, () => ({ status: 0, stdout: Buffer.from("x"), stderr: Buffer.alloc(0) })],
    ["missing blob", { BAD_SECRET: id }, () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })],
    ["helper diagnostics", { BAD_SECRET: id }, () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("private path and id") })],
    ["stderr on success", { BAD_SECRET: id }, () => ({ status: 0, stdout: Buffer.from("x"), stderr: Buffer.from("warning") })],
    ["invalid UTF-8", { BAD_SECRET: id }, () => ({ status: 0, stdout: Buffer.from([0xc3, 0x28]), stderr: Buffer.alloc(0) })],
    ["NUL cannot enter an environment value", { BAD_SECRET: id }, () => ({ status: 0, stdout: Buffer.from("before\0after"), stderr: Buffer.alloc(0) })],
    ["output cap", { BAD_SECRET: id }, () => ({ status: 0, stdout: Buffer.alloc(4_097, 0x61), stderr: Buffer.alloc(0) })],
    ["runner timeout", { BAD_SECRET: id }, () => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("timed out at a private path"), { code: "ETIMEDOUT" }) })],
  ];
  for (const [name, refs, runner] of cases) {
    const resolver = new WindowsDpapiCredentialResolver("C:\\private\\approval", runner);
    assert.throws(
      () => resolver.resolveRefs(refs),
      (error) => {
        assert.ok(error instanceof CredentialResolutionError, name);
        assert.equal(error.code, "CREDENTIAL_UNAVAILABLE", name);
        assert.equal(error.message, "credential unavailable", name);
        assert.doesNotMatch(String(error), /11111111|outside|private|warning|timed out/i, name);
        return true;
      },
    );
  }
});
