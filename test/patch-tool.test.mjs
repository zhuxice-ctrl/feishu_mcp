import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-patch-tool-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = root;
process.env.APPROVAL_DATA_DIR = path.join(root, ".approval-state");
process.env.APPROVAL_STATE_SECRET = "44556677889900112233aabbccddeeff";
process.env.CONSENT_ABSOLUTE_PATH = "allow";
process.env.CONSENT_SENSITIVE_FILE = "allow";
process.env.LOG_LEVEL = "error";

const { applyPatch } = await import("../dist/tools/patch.js");
const ctx = { mcpReq: { requestState: () => undefined, inputResponses: undefined, signal: new AbortController().signal } };
let sequence = 0;

async function fixture() {
  const dir = path.join(root, `case-${sequence++}`);
  await mkdir(dir);
  await writeFile(path.join(dir, "a.txt"), "one\nsame\n");
  await writeFile(path.join(dir, "delete.txt"), "remove me\n");
  return dir;
}

test.after(async () => rm(root, { recursive: true, force: true }));

test("applies a structured multi-file patch", async () => {
  const dir = await fixture();
  const relative = path.relative(root, dir).replace(/\\/g, "/");
  const result = await applyPatch({ patch: `*** Begin Patch
*** Update File: ${relative}/a.txt
@@
-one
+ONE
 same
*** Add File: ${relative}/new.txt
+created
*** Delete File: ${relative}/delete.txt
*** End Patch` }, ctx);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.applied, true);
  assert.equal(body.fileCount, 3);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "ONE\nsame\n");
  assert.equal(await readFile(path.join(dir, "new.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(path.join(dir, "delete.txt"), "utf8"), /ENOENT/);
});

test("applies a unified patch to one file", async () => {
  const dir = await fixture();
  const target = path.relative(root, path.join(dir, "a.txt"));
  const result = await applyPatch({
    path: target,
    patch: "@@ -1,2 +1,2 @@\n-one\n+changed\n same\n",
  }, ctx);
  assert.equal(JSON.parse(result.content[0].text).applied, true);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "changed\nsame\n");
});

test("requires a stable identity before authorizing a formerly out-of-root patch", async () => {
  const result = await applyPatch({ patch: `*** Begin Patch
*** Add File: ../outside.txt
+blocked
*** End Patch` }, ctx);
  assert.equal(JSON.parse(result.content[0].text).code, "DIRECTORY_IDENTITY_REQUIRED");
});

test("restores every original when a later commit rename fails", async () => {
  const dir = await fixture();
  await writeFile(path.join(dir, "b.txt"), "two\n");
  const relative = path.relative(root, dir).replace(/\\/g, "/");
  let renames = 0;
  const result = await applyPatch({ patch: `*** Begin Patch
*** Update File: ${relative}/a.txt
-one
+ONE
 same
*** Update File: ${relative}/b.txt
-two
+TWO
*** End Patch` }, ctx, {
    commitRename: async (source, destination) => {
      renames += 1;
      if (renames === 2) throw new Error("forced commit failure");
      await fs.rename(source, destination);
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /forced commit failure/);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\nsame\n");
  assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "two\n");
  const leftovers = (await fs.readdir(dir)).filter((name) => /\.patch-.*\.(tmp|bak)$/.test(name));
  assert.deepEqual(leftovers, []);
});

test("serializes concurrent patches that touch the same target", async () => {
  const dir = await fixture();
  const target = path.join(dir, "shared.txt");
  await writeFile(target, "base\n");
  const relative = path.relative(root, target).replace(/\\/g, "/");
  const patchOne = `*** Begin Patch
*** Update File: ${relative}
-base
+one
*** End Patch`;
  const patchTwo = `*** Begin Patch
*** Update File: ${relative}
-base
+two
*** End Patch`;
  const first = applyPatch({ patch: patchOne }, ctx, {
    commitRename: async (source, destination) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.rename(source, destination);
    },
  });
  const second = applyPatch({ patch: patchTwo }, ctx);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(JSON.parse(firstResult.content[0].text).applied, true);
  assert.equal(secondResult.isError, true);
  assert.match(secondResult.content[0].text, /hunk context was not found/);
  assert.equal(await readFile(target, "utf8"), "one\n");
});
