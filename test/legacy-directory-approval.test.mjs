import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const moduleDataDir = await mkdtemp(path.join(os.tmpdir(), "legacy-approval-module-"));
process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";
process.env.ALLOWED_DIRS = "";
process.env.OWNER_USER_ID = "owner";
process.env.OWNER_DEFAULT_DIRS = "";
process.env.DIRECTORY_APPROVAL_FALLBACK = "owner";
process.env.APPROVAL_DATA_DIR = moduleDataDir;
process.env.APPROVAL_STATE_SECRET = "0123456789abcdef0123456789abcdef";

const { toolError } = await import("../dist/tools/results.js");
const { DirectoryGrantStore } = await import("../dist/security/directoryGrantStore.js");
const { digestDirectoryRoots } = await import("../dist/security/directoryRoots.js");
const { runWithRequestContext } = await import("../dist/security/requestContext.js");
const {
  LegacyDirectoryOnceStore,
  createLegacyDirectoryChallenge,
  submitLegacyDirectoryDecision,
} = await import("../dist/security/legacyDirectoryApproval.js");

function context(userId = "owner") {
  return {
    mcpReq: {
      envelope: undefined,
      requestState: () => undefined,
      inputResponses: undefined,
      signal: new AbortController().signal,
    },
    userId,
  };
}

function asUser(userId, fn) {
  return runWithRequestContext({ token: "", userId, email: null }, fn);
}

async function fixture(name) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `legacy-approval-${name}-`));
  const root = { logicalRoot: path.join(dataDir, "outside"), physicalRoot: path.join(dataDir, "outside") };
  return {
    dataDir,
    root,
    store: new DirectoryGrantStore({ dataDir, staticRoots: [], ownerUserId: "owner", ownerRoots: [] }),
    request: { tool: "read_file", userId: "owner", argsDigest: `args-${name}`, access: "read", roots: [root] },
  };
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

test("legacy directory errors preserve structured approval details", () => {
  const result = toolError(
    "DIRECTORY_APPROVAL_REQUIRED",
    "approval required",
    true,
    { directoryApproval: { challenge: "opaque", decisions: ["allow_once"] } },
  );
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: "DIRECTORY_APPROVAL_REQUIRED",
    message: "approval required",
    retryable: true,
    directoryApproval: { challenge: "opaque", decisions: ["allow_once"] },
  });
});

test("legacy error details cannot override stable error fields", () => {
  const result = toolError("DIRECTORY_APPROVAL_REQUIRED", "stable", true, {
    ok: true,
    code: "INTERNAL_ERROR",
    message: "changed",
    retryable: false,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: "DIRECTORY_APPROVAL_REQUIRED",
    message: "stable",
    retryable: true,
  });
});

for (const [decision, expected] of [
  ["allow_once", { once: true, session: 0, permanent: 0 }],
  ["allow_session", { once: false, session: 1, permanent: 0 }],
  ["allow_permanent", { once: false, session: 0, permanent: 1 }],
]) {
  test(`${decision} records the exact legacy owner decision`, async () => {
    const item = await fixture(decision);
    const once = new LegacyDirectoryOnceStore();
    try {
      const challengeResult = await asUser("owner", () =>
        createLegacyDirectoryChallenge(context(), item.request, item.request.roots));
      const challenge = body(challengeResult).directoryApproval.challenge;
      const submitted = await asUser("owner", () =>
        submitLegacyDirectoryDecision(context(), challenge, decision, item.store, once));
      assert.equal(body(submitted).ok, true);
      assert.deepEqual(item.store.summary(), { session: expected.session, permanent: expected.permanent });
      const match = {
        userId: "owner",
        tool: item.request.tool,
        argsDigest: item.request.argsDigest,
        rootsDigest: digestDirectoryRoots(item.request.roots),
      };
      assert.equal(Boolean(once.consume(match)), expected.once);
      assert.equal(once.consume(match), null);
    } finally {
      await rm(item.dataDir, { recursive: true, force: true });
    }
  });
}

test("deny consumes the challenge without storing a grant", async () => {
  const item = await fixture("deny");
  const once = new LegacyDirectoryOnceStore();
  try {
    const challengeResult = await asUser("owner", () =>
      createLegacyDirectoryChallenge(context(), item.request, item.request.roots));
    const challenge = body(challengeResult).directoryApproval.challenge;
    const denied = await asUser("owner", () =>
      submitLegacyDirectoryDecision(context(), challenge, "deny", item.store, once));
    assert.equal(body(denied).code, "DIRECTORY_APPROVAL_DENIED");
    assert.deepEqual(item.store.summary(), { session: 0, permanent: 0 });
    const replay = await asUser("owner", () =>
      submitLegacyDirectoryDecision(context(), challenge, "allow_session", item.store, once));
    assert.equal(body(replay).code, "APPROVAL_DENIED");
  } finally {
    await rm(item.dataDir, { recursive: true, force: true });
  }
});

test("a challenge is bound to owner identity and rejects tampering", async () => {
  const item = await fixture("binding");
  try {
    const challengeResult = await asUser("owner", () =>
      createLegacyDirectoryChallenge(context(), item.request, item.request.roots));
    const challenge = body(challengeResult).directoryApproval.challenge;
    const other = await asUser("other", () =>
      submitLegacyDirectoryDecision(context("other"), challenge, "allow_session", item.store));
    assert.equal(body(other).code, "APPROVAL_DENIED");
    const tampered = await asUser("owner", () =>
      submitLegacyDirectoryDecision(context(), `${challenge}x`, "allow_session", item.store));
    assert.equal(body(tampered).code, "APPROVAL_DENIED");
    assert.deepEqual(item.store.summary(), { session: 0, permanent: 0 });
  } finally {
    await rm(item.dataDir, { recursive: true, force: true });
  }
});

test("one-shot storage ignores mismatches and a fresh store has no grants", async () => {
  const once = new LegacyDirectoryOnceStore();
  const root = { logicalRoot: path.resolve("outside"), physicalRoot: path.resolve("outside") };
  const exact = { userId: "owner", tool: "read_file", argsDigest: "a", rootsDigest: "r" };
  once.remember(exact, [root], Date.now() + 60_000);
  assert.equal(once.consume({ ...exact, tool: "write_file" }), null);
  assert.deepEqual(once.consume(exact), [root]);
  assert.equal(once.consume(exact), null);
  assert.equal(new LegacyDirectoryOnceStore().consume(exact), null);
});

test.after(async () => {
  await rm(moduleDataDir, { recursive: true, force: true });
});
