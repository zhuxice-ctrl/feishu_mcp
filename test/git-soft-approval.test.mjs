import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "git-soft-approval-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = dataDir;
process.env.APPROVAL_STATE_SECRET = "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "error";

const { runWithRequestContext } = await import("../dist/security/requestContext.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const {
  createGitConfirmation,
  consumeGitConfirmation,
} = await import("../dist/security/gitSoftApproval.js");

function context() {
  return {
    mcpReq: {
      envelope: undefined,
      requestState: () => undefined,
      inputResponses: undefined,
      signal: new AbortController().signal,
    },
  };
}

function request() {
  return {
    userId: "owner",
    command: "git reset --hard HEAD~1",
    workdir: path.resolve(dataDir),
    timeoutMs: 30_000,
  };
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

function asUser(userId, fn) {
  return runWithRequestContext({ token: "", userId, email: null }, fn);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function issue(name = "default") {
  const item = { ...request(), workdir: path.join(dataDir, name) };
  const result = await asUser("owner", () => createGitConfirmation(context(), item));
  return { item, issued: body(result) };
}

test.after(async () => rm(dataDir, { recursive: true, force: true }));

test("Git confirmation is signed, exact, and single use", async () => {
  const { item: pending, issued } = await issue("single-use");

  assert.equal(issued.ok, false);
  assert.equal(issued.code, "GIT_CONFIRMATION_REQUIRED");
  assert.match(issued.gitConfirmation.token, /\S+/);
  assert.equal(issued.gitConfirmation.retryOriginalCall, true);

  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), issued.gitConfirmation.token, pending)),
    true,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), issued.gitConfirmation.token, pending)),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), issued.gitConfirmation.token, {
      ...pending,
      command: "git reset --hard HEAD~1 --no-recurse-submodules",
    })),
    false,
  );
});

test("Git confirmation rejects a different owner, workdir, timeout, and malformed token", async () => {
  const { item: pending, issued } = await issue("mismatches");
  const token = issued.gitConfirmation.token;

  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), token, {
      ...pending,
      userId: "other",
    })),
    false,
  );
  assert.equal(
    await asUser("other", () => consumeGitConfirmation(context(), token, pending)),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), token, {
      ...pending,
      command: "git reset --hard HEAD~1 --no-recurse-submodules",
    })),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), token, {
      ...pending,
      workdir: path.join(dataDir, "other-workdir"),
    })),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), token, {
      ...pending,
      timeoutMs: pending.timeoutMs + 1,
    })),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), "not-a-signed-token", pending)),
    false,
  );
  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), token, pending)),
    true,
  );
});

test("Git confirmation rejects an expired signed payload without throwing", async () => {
  const pending = { ...request(), workdir: path.join(dataDir, "expired") };
  const expiredToken = await asUser("owner", () => approvalStateCodec.mint({
    version: 1,
    kind: "git_confirmation",
    userId: pending.userId,
    commandDigest: digest(pending.command),
    workdirDigest: digest(path.resolve(pending.workdir)),
    timeoutMs: pending.timeoutMs,
    nonce: "expired-nonce",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }, context()));

  assert.equal(
    await asUser("owner", () => consumeGitConfirmation(context(), expiredToken, pending)),
    false,
  );
});
