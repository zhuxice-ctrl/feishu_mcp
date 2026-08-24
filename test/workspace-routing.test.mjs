import assert from "node:assert/strict";
import test from "node:test";

const { validateWorkspaceTransition, WORKSPACE_PHASES } = await import(
  "../dist/development/workspaces/contextTypes.js"
);
const { planWorkspaceRoute } = await import(
  "../dist/development/workspaces/routing.js"
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

const androidHints = {
  ecosystems: ["android"],
  instructionFiles: ["CLAUDE.md"],
  capabilities: ["android_development", "file_read", "content_search"],
};

const nodeHints = {
  ecosystems: ["node"],
  instructionFiles: ["README.md"],
  capabilities: ["node_workflow", "file_read", "content_search"],
};

test("Android work routes to background adapter, never generic shell", () => {
  const plan = planWorkspaceRoute(androidHints, "instructions_ready");
  assert.equal(plan.recommended.some((s) => s.tool === "android_development"), true);
  assert.equal(plan.prohibited.some((s) => s.tool === "execute_command"), true);
  assert.equal(plan.phase, "instructions_ready");
});

test("Node verification routes to run_local_workflow, never raw pnpm", () => {
  const plan = planWorkspaceRoute(nodeHints, "editing");
  assert.equal(plan.recommended.some((s) => s.tool === "run_local_workflow"), true);
  assert.equal(plan.prohibited.some((s) => s.tool === "execute_command"), true);
  assert.equal(plan.workspaceId, "");
});

test("selected phase prescribes declarative instruction reads", () => {
  const plan = planWorkspaceRoute(androidHints, "selected");
  assert.equal(plan.recommended[0].tool, "read_file");
  assert.deepEqual(plan.recommended[0].input.files, ["CLAUDE.md"]);
  assert.equal(plan.recommended[0].required, true);
});