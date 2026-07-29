import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "directory-path-guard-"));
const ownerRoot = path.join(root, "owner");
const outsideRoot = path.join(root, "outside");
const approvalDataDir = path.join(root, "approval-data");
await mkdir(ownerRoot);
await mkdir(outsideRoot);
await mkdir(approvalDataDir);

process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = "";
process.env.OWNER_USER_ID = "owner";
process.env.OWNER_DEFAULT_DIRS = ownerRoot;
process.env.APPROVAL_DATA_DIR = approvalDataDir;
process.env.APPROVAL_STATE_SECRET = "0123456789abcdef0123456789abcdef";
process.env.CONSENT_ABSOLUTE_PATH = "confirm";
process.env.CONSENT_SENSITIVE_FILE = "confirm";

const { DirectoryGrantStore } = await import("../dist/security/directoryGrantStore.js");
const { canonicalizeDirectoryScope } = await import("../dist/security/directoryRoots.js");
const { inspectPathBoundary } = await import("../dist/security/pathGuard.js");
const { resolveGuardAndAuthorize, resolvePathsGuardAndAuthorize } =
  await import("../dist/tools/helpers.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const { runWithRequestContext } = await import("../dist/security/requestContext.js");

test.after(async () => rm(root, { recursive: true, force: true }));

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

function asOwner(fn) {
  return runWithRequestContext({ token: "", userId: "owner", email: null }, fn);
}

test("owner defaults apply only to the configured owner", () => {
  const store = new DirectoryGrantStore({
    dataDir: approvalDataDir,
    ownerUserId: "owner",
    ownerRoots: [canonicalizeDirectoryScope(ownerRoot, "directory")],
  });
  const file = path.join(ownerRoot, "file.txt");
  const owner = inspectPathBoundary(file, "owner", store);
  const other = inspectPathBoundary(file, "other", store);
  assert.equal(owner.status, "allowed");
  assert.equal(owner.matchedRoot.source, "owner_default");
  assert.equal(other.status, "outside");
});

test("relative paths resolve against the first effective root", () => {
  const store = new DirectoryGrantStore({
    dataDir: approvalDataDir,
    ownerUserId: "owner",
    ownerRoots: [canonicalizeDirectoryScope(ownerRoot, "directory")],
  });
  const result = inspectPathBoundary(path.join("nested", "file.txt"), "owner", store);
  assert.equal(result.status, "allowed");
  assert.equal(result.logicalPath, path.join(ownerRoot, "nested", "file.txt"));
});

test("approval data is denied before any directory request", () => {
  const store = new DirectoryGrantStore({
    dataDir: approvalDataDir,
    staticRoots: [canonicalizeDirectoryScope(root, "directory")],
  });
  assert.deepEqual(inspectPathBoundary(path.join(approvalDataDir, "approval.key"), "owner", store), {
    status: "denied",
    code: "SENSITIVE_PATH",
    message: "The internal approval directory is protected.",
  });
});

test("physical junction escapes require a grant for the real target", async () => {
  const link = path.join(ownerRoot, "outside-link");
  await symlink(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
  const store = new DirectoryGrantStore({
    dataDir: approvalDataDir,
    ownerUserId: "owner",
    ownerRoots: [canonicalizeDirectoryScope(ownerRoot, "directory")],
  });
  assert.equal(inspectPathBoundary(path.join(link, "file.txt"), "owner", store).status, "outside");
  store.rememberSessionBatch("owner", [canonicalizeDirectoryScope(link, "directory")]);
  const allowed = inspectPathBoundary(path.join(link, "file.txt"), "owner", store);
  assert.equal(allowed.status, "allowed");
  assert.equal(allowed.matchedRoot.source, "session");
});

test("batch authorization sends every outside scope in one request", async () => {
  const source = path.join(outsideRoot, "source", "file.txt");
  const destination = path.join(outsideRoot, "destination", "file.txt");
  const requested = [];
  const inputRequiredResult = {
    resultType: "input_required",
    inputRequests: { directory_approval: { method: "elicitation/create", params: {} } },
    requestState: "signed-state",
  };
  const store = new DirectoryGrantStore({ dataDir: approvalDataDir });
  const result = await asOwner(() => resolvePathsGuardAndAuthorize(
    "move_file",
    [
      { argName: "source", inputPath: source, operation: "write", scope: "file" },
      { argName: "destination", inputPath: destination, operation: "write", scope: "file" },
    ],
    { source, destination },
    context(),
    {
      store,
      authorize: async (request) => {
        requested.push(request);
        return inputRequiredResult;
      },
    },
  ));
  assert.equal(result.ok, false);
  assert.equal(result.result, inputRequiredResult);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].roots.length, 2);
});

test("allow_once survives one downstream sensitive-file approval", async () => {
  const sensitive = path.join(outsideRoot, ".env");
  await writeFile(sensitive, "generated-test-value");
  const args = { path: sensitive };

  const first = await asOwner(() => resolveGuardAndAuthorize(
    "read_file", "path", sensitive, "read", args, context(),
    { scope: "file", access: "read" },
  ));
  assert.equal(first.ok, false);
  assert.equal(first.result.resultType, "input_required");
  assert.deepEqual(Object.keys(first.result.inputRequests), ["directory_approval"]);

  const directoryState = await asOwner(() =>
    approvalStateCodec.verify(first.result.requestState, context()));
  const afterDirectory = await asOwner(() => resolveGuardAndAuthorize(
    "read_file", "path", sensitive, "read", args,
    context(directoryState, {
      directory_approval: { action: "accept", content: { decision: "allow_once" } },
    }),
    { scope: "file", access: "read" },
  ));
  assert.equal(afterDirectory.ok, false);
  assert.equal(afterDirectory.result.resultType, "input_required");
  assert.deepEqual(Object.keys(afterDirectory.result.inputRequests), ["approval"]);

  const operationState = await asOwner(() =>
    approvalStateCodec.verify(afterDirectory.result.requestState, context()));
  assert.match(operationState.authorizedDirectoryRootsDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(operationState.nonce, directoryState.nonce);

  const final = await asOwner(() => resolveGuardAndAuthorize(
    "read_file", "path", sensitive, "read", args,
    context(operationState, {
      approval: { action: "accept", content: { decision: "allow_once" } },
    }),
    { scope: "file", access: "read" },
  ));
  assert.equal(final.ok, true, final.error);
  assert.equal(final.resolvedPath, sensitive);

  const replay = await asOwner(() => resolveGuardAndAuthorize(
    "read_file", "path", sensitive, "read", args,
    context(operationState, {
      approval: { action: "accept", content: { decision: "allow_once" } },
    }),
    { scope: "file", access: "read" },
  ));
  assert.equal(replay.ok, false);
  assert.equal(JSON.parse(replay.result.content[0].text).code, "APPROVAL_DENIED");
});
