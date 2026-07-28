import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-diff-tool-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = root;
process.env.APPROVAL_DATA_DIR = path.join(root, ".approval-state");
process.env.APPROVAL_STATE_SECRET = "33445566778899001122aabbccddeeff";
process.env.CONSENT_ABSOLUTE_PATH = "allow";
process.env.CONSENT_SENSITIVE_FILE = "allow";
process.env.LOG_LEVEL = "error";

const a = path.join(root, "a.txt");
const b = path.join(root, "b.txt");
await writeFile(a, "same\n");
await writeFile(b, "same\n");
const { compareFiles } = await import("../dist/tools/diff.js");
const ctx = { mcpReq: { requestState: () => undefined, inputResponses: undefined, signal: new AbortController().signal } };

test.after(async () => rm(root, { recursive: true, force: true }));

test("reports identical files", async () => {
  const body = JSON.parse((await compareFiles({ path_a: a, path_b: b }, ctx)).content[0].text);
  assert.deepEqual({ identical: body.identical, diff: body.diff, exitCode: body.exitCode }, { identical: true, diff: "", exitCode: 0 });
});

test("returns unified diff for different files", async () => {
  await writeFile(b, "changed\n");
  const body = JSON.parse((await compareFiles({ path_a: a, path_b: b }, ctx)).content[0].text);
  assert.equal(body.identical, false);
  assert.match(body.diff, /^--- /m);
  assert.match(body.diff, /-same/);
  assert.match(body.diff, /\+changed/);
  assert.equal(body.exitCode, 1);
});
