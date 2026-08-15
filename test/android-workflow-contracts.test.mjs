import assert from "node:assert/strict";
import test from "node:test";

const {
  parseRunRequest,
  validateNode,
  ALLOWED_NODE_ACTIONS,
  WORKFLOW_STATES,
  VALID_TRANSITIONS,
} = await import("../dist/android-workflow/contracts.js");

// --- RunRequest parsing ---

test("accepts a profile request without app-specific fields in the core request", () => {
  const request = parseRunRequest({ profileId: "zeroxcore", workdir: "F:\\zeroxcore", apkPath: "app-debug.apk", sshHost: "staging" });
  assert.equal(request.contractVersion, 1);
  assert.equal(request.deviceId, "emulator-5554");
  assert.equal(request.profileId, "zeroxcore");
  assert.equal(request.sshHost, "staging");
});

test("rejects missing required fields", () => {
  assert.throws(() => parseRunRequest({ profileId: "x" }), /workdir/);
  assert.throws(() => parseRunRequest({ profileId: "x", workdir: "F:\\proj" }), /apkPath/);
  assert.throws(() => parseRunRequest({ workdir: "F:\\proj", apkPath: "a.apk", sshHost: "s" }), /profileId/);
  assert.throws(() => parseRunRequest({ profileId: "x", workdir: "F:\\proj", apkPath: "a.apk" }), /sshHost/);
});

test("rejects non-emulator-5554 device overrides", () => {
  assert.throws(
    () => parseRunRequest({ profileId: "x", workdir: "F:\\p", apkPath: "a.apk", sshHost: "s", deviceId: "emulator-5556" }),
    /emulator-5554/,
  );
});

// --- Node action validation ---

test("rejects undeclared profile capabilities and arbitrary node actions", () => {
  assert.throws(() => validateNode({ type: "shell", command: "whoami" }), /undeclared action/);
  assert.throws(() => validateNode({ type: "exec", command: "rm -rf /" }), /undeclared action/);
  assert.throws(() => validateNode({ type: "" }), /undeclared action/);
  assert.throws(() => validateNode({}), /undeclared action/);
});

test("accepts all declared node action types", () => {
  const expected = new Set([
    "install_apk", "launch_app", "tap", "input", "wait",
    "assert_text", "assert_http", "disconnect_tunnel",
    "reconnect_tunnel", "write_evidence",
  ]);
  assert.deepEqual(ALLOWED_NODE_ACTIONS, expected);
  for (const type of expected) {
    assert.doesNotThrow(() => validateNode({ type, id: "n1", onSuccess: "completed" }));
  }
});

// --- Workflow states and transitions ---

test("workflow states include the full topology lifecycle", () => {
  const required = [
    "created", "preflight_passed", "tunnel_connected", "app_ready",
    "scenario_started", "scenario_passed",
    "tunnel_interrupted", "failure_state_confirmed",
    "tunnel_reconnected", "recovery_passed", "evidence_written", "completed",
    "failed", "cancelled", "cleanup_failed",
  ];
  for (const state of required) {
    assert.ok(WORKFLOW_STATES.has(state), `missing state: ${state}`);
  }
});

test("valid transitions include the happy path and offline branch", () => {
  assert.ok(VALID_TRANSITIONS["created"]?.includes("preflight_passed"));
  assert.ok(VALID_TRANSITIONS["preflight_passed"]?.includes("tunnel_connected"));
  assert.ok(VALID_TRANSITIONS["tunnel_connected"]?.includes("app_ready"));
  assert.ok(VALID_TRANSITIONS["app_ready"]?.includes("scenario_started"));
  assert.ok(VALID_TRANSITIONS["scenario_started"]?.includes("scenario_passed"));
  assert.ok(VALID_TRANSITIONS["scenario_passed"]?.includes("evidence_written"));
  assert.ok(VALID_TRANSITIONS["evidence_written"]?.includes("completed"));
  // offline branch
  assert.ok(VALID_TRANSITIONS["scenario_started"]?.includes("tunnel_interrupted"));
  assert.ok(VALID_TRANSITIONS["tunnel_interrupted"]?.includes("tunnel_reconnected"));
  assert.ok(VALID_TRANSITIONS["tunnel_reconnected"]?.includes("recovery_passed"));
});

test("invalid transitions are not declared", () => {
  // cannot skip from created to recovery_passed
  assert.ok(!VALID_TRANSITIONS["created"]?.includes("recovery_passed"));
  assert.ok(!VALID_TRANSITIONS["created"]?.includes("completed"));
  // terminal states have no outgoing transitions
  assert.ok(!VALID_TRANSITIONS["completed"] || VALID_TRANSITIONS["completed"].length === 0);
  assert.ok(!VALID_TRANSITIONS["failed"] || VALID_TRANSITIONS["failed"].length === 0);
});

// --- Contract exports completeness ---

test("contracts module exports all required types and functions", async () => {
  const mod = await import("../dist/android-workflow/contracts.js");
  assert.equal(typeof mod.parseRunRequest, "function");
  assert.equal(typeof mod.validateNode, "function");
  assert.ok(mod.ALLOWED_NODE_ACTIONS instanceof Set);
  assert.ok(mod.WORKFLOW_STATES instanceof Set);
  assert.ok(typeof mod.VALID_TRANSITIONS === "object");
});
