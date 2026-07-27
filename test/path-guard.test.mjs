import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-mcp-path-guard-"));
const allowed = path.join(root, "allowed");
const outside = path.join(root, "outside");
await mkdir(allowed);
await mkdir(outside);

process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = allowed;
const { validatePath } = await import("../dist/security/pathGuard.js");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("allows a missing target beneath a physical allowed directory", () => {
  const result = validatePath(path.join(allowed, "new", "file.txt"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resolvedPath, path.join(allowed, "new", "file.txt"));
});

test("denies a missing target beneath a symlink or junction escaping the root", async () => {
  const link = path.join(allowed, "outside-link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const result = validatePath(path.join(link, "new-file.txt"));
  assert.equal(result.ok, false);
  assert.match(result.error, /symlink.*outside allowed directories/i);
});

test(
  "Windows whitelist comparison is case-insensitive",
  { skip: process.platform !== "win32" },
  () => {
    const result = validatePath(path.join(allowed.toUpperCase(), "case-test.txt"));
    assert.equal(result.ok, true, result.error);
  }
);
