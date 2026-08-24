import assert from "node:assert/strict";
import test from "node:test";

const { validateWorkspaceTransition, WORKSPACE_PHASES } = await import(
  "../dist/development/workspaces/contextTypes.js"
);

test("only declared workspace phase transitions are valid", () => {
  assert.equal(validateWorkspaceTransition("selected", "instructions_ready"), true);
  assert.equal(validateWorkspaceTransition("verification_running", "verification_terminal"), true);
  assert.equal(validateWorkspaceTransition("selected", "verification_terminal"), false);
});

test("every phase is a declared member", () => {
  assert.deepEqual(WORKSPACE_PHASES, [
    "selected",
    "instructions_ready",
    "inspected",
    "editing",
    "verification_queued",
    "verification_running",
    "verification_terminal",
  ]);
});