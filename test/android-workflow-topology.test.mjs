import assert from "node:assert/strict";
import test from "node:test";

const {
  TopologyEngine,
  executeNode,
  executeNodeWithRetry,
  toStagingError,
  cancelledError,
} = await import("../dist/android-workflow/topology.js");

// --- Transition validation ---

test("allows the declared offline branch but rejects skipping app_ready", () => {
  const engine = new TopologyEngine({
    entryState: "tunnel_connected",
    nodes: [
      { id: "install", type: "install_apk", fromState: "tunnel_connected", onSuccess: "app_ready" },
      { id: "verify", type: "assert_text", fromState: "scenario_started", onSuccess: "scenario_passed", onFailure: "tunnel_interrupted" },
    ],
  });
  assert.doesNotThrow(() => engine.transition("scenario_started", "tunnel_interrupted"));
  assert.throws(() => engine.transition("created", "recovery_passed"), /invalid transition/);
});

test("isTerminal recognises terminal states", () => {
  const engine = new TopologyEngine({
    entryState: "created",
    nodes: [{ id: "n", type: "wait", fromState: "created", onSuccess: "completed", waitMs: 0 }],
  });
  assert.equal(engine.isTerminal("completed"), true);
  assert.equal(engine.isTerminal("failed"), true);
  assert.equal(engine.isTerminal("tunnel_connected"), false);
});

// --- Node execution with fake adapters ---

function fakeDevice(overrides = {}) {
  const calls = [];
  return {
    calls,
    async preflight(id) { calls.push("preflight"); return { deviceId: "emulator-5554", apiLevel: 34, abi: "x86_64" }; },
    async install(apk) { calls.push(["install", apk.packageName]); },
    async launch(pkg, act) { calls.push(["launch", pkg, act]); },
    async tap(t) { calls.push(["tap", t]); },
    async input(v) { calls.push(["input", v]); },
    async assert(a) { calls.push(["assert", a.kind, a.value]); },
    async screenshot() { calls.push("screenshot"); return { path: "x.png", mimeType: "image/png", sha256: "abc", redacted: true }; },
    async logcatTail() { return "logcat"; },
    ...overrides,
  };
}

function fakeTunnel(overrides = {}) {
  return {
    async connect(spec) { return { spec, startedAt: Date.now() }; },
    async disconnect(h) {},
    async probe(h) { return true; },
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  const controller = new AbortController();
  return {
    ctx: {
      runId: "r1",
      device: fakeDevice(),
      tunnel: fakeTunnel(),
      tunnelHandle: { spec: { alias: "staging", localPort: 3100, remotePort: 3100 }, startedAt: 0 },
      tunnelSpec: { alias: "staging", localPort: 3100, remotePort: 3100 },
      apk: { path: "a.apk", packageName: "tech.test.app", sha256: "deadbeef" },
      packageName: "tech.test.app",
      activity: undefined,
      signal: controller.signal,
      redact: (s) => s,
      ...overrides,
    },
    controller,
  };
}

test("executeNode runs install_apk through the device adapter", async () => {
  const { ctx } = makeCtx();
  const record = await executeNode({ id: "n1", type: "install_apk", onSuccess: "app_ready" }, ctx);
  assert.equal(record.status, "passed");
  assert.equal(record.state, "app_ready");
  assert.equal(ctx.device.calls[0][0], "install");
});

test("executeNode runs wait and honours the timeout", async () => {
  const { ctx } = makeCtx();
  const record = await executeNode({ id: "n1", type: "wait", waitMs: 10, onSuccess: "app_ready" }, ctx);
  assert.equal(record.status, "passed");
  assert.ok(record.durationMs >= 0);
});

test("executeNode throws StagingError on adapter failure", async () => {
  const { ctx } = makeCtx({ device: fakeDevice({ async install() { throw new Error("install failed: connection reset by peer"); } }) });
  await assert.rejects(
    () => executeNode({ id: "n1", type: "install_apk", onSuccess: "app_ready" }, ctx),
    (err) => {
      assert.equal(err.code, "TUNNEL_ERROR");
      assert.equal(err.retryable, true);
      assert.equal(err.nodeId, "n1");
      return true;
    },
  );
});

test("executeNodeWithRetry retries once on retryable errors", async () => {
  let attempts = 0;
  const { ctx } = makeCtx({ device: fakeDevice({
    async install() { attempts++; if (attempts === 1) throw new Error("tunnel timeout"); },
  }) });
  const record = await executeNodeWithRetry({ id: "n1", type: "install_apk", onSuccess: "app_ready" }, ctx);
  assert.equal(attempts, 2);
  assert.equal(record.status, "passed");
});

test("executeNodeWithRetry does not retry non-retryable errors", async () => {
  let attempts = 0;
  const { ctx } = makeCtx({ device: fakeDevice({
    async install() { attempts++; throw new Error("package name mismatch"); },
  }) });
  await assert.rejects(
    () => executeNodeWithRetry({ id: "n1", type: "install_apk", onSuccess: "app_ready" }, ctx),
    (err) => { assert.equal(err.retryable, false); return true; },
  );
  assert.equal(attempts, 1);
});

test("executeNode throws cancelled error when signal is already aborted", async () => {
  const { ctx, controller } = makeCtx();
  controller.abort();
  await assert.rejects(
    () => executeNode({ id: "n1", type: "install_apk", onSuccess: "app_ready" }, ctx),
    (err) => { assert.equal(err.code, "CANCELLED"); return true; },
  );
});

test("toStagingError redacts sensitive values in the message", () => {
  const se = toStagingError("n1", new Error("Authorization: Bearer secrettoken123 failed"));
  assert.equal(se.redactedMessage.includes("secrettoken123"), false);
  assert.equal(se.redactedMessage.includes("[REDACTED]"), true);
});

test("cancelledError produces a non-retryable StagingError", () => {
  const se = cancelledError("n1");
  assert.equal(se.code, "CANCELLED");
  assert.equal(se.retryable, false);
});
