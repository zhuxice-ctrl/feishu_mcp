import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-content-search-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = root;
process.env.APPROVAL_DATA_DIR = path.join(root, ".approval-state");
process.env.APPROVAL_STATE_SECRET = "11223344556677889900aabbccddeeff";
process.env.CONSENT_ABSOLUTE_PATH = "allow";
process.env.CONSENT_SENSITIVE_FILE = "allow";
process.env.LOG_LEVEL = "error";

await mkdir(path.join(root, "src"));
await mkdir(path.join(root, "node_modules"));
await writeFile(path.join(root, "src", "one.ts"), "alpha\nneedle here\nomega\n");
await writeFile(path.join(root, "src", "two.js"), "needle ignored by include\n");
await writeFile(path.join(root, "src", "secret.env.ts"), "needle=secret\n");
await writeFile(path.join(root, ".env"), "needle=secret\n");
await writeFile(path.join(root, "node_modules", "dep.ts"), "needle dependency\n");

const { searchContent } = await import("../dist/tools/contentSearch.js");
const ctx = {
  mcpReq: {
    requestState: () => undefined,
    inputResponses: undefined,
    signal: new AbortController().signal,
  },
};

test.after(async () => rm(root, { recursive: true, force: true }));

test("searches included content and skips sensitive and generated files", async () => {
  const result = await searchContent({ pattern: "needle", path: root, include: "**/*.ts" }, ctx);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.matchCount, 1);
  assert.match(body.results[0].file, /one\.ts$/);
  assert.equal(body.results[0].line, 2);
  assert.equal(body.skippedSensitive, 1);
});

test("returns a structured invalid-regex error", async () => {
  const result = await searchContent({ pattern: "[", path: root }, ctx);
  assert.equal(JSON.parse(result.content[0].text).code, "INVALID_PATTERN");
});

test("honors maxResults", async () => {
  const result = await searchContent({ pattern: ".", path: root, include: "*.ts", maxResults: 1 }, ctx);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.matchCount, 1);
  assert.equal(body.truncated, true);
});
