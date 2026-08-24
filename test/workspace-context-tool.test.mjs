import assert from "node:assert/strict";
import test from "node:test";

const { toolError } = await import("../dist/tools/results.js");

test("workspace selection error gives bounded next action", () => {
  const result = toolError(
    "WORKSPACE_SELECTION_REQUIRED",
    "Select workspace.",
    false,
    {},
    { tool: "workspace_context", action: "bootstrap", reason: "No active workspace." },
    [{ workspaceId: "demo", label: "Demo" }],
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "WORKSPACE_SELECTION_REQUIRED");
  assert.equal(result.structuredContent.nextAction.tool, "workspace_context");
  assert.equal(result.structuredContent.nextAction.action, "bootstrap");
  assert.deepEqual(result.structuredContent.candidates, [
    { workspaceId: "demo", label: "Demo" },
  ]);
});

test("toolError preserves existing call signatures", () => {
  const plain = toolError("OWNER_REQUIRED", "Owner only.");
  assert.equal(plain.structuredContent.ok, false);
  assert.equal(plain.structuredContent.code, "OWNER_REQUIRED");
  assert.equal(plain.structuredContent.nextAction, undefined);
});