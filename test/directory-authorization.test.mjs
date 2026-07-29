import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-authorization-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = dataDir;
process.env.APPROVAL_STATE_SECRET = "0123456789abcdef0123456789abcdef";

const { DirectoryGrantStore } = await import("../dist/security/directoryGrantStore.js");
const { requestDirectoryAuthorization } = await import("../dist/security/directoryAuthorization.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const { toolError } = await import("../dist/tools/results.js");

test.after(async () => rm(dataDir, { recursive: true, force: true }));

function context(state, inputResponses, modern = true) {
  return {
    mcpReq: {
      envelope: modern ? {} : undefined,
      requestState: () => state,
      inputResponses,
      signal: new AbortController().signal,
    },
  };
}

function scope(name = "outside") {
  const root = path.join(dataDir, name);
  return { logicalRoot: root, physicalRoot: root };
}

function directoryRequest(roots = [scope()]) {
  return {
    tool: "read_file",
    userId: "owner",
    argsDigest: "args-digest",
    access: "read",
    roots,
  };
}

function errorCode(result) {
  return JSON.parse(result.content[0].text).code;
}

async function beginAndVerify(request, store, modern = true) {
  const first = await requestDirectoryAuthorization(context(undefined, undefined, modern), request, store);
  if (!modern) return first;
  assert.equal(first.resultType, "input_required");
  assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);
  const state = await approvalStateCodec.verify(first.requestState, context());
  return { first, state };
}

test("directory error codes serialize exactly and remain non-retryable", () => {
  for (const code of [
    "DIRECTORY_APPROVAL_DENIED",
    "DIRECTORY_GRANT_PERSIST_FAILED",
    "DIRECTORY_IDENTITY_REQUIRED",
  ]) {
    assert.deepEqual(JSON.parse(toolError(code, "message").content[0].text), {
      ok: false, code, message: "message", retryable: false,
    });
  }
});

test("outside roots emit one request and allow_once stores nothing", async () => {
  const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, "once") });
  const request = directoryRequest();
  const { state } = await beginAndVerify(request, store);
  const second = await requestDirectoryAuthorization(context(state, {
    directory_approval: { action: "accept", content: { decision: "allow_once" } },
  }), request, store);
  assert.equal(second.allowed, true);
  assert.equal(second.decision, "allow_once");
  assert.match(second.rootsDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
  assert.equal(errorCode(await requestDirectoryAuthorization(context(state, {
    directory_approval: { action: "accept", content: { decision: "allow_once" } },
  }), request, store)), "APPROVAL_DENIED");
});

for (const [decision, expected] of [
  ["allow_session", { session: 1, permanent: 0 }],
  ["allow_permanent", { session: 0, permanent: 1 }],
]) {
  test(`${decision} records the complete decision`, async () => {
    const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, decision) });
    const request = directoryRequest([scope(decision)]);
    const { state } = await beginAndVerify(request, store);
    const result = await requestDirectoryAuthorization(context(state, {
      directory_approval: { action: "accept", content: { decision } },
    }), request, store);
    assert.equal(result.allowed, true);
    assert.equal(result.decision, decision);
    assert.deepEqual(store.summary(), expected);
  });
}

for (const [label, input] of [
  ["deny", { directory_approval: { action: "accept", content: { decision: "deny" } } }],
  ["cancel", { directory_approval: { action: "cancel" } }],
  ["timeout", undefined],
]) {
  test(`${label} denies without storing a grant`, async () => {
    const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, label) });
    const request = directoryRequest([scope(label)]);
    const { state } = await beginAndVerify(request, store);
    const result = await requestDirectoryAuthorization(context(state, input), request, store);
    assert.equal(errorCode(result), "DIRECTORY_APPROVAL_DENIED");
    assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
  });
}

test("unsupported clients and missing identities fail safely", async () => {
  const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, "safe-failures") });
  assert.equal(errorCode(await beginAndVerify(directoryRequest(), store, false)), "CLIENT_ELICITATION_UNSUPPORTED");
  assert.equal(errorCode(await requestDirectoryAuthorization(context(), {
    ...directoryRequest(), userId: null,
  }, store)), "DIRECTORY_IDENTITY_REQUIRED");
});

test("changed signed fields cannot authorize a request", async () => {
  for (const mutation of [
    { userId: "other" },
    { tool: "write_file" },
    { argsDigest: "changed" },
    { rootsDigest: "changed" },
  ]) {
    const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, `mutation-${Object.keys(mutation)[0]}-${Math.random()}`) });
    const request = directoryRequest([scope(`mutation-${Object.keys(mutation)[0]}`)]);
    const { state } = await beginAndVerify(request, store);
    const result = await requestDirectoryAuthorization(context({ ...state, ...mutation }, {
      directory_approval: { action: "accept", content: { decision: "allow_once" } },
    }), request, store);
    assert.equal(errorCode(result), "APPROVAL_DENIED");
  }
});

test("persistence exceptions return a structured error and authorize nothing", async () => {
  const store = new DirectoryGrantStore({ dataDir: path.join(dataDir, "persist-failure") });
  store.rememberPermanentBatch = () => { throw new Error("disk full"); };
  const request = directoryRequest([scope("persist-failure")]);
  const { state } = await beginAndVerify(request, store);
  const result = await requestDirectoryAuthorization(context(state, {
    directory_approval: { action: "accept", content: { decision: "allow_permanent" } },
  }), request, store);
  assert.equal(errorCode(result), "DIRECTORY_GRANT_PERSIST_FAILED");
  assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
});
