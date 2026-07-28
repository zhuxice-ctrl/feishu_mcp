import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspace = await mkdtemp(path.join(os.tmpdir(), "feishu-command-tool-"));
const approvalRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-command-approval-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = workspace;
process.env.APPROVAL_DATA_DIR = approvalRoot;
process.env.APPROVAL_STATE_SECRET = "00112233445566778899aabbccddeeff";
process.env.LOG_LEVEL = "error";

const { executeCommand } = await import("../dist/tools/command.js");

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
  await rm(approvalRoot, { recursive: true, force: true });
});

test("executes a strictly read-only command without approval", async () => {
  const command = process.platform === "win32" ? "dir" : "pwd";
  const result = await executeCommand({ command, workdir: workspace }, context());
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.risk, "read_only");
  assert.equal(body.exitCode, 0);
});

test("returns input_required for a risky command on a modern client", async () => {
  const result = await executeCommand(
    { command: `${process.execPath} --version`, workdir: workspace },
    context(),
  );
  assert.equal(result.resultType, "input_required");
  assert.ok(result.requestState);
});

test("denies a risky command when elicitation is unsupported", async () => {
  const result = await executeCommand(
    { command: `${process.execPath} --version`, workdir: workspace },
    context(false),
  );
  assert.equal(JSON.parse(result.content[0].text).code, "CLIENT_ELICITATION_UNSUPPORTED");
});
