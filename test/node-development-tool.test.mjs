import assert from "node:assert/strict";
import test from "node:test";

const { NODE_ACTIONS, resolveNodeAction } = await import("../dist/tools/nodeDevelopment.js");

test("exports exactly the four approved PNPM actions", () => {
  assert.deepEqual(Object.keys(NODE_ACTIONS), [
    "pnpm_version", "test_run", "build", "typecheck",
  ]);
  assert.deepEqual(resolveNodeAction("pnpm_version"), {
    executable: "pnpm",
    args: ["--version"],
  });
  assert.deepEqual(resolveNodeAction("test_run"), {
    executable: "pnpm",
    args: ["test:run"],
  });
  assert.deepEqual(resolveNodeAction("build"), {
    executable: "pnpm",
    args: ["build"],
  });
  assert.deepEqual(resolveNodeAction("typecheck"), {
    executable: "pnpm",
    args: ["typecheck"],
  });
});
