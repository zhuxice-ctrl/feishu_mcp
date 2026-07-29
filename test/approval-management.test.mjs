import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const script = path.join(projectDir, "scripts", "manage-approvals.ps1");

function run(dataDir, ...args) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-DataDir", dataDir, ...args,
  ], { cwd: projectDir, encoding: "utf8" });
}

test(
  "directory grants list redacted values and remove independently",
  { skip: process.platform !== "win32" },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "approval-manager-"));
    const fullPath = path.join(dataDir, "private-project");
    try {
      await writeFile(path.join(dataDir, "directory-grants.json"), JSON.stringify({
        version: 1,
        grants: [{
          id: "11111111-1111-4111-8111-111111111111",
          userId: "owner",
          logicalRoot: fullPath,
          physicalRoot: fullPath,
          createdAt: "2026-07-29T00:00:00.000Z",
        }],
      }), "utf8");
      await writeFile(path.join(dataDir, "approvals.json"), JSON.stringify({
        version: 1,
        approvals: [{ id: "keep-operation-approval" }],
      }), "utf8");

      const listed = run(dataDir, "-ListDirectories");
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /\b1\b/);
      assert.match(listed.stdout, /11111111/);
      assert.match(listed.stdout, /private-project/);
      assert.doesNotMatch(listed.stdout, /\bowner\b/);
      assert.equal(listed.stdout.includes(fullPath), false);

      const removed = run(dataDir, "-RemoveDirectory", "11111111");
      assert.equal(removed.status, 0, removed.stderr);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(dataDir, "directory-grants.json"), "utf8")),
        { version: 1, grants: [] },
      );
      assert.match(await readFile(path.join(dataDir, "approvals.json"), "utf8"), /keep-operation-approval/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  "ClearDirectories leaves operation approvals byte-identical",
  { skip: process.platform !== "win32" },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "approval-manager-clear-"));
    try {
      await writeFile(path.join(dataDir, "directory-grants.json"), JSON.stringify({
        version: 1,
        grants: ["one", "two"].map((name) => ({
          id: name + "-id", userId: "owner",
          logicalRoot: path.join(dataDir, name),
          physicalRoot: path.join(dataDir, name),
          createdAt: "2026-07-29T00:00:00.000Z",
        })),
      }), "utf8");
      await writeFile(path.join(dataDir, "approvals.json"), JSON.stringify({
        version: 1, approvals: [{ id: "keep-operation-approval" }],
      }), "utf8");
      const before = await readFile(path.join(dataDir, "approvals.json"));
      const cleared = run(dataDir, "-ClearDirectories");
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(dataDir, "directory-grants.json"), "utf8")),
        { version: 1, grants: [] },
      );
      assert.deepEqual(await readFile(path.join(dataDir, "approvals.json")), before);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
