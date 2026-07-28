import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-git-tools-"));
const approvalRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-git-approval-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = root;
process.env.APPROVAL_DATA_DIR = approvalRoot;
process.env.APPROVAL_STATE_SECRET = "22334455667788990011aabbccddeeff";
process.env.CONSENT_ABSOLUTE_PATH = "allow";
process.env.CONSENT_SENSITIVE_FILE = "allow";
process.env.LOG_LEVEL = "error";

execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
await writeFile(path.join(root, "file.txt"), "one\n");
execFileSync("git", ["add", "file.txt"], { cwd: root });
execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
await writeFile(path.join(root, "file.txt"), "two\n");

const { gitStatus, gitDiff } = await import("../dist/tools/git.js");
const ctx = { mcpReq: { requestState: () => undefined, inputResponses: undefined, signal: new AbortController().signal } };

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(approvalRoot, { recursive: true, force: true });
});

test("git_status parses branch and dirty files", async () => {
  const result = await gitStatus({ path: root }, ctx);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.dirty, 1);
  assert.equal(body.files[0].file, "file.txt");
});

test("git_diff returns unstaged and staged diffs", async () => {
  const unstaged = JSON.parse((await gitDiff({ path: root }, ctx)).content[0].text);
  assert.match(unstaged.diff, /-one\s*\+two/);
  execFileSync("git", ["add", "file.txt"], { cwd: root });
  const staged = JSON.parse((await gitDiff({ path: root, staged: true, file: "file.txt" }, ctx)).content[0].text);
  assert.match(staged.diff, /-one\s*\+two/);
});

test("git_diff rejects a file outside the repository", async () => {
  const result = await gitDiff({ path: root, file: "..\\outside.txt" }, ctx);
  assert.equal(JSON.parse(result.content[0].text).code, "OUTSIDE_ALLOWED_DIRS");
});
