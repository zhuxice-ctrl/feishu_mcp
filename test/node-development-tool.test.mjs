import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspace = await mkdtemp(path.join(os.tmpdir(), "feishu-node-development-tool-"));
const outsideWorkspace = await mkdtemp(path.join(os.tmpdir(), "feishu-node-development-outside-"));
const approvalRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-node-development-approval-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = workspace;
process.env.APPROVAL_DATA_DIR = approvalRoot;
process.env.APPROVAL_STATE_SECRET = "00112233445566778899aabbccddeeff";
process.env.LOG_LEVEL = "error";

const { NODE_ACTIONS, nodeDevelopment, resolveNodeAction } =
  await import("../dist/tools/nodeDevelopment.js");

function context(modern = true) {
  return {
    mcpReq: {
      envelope: modern ? {} : undefined,
      requestState: () => undefined,
      inputResponses: undefined,
      signal: new AbortController().signal,
    },
  };
}

test.after(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outsideWorkspace, { recursive: true, force: true });
  await rm(approvalRoot, { recursive: true, force: true });
});

test("exports exactly the four approved PNPM actions", () => {
  assert.deepEqual(Object.keys(NODE_ACTIONS), [
    "pnpm_version", "test_run", "build", "typecheck",
  ]);
  assert.deepEqual(resolveNodeAction("pnpm_version"), {
    executable: "pnpm",
    args: ["--version"],
  });
  assert.deepEqual(resolveNodeAction("test_run"), {
    executable: "pnpm",
    args: ["test:run"],
  });
  assert.deepEqual(resolveNodeAction("build"), {
    executable: "pnpm",
    args: ["build"],
  });
  assert.deepEqual(resolveNodeAction("typecheck"), {
    executable: "pnpm",
    args: ["typecheck"],
  });
});

test("requires an explicit working directory", async () => {
  const result = await nodeDevelopment({ action: "pnpm_version" }, context());
  assert.equal(JSON.parse(result.content[0].text).code, "INVALID_ARGUMENT");
});

test("requests Aily approval before running an approved action", async () => {
  const result = await nodeDevelopment(
    { action: "pnpm_version", workdir: workspace },
    context(),
  );
  assert.equal(result.resultType, "input_required");
  assert.ok(result.requestState);
});

test("rejects an action outside the authorized directory before approval", async () => {
  const result = await nodeDevelopment(
    { action: "pnpm_version", workdir: outsideWorkspace },
    context(),
  );
  const body = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.match(body.code, /^DIRECTORY_/);
});

test("denies approved actions when the client cannot show an approval form", async () => {
  const result = await nodeDevelopment(
    { action: "pnpm_version", workdir: workspace },
    context(false),
  );
  assert.equal(JSON.parse(result.content[0].text).code, "CLIENT_ELICITATION_UNSUPPORTED");
});
