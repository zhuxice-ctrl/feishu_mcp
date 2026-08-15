import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-local-workflow-tool-"));
const { validateTestFiles, relativeTestPaths, TestFileError } = await import("../dist/development/web/testFiles.js");
const { buildWorkflowLaunchSpec, buildWorkflowSteps } = await import("../dist/development/web/commands.js");
test.after(() => rm(root, { recursive: true, force: true }));

async function workspace() {
  const dir = await mkdtemp(path.join(root, "workspace-"));
  await mkdir(path.join(dir, "tests"));
  await writeFile(path.join(dir, "tests", "auth.test.ts"), "export {}\n");
  return dir;
}

const recipeSteps = [
  { id: "typecheck", kind: "typecheck", enabled: true },
  { id: "lint", kind: "lint", enabled: true },
  { id: "test_selected", kind: "test_selected", enabled: true },
  { id: "build", kind: "build", enabled: true },
];

test("validates selected test files as regular, contained relative paths", async () => {
  const dir = await workspace();
  const absolute = validateTestFiles(["tests/auth.test.ts"], dir);
  assert.deepEqual(relativeTestPaths(absolute, dir), ["tests/auth.test.ts"]);
  for (const candidate of ["../escape.test.ts", "tests\\auth.test.ts", "C:/escape.test.ts", "tests/missing.test.ts", "tests/auth.txt"]) {
    assert.throws(() => validateTestFiles([candidate], dir), TestFileError);
  }
  assert.throws(() => validateTestFiles(["tests/auth.test.ts", "tests/auth.test.ts"], dir), /duplicate/i);
});

test("builds only fixed PNPM actions and skips selected tests without inputs", () => {
  const withTest = buildWorkflowSteps(recipeSteps, root, ["tests/auth.test.ts"]);
  const selected = withTest.find((step) => step.id === "test_selected");
  assert.equal(selected?.enabled, true);
  assert.match(selected?.args.at(-1) ?? "", /tests\/auth\.test\.ts/);
  const withoutTest = buildWorkflowSteps(recipeSteps, root, []);
  assert.equal(withoutTest.find((step) => step.id === "test_selected")?.enabled, false);
  const launch = buildWorkflowLaunchSpec("zeroxcore-web", "verify_web", "a".repeat(64), root, recipeSteps, [], 60_000, [path.join(root, "dist")]);
  assert.equal(launch.steps.length, 4);
  assert.equal(launch.steps.find((step) => step.id === "test_selected")?.enabled, false);
  for (const step of launch.steps) {
    assert.equal(step.timeoutMs, 300_000);
    assert.equal(step.executable.length > 0, true);
  }
});
