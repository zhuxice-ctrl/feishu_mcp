import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { atomicWriteFile } = await import("../dist/tools/atomicWrite.js");

async function withTarget(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-mcp-atomic-"));
  const target = path.join(root, "target.txt");
  await writeFile(target, "original", "utf8");
  try {
    await run({ root, target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function siblingTemps(root) {
  return readdir(root).then((names) => names.filter((name) => name.endsWith(".tmp")));
}

test("temporary write failure leaves the original unchanged", async () => {
  await withTarget(async ({ root, target }) => {
    assert.throws(
      () => atomicWriteFile(target, "replacement", {}, {
        writeAndSync: () => { throw new Error("forced temp failure"); },
      }),
      /forced temp failure/
    );
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await siblingTemps(root), []);
  });
});

test("trash preservation failure aborts before replacing the original", async () => {
  await withTarget(async ({ root, target }) => {
    assert.throws(
      () => atomicWriteFile(target, "replacement", {}, { moveToTrash: () => null }),
      /failed to preserve original/
    );
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await siblingTemps(root), []);
  });
});

test("final rename failure restores the trashed original and removes partial output", async () => {
  await withTarget(async ({ root, target }) => {
    const trash = path.join(root, "preserved.txt");
    const runtime = {
      moveToTrash: (source) => {
        fs.renameSync(source, trash);
        return trash;
      },
      rename: (source, destination) => {
        if (source.endsWith(".tmp")) {
          fs.writeFileSync(destination, "partial", "utf8");
          throw new Error("forced final rename failure");
        }
        fs.renameSync(source, destination);
      },
    };
    assert.throws(
      () => atomicWriteFile(target, "replacement", {}, runtime),
      /original restored/
    );
    assert.equal(await readFile(target, "utf8"), "original");
    assert.equal(fs.existsSync(trash), false);
    assert.deepEqual(await siblingTemps(root), []);
  });
});
