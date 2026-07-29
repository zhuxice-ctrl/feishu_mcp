import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeDirectoryScope,
  deduplicateRoots,
  isInsideDirectory,
  pathKey,
} from "../dist/security/directoryRoots.js";

test("file requests infer the containing directory and bind the physical path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-"));
  try {
    const file = path.join(root, "project", "file.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x");
    const scope = canonicalizeDirectoryScope(file, "file");
    assert.equal(scope.logicalRoot, path.dirname(file));
    assert.equal(scope.physicalRoot, await realpath(path.dirname(file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory requests bind the requested directory itself", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-existing-"));
  try {
    const directory = path.join(root, "project");
    await mkdir(directory);
    const scope = canonicalizeDirectoryScope(directory, "directory");
    assert.equal(scope.logicalRoot, directory);
    assert.equal(scope.physicalRoot, await realpath(directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing file binds its requested parent through the nearest real ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-missing-"));
  try {
    const scope = canonicalizeDirectoryScope(
      path.join(root, "new-project", "file.txt"),
      "file",
    );
    assert.equal(scope.logicalRoot, path.join(root, "new-project"));
    assert.equal(scope.physicalRoot, path.join(await realpath(root), "new-project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical roots resolve directory symlinks and junctions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-link-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const scope = canonicalizeDirectoryScope(path.join(link, "file.txt"), "file");
    assert.equal(scope.logicalRoot, link);
    assert.equal(scope.physicalRoot, await realpath(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Windows containment and path keys are case-insensitive",
  { skip: process.platform !== "win32" },
  () => {
    const root = path.resolve("C:\\Temp\\Project");
    const candidate = path.resolve("c:\\temp\\project\\src\\file.txt");
    assert.equal(pathKey(root), pathKey(root.toUpperCase()));
    assert.equal(isInsideDirectory(candidate, root), true);
    assert.equal(isInsideDirectory(path.resolve("C:\\Temp\\Project-Other"), root), false);
  },
);

test("deduplicateRoots sorts logical roots and collapses physical aliases", () => {
  const base = path.resolve(os.tmpdir(), "directory-root-deduplicate");
  const sharedPhysical = path.join(base, "physical");
  const roots = [
    { logicalRoot: path.join(base, "z"), physicalRoot: sharedPhysical },
    { logicalRoot: path.join(base, "b"), physicalRoot: path.join(base, "second") },
    { logicalRoot: path.join(base, "a"), physicalRoot: sharedPhysical },
  ];

  const result = deduplicateRoots(roots);
  assert.notEqual(result, roots);
  assert.deepEqual(result, [
    { logicalRoot: path.join(base, "a"), physicalRoot: sharedPhysical },
    { logicalRoot: path.join(base, "b"), physicalRoot: path.join(base, "second") },
  ]);
});
