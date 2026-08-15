import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { StagingCoordinator } = await import("../dist/android-workflow/coordinator.js");
const { ProfileRegistry } = await import("../dist/android-workflow/profileRegistry.js");
const { StateStore } = await import("../dist/android-workflow/stateStore.js");
const { zeroxcoreProfile } = await import("../dist/android-workflow/profiles/zeroxcore.js");

// ---------------------------------------------------------------------------
// Fake adapters — implement the contract interfaces without real side effects.
// ---------------------------------------------------------------------------

function fakeTunnel() {
  const calls = { connect: 0, disconnect: 0, probe: 0 };
  return {
    calls,
    async connect(spec) { calls.connect++; return { spec, startedAt: Date.now() }; },
    async disconnect(h) { calls.disconnect++; },
    async probe(h) { calls.probe++; return true; },
  };
}

function fakeDevice(assertFn) {
  const calls = { preflight: 0, install: 0, launch: 0, assert: 0 };
  return {
    calls,
    async preflight(id) { calls.preflight++; return { deviceId: "emulator-5554", apiLevel: 34, abi: "x86_64" }; },
    async install(apk) { calls.install++; },
    async launch(pkg, act) { calls.launch++; },
    async tap(t) {},
    async input(v) {},
    async assert(a) { calls.assert++; if (assertFn) assertFn(a, calls.assert); },
    async screenshot() { return { path: "x.png", mimeType: "image/png", sha256: "abc", redacted: true }; },
    async logcatTail() { return ""; },
  };
}

const APK = { path: "app-debug.apk", packageName: "tech.test.app", sha256: "a".repeat(64) };
const REQUEST = { contractVersion: 1, profileId: "dummy", workdir: "F:\\proj", apkPath: "app-debug.apk", deviceId: "emulator-5554", sshHost: "staging" };

function dummyProfile() {
  return {
    id: "dummy",
    version: 1,
    packageName: "com.example.dummy",
    tunnel: { remotePort: 3100, localPort: 3100 },
    graph: {
      entryState: "tunnel_connected",
      nodes: [
        { id: "install", type: "install_apk", fromState: "tunnel_connected", onSuccess: "app_ready" },
        { id: "launch", type: "launch_app", fromState: "app_ready", onSuccess: "scenario_started" },
        { id: "verify", type: "assert_text", fromState: "scenario_started", onSuccess: "scenario_passed", assertion: { kind: "text_present", value: "Welcome" } },
      ],
    },
    capabilities: new Set(["ui"]),
    validate() {},
  };
}

async function setup(profileFn) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "awf-state-"));
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "awf-evidence-"));
  const registry = new ProfileRegistry();
  registry.register(profileFn());
  const tunnel = fakeTunnel();
  const device = fakeDevice();
  const coordinator = new StagingCoordinator({
    tunnel, device, registry,
    stateStore: new StateStore(stateDir),
    evidenceDir,
  });
  return { coordinator, tunnel, device, stateDir, evidenceDir, cleanup: async () => { await rm(stateDir, { recursive: true, force: true }); await rm(evidenceDir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("coordinator completes the happy path with a dummy profile", async () => {
  const { coordinator, tunnel, device, cleanup } = await setup(dummyProfile);
  try {
    const result = await coordinator.run(REQUEST, APK, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.error, null);
    assert.equal(result.profileId, "dummy");
    assert.equal(result.profileVersion, 1);
    assert.equal(result.apkDigest, APK.sha256);
    assert.equal(result.nodes.length, 3);
    assert.ok(result.nodes.every((n) => n.status === "passed"));
    assert.ok(result.evidencePath.endsWith(".evidence.md"));
    assert.equal(tunnel.calls.connect, 1);
    assert.equal(tunnel.calls.disconnect, 1);
    assert.equal(device.calls.preflight, 1);
    assert.equal(device.calls.install, 1);
    assert.equal(device.calls.launch, 1);
    assert.equal(device.calls.assert, 1);
  } finally {
    await cleanup();
  }
});

test("coordinator does not branch on ZeroXCore names — uses registry lookup", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "awf-state-"));
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "awf-evidence-"));
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  const tunnel = fakeTunnel();
  const device = fakeDevice();
  const coordinator = new StagingCoordinator({ tunnel, device, registry, stateStore: new StateStore(stateDir), evidenceDir });
  try {
    const result = await coordinator.run({ ...REQUEST, profileId: "zeroxcore" }, APK, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.profileId, "zeroxcore");
    // verify_binding assert succeeded on first try (no offline branch taken)
    assert.equal(device.calls.assert, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("coordinator follows the offline recovery branch on tunnel failure", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "awf-state-"));
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "awf-evidence-"));
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  const tunnel = fakeTunnel();
  // verify_binding throws twice (call 1 + retry), recover_binding succeeds (call 3)
  const device = fakeDevice((_a, count) => {
    if (count < 3) throw new Error("tunnel connection reset by peer");
  });
  const coordinator = new StagingCoordinator({ tunnel, device, registry, stateStore: new StateStore(stateDir), evidenceDir });
  try {
    const result = await coordinator.run({ ...REQUEST, profileId: "zeroxcore" }, APK, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.error, null);
    // verify_binding (2 assert calls incl retry) + recover_binding (1) = 3
    assert.equal(device.calls.assert, 3);
    const nodeIds = result.nodes.map((n) => n.nodeId);
    assert.ok(nodeIds.includes("reconnect_tunnel"));
    assert.ok(nodeIds.includes("recover_binding"));
    // verify_binding should be marked failed, recover_binding passed
    const verify = result.nodes.find((n) => n.nodeId === "verify_binding");
    assert.equal(verify.status, "failed");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("coordinator terminates on non-retryable failure and cleans up the tunnel", async () => {
  const { coordinator, tunnel, device, cleanup } = await setup(() => ({
    ...dummyProfile(),
    graph: {
      entryState: "tunnel_connected",
      nodes: [
        { id: "install", type: "install_apk", fromState: "tunnel_connected", onSuccess: "app_ready" },
        { id: "launch", type: "launch_app", fromState: "app_ready", onSuccess: "scenario_started" },
      ],
    },
  }));
  // Override device to throw a non-retryable error on launch.
  device.launch = async () => { throw new Error("package name mismatch"); };
  try {
    const result = await coordinator.run(REQUEST, APK, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.nodeId, "launch");
    // cleanup still ran
    assert.equal(tunnel.calls.disconnect, 1);
    assert.ok(result.evidencePath.endsWith(".evidence.md"));
  } finally {
    await cleanup();
  }
});

test("coordinator writes redacted evidence without secrets", async () => {
  const { coordinator, evidenceDir, cleanup } = await setup(dummyProfile);
  try {
    const result = await coordinator.run(REQUEST, APK, new AbortController().signal);
    const md = await readFile(result.evidencePath, "utf8");
    assert.match(md, /Staging Verification Evidence/);
    assert.match(md, /dummy/);
    // No raw secrets should appear.
    assert.equal(md.includes("Bearer"), false);
  } finally {
    await cleanup();
  }
});

test("coordinator resumes from the last checkpoint after a partial failure", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "awf-resume-"));
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "awf-evidence-"));
  const registry = new ProfileRegistry();
  registry.register(dummyProfile());
  const tunnel = fakeTunnel();
  let installShouldFail = true;
  const device = fakeDevice();
  device.install = async () => { device.calls.install++; if (installShouldFail) throw new Error("install failed"); };
  const coordinator = new StagingCoordinator({ tunnel, device, registry, stateStore: new StateStore(stateDir), evidenceDir });

  const runId = "resume-test-001";
  try {
    // First run: install fails → checkpoint saved at tunnel_connected.
    const r1 = await coordinator.run(REQUEST, APK, new AbortController().signal, runId);
    assert.equal(r1.status, "failed");
    assert.equal(r1.error.nodeId, "install");
    assert.equal(r1.runId, runId);

    // Second run: install now succeeds → resumes from tunnel_connected.
    installShouldFail = false;
    const r2 = await coordinator.run(REQUEST, APK, new AbortController().signal, runId);
    assert.equal(r2.status, "completed");
    assert.equal(r2.error, null);
    // install was called once in r1 (failed) + once in r2 (succeeded) = 2
    assert.equal(device.calls.install, 2);
    // preflight only ran once (skipped on resume)
    assert.equal(device.calls.preflight, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("coordinator honours an aborted signal and reports cancelled", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "awf-cancel-"));
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "awf-evidence-"));
  const registry = new ProfileRegistry();
  registry.register(dummyProfile());
  const tunnel = fakeTunnel();
  const controller = new AbortController();
  const device = fakeDevice();
  // Abort during install: install succeeds, then the next node sees aborted.
  device.install = async () => { controller.abort(); };
  const coordinator = new StagingCoordinator({ tunnel, device, registry, stateStore: new StateStore(stateDir), evidenceDir });
  try {
    const result = await coordinator.run(REQUEST, APK, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.ok(result.error);
    assert.equal(result.error.code, "CANCELLED");
    assert.equal(tunnel.calls.disconnect, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
});
