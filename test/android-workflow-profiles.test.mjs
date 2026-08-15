import assert from "node:assert/strict";
import test from "node:test";

const { ProfileRegistry } = await import("../dist/android-workflow/profileRegistry.js");
const { zeroxcoreProfile } = await import("../dist/android-workflow/profiles/zeroxcore.js");

function makeDummyProfile() {
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
    validate(input) {
      if (!input.workdir) throw new Error("workdir required");
    },
  };
}

test("registry loads ZeroXCore without leaking its package into core contracts", () => {
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  const profile = registry.get("zeroxcore");
  assert.equal(profile.packageName, "tech.zeroxcore.app");
  assert.equal(profile.tunnel.localPort, 3100);
  assert.equal(profile.tunnel.remotePort, 3100);
  // coreSchema must not contain the app-specific package name.
  assert.equal(registry.coreSchema().includes("tech.zeroxcore.app"), false);
});

test("a second dummy profile can be registered without coordinator changes", () => {
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  const dummy = makeDummyProfile();
  registry.register(dummy);
  assert.equal(registry.get("dummy").id, "dummy");
  assert.equal(registry.has("zeroxcore"), true);
  assert.equal(registry.has("dummy"), true);
  assert.deepEqual(registry.list().sort(), ["dummy", "zeroxcore"]);
});

test("registry rejects duplicate profile ids", () => {
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  assert.throws(() => registry.register(zeroxcoreProfile), /already registered/);
});

test("registry rejects unknown profile lookup", () => {
  const registry = new ProfileRegistry();
  assert.throws(() => registry.get("nonexistent"), /unknown profile/);
});

test("registry rejects non-3100 tunnel ports", () => {
  const registry = new ProfileRegistry();
  const bad = { ...makeDummyProfile(), tunnel: { remotePort: 8080, localPort: 8080 } };
  assert.throws(() => registry.register(bad), /ports must be 3100/);
});

test("registry rejects unknown capabilities", () => {
  const registry = new ProfileRegistry();
  const bad = { ...makeDummyProfile(), capabilities: new Set(["ui", "root"]) };
  assert.throws(() => registry.register(bad), /unknown capability root/);
});

test("registry rejects invalid profile versions", () => {
  const registry = new ProfileRegistry();
  const bad = { ...makeDummyProfile(), version: 0 };
  assert.throws(() => registry.register(bad), /version must be a positive integer/);
});

test("registry can register a restricted plugin", () => {
  const registry = new ProfileRegistry();
  registry.registerPlugin({
    id: "binding-parser",
    version: 1,
    capabilities: new Set(["ui"]),
    async beforeNode(node, ctx) {},
    async afterNode(node, ctx, result) {},
  });
  assert.equal(registry.plugin("binding-parser").id, "binding-parser");
  assert.throws(() => registry.registerPlugin({
    id: "binding-parser", version: 1, capabilities: new Set(["ui"]),
  }), /already registered/);
});

test("ZeroXCore profile graph declares an offline recovery branch", () => {
  const registry = new ProfileRegistry();
  registry.register(zeroxcoreProfile);
  const profile = registry.get("zeroxcore");
  const nodeIds = profile.graph.nodes.map((n) => n.id);
  assert.ok(nodeIds.includes("verify_binding"));
  assert.ok(nodeIds.includes("reconnect_tunnel"));
  assert.ok(nodeIds.includes("recover_binding"));
  const verify = profile.graph.nodes.find((n) => n.id === "verify_binding");
  assert.equal(verify.onFailure, "tunnel_interrupted");
});
