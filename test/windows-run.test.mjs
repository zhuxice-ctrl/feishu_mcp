import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planWindowsRun, resolveStopTaskId, RUNNABLE_EXTENSIONS } from "../dist/development/windows/run.js";

function makeAuthorizedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "win-run-"));
  return root;
}

function makeArtifact(root, name = "app.exe") {
  const p = path.join(root, name);
  fs.writeFileSync(p, "MZ fake exe");
  return p;
}

function allowRoot(root) {
  return (p) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
}

test("planWindowsRun produces empty args and canonical path hash", () => {
  const root = makeAuthorizedRoot();
  const artifact = makeArtifact(root);
  const r = planWindowsRun(
    { artifactPath: artifact, cwd: root, timeoutMs: 60_000 },
    { authorizeHostPath: allowRoot(root) },
  );
  assert.equal(r.executable, fs.realpathSync(artifact));
  assert.deepEqual(r.args, []);
  assert.equal(r.cwd, fs.realpathSync(root));
  assert.equal(r.timeoutMs, 60_000);
  assert.deepEqual(r.successExitCodes, []);
  // canonical path hash is a 64-char hex string
  assert.match(r.canonicalPathHash, /^[0-9a-f]{64}$/);
});

test("planWindowsRun rejects unauthorized artifact path", () => {
  const root = makeAuthorizedRoot();
  const other = makeAuthorizedRoot();
  const artifact = makeArtifact(other);
  assert.throws(
    () => planWindowsRun(
      { artifactPath: artifact, cwd: root, timeoutMs: 60_000 },
      { authorizeHostPath: allowRoot(root) },
    ),
    /host path outside authorized directory/,
  );
});

test("planWindowsRun rejects non-runnable extension", () => {
  const root = makeAuthorizedRoot();
  const doc = path.join(root, "readme.txt");
  fs.writeFileSync(doc, "hello");
  assert.throws(
    () => planWindowsRun(
      { artifactPath: doc, cwd: root, timeoutMs: 60_000 },
      { authorizeHostPath: allowRoot(root) },
    ),
    /not a runnable artifact/,
  );
});

test("planWindowsRun rejects symlink artifact", () => {
  const root = makeAuthorizedRoot();
  const target = makeArtifact(root, "real.exe");
  const link = path.join(root, "link.exe");
  try {
    fs.symlinkSync(target, link);
  } catch {
    // symlinks may not be supported on all platforms; skip gracefully
    return;
  }
  assert.throws(
    () => planWindowsRun(
      { artifactPath: link, cwd: root, timeoutMs: 60_000 },
      { authorizeHostPath: allowRoot(root) },
    ),
    /symlink artifact refused/,
  );
});

test("planWindowsRun rejects missing artifact", () => {
  const root = makeAuthorizedRoot();
  assert.throws(
    () => planWindowsRun(
      { artifactPath: path.join(root, "nope.exe"), cwd: root, timeoutMs: 60_000 },
      { authorizeHostPath: allowRoot(root) },
    ),
    /artifact not found/,
  );
});

test("planWindowsRun rejects unauthorized cwd", () => {
  const root = makeAuthorizedRoot();
  const other = makeAuthorizedRoot();
  const artifact = makeArtifact(root);
  assert.throws(
    () => planWindowsRun(
      { artifactPath: artifact, cwd: other, timeoutMs: 60_000 },
      { authorizeHostPath: allowRoot(root) },
    ),
    /host path outside authorized directory/,
  );
});

test("resolveStopTaskId returns taskId for active task", () => {
  const result = resolveStopTaskId("task-123", () => false);
  assert.deepEqual(result, { taskId: "task-123" });
});

test("resolveStopTaskId returns alreadyTerminal for terminal task", () => {
  const result = resolveStopTaskId("task-123", () => true);
  assert.deepEqual(result, { alreadyTerminal: true });
});

test("resolveStopTaskId returns notFound for empty/invalid id", () => {
  assert.deepEqual(resolveStopTaskId("", () => false), { notFound: true });
  assert.deepEqual(resolveStopTaskId(null, () => false), { notFound: true });
});

test("RUNNABLE_EXTENSIONS only contains .exe", () => {
  assert.deepEqual([...RUNNABLE_EXTENSIONS], [".exe"]);
});
