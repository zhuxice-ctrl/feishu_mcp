import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-env-tools-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "env-tools-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { EnvironmentInspector } = await import("../dist/development/environment/inspect.js");
const { PlanPlanner } = await import("../dist/development/environment/planner.js");
const { PlanStore } = await import("../dist/development/environment/planStore.js");
const { PlanApplier } = await import("../dist/development/environment/applyPlan.js");
const { developmentOwnerKey } = await import("../dist/development/tasks/ownerKey.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const { digestArguments } = await import("../dist/security/approval.js");
const {
  inspectInputSchema,
  planInputSchema,
  applyInputSchema,
  inspectDevelopmentEnvironment,
  planEnvironmentChanges,
  applyEnvironmentPlan,
} = await import("../dist/tools/developmentEnvironment.js");

test.after(async () => rm(root, { recursive: true, force: true }));

const ownerKey = developmentOwnerKey("owner");

const catalog = {
  version: 1,
  components: [
    {
      id: "test.jdk",
      target: "android",
      displayName: "Test JDK",
      versions: ["1.0"],
      discovery: { kind: "fixed_candidates", values: [] },
      publishers: ["Test"],
      install: { kind: "winget", packageId: "Test.JDK", source: "winget" },
    },
    {
      id: "test.gradle",
      target: "android",
      displayName: "Test Gradle",
      versions: ["1.0"],
      discovery: { kind: "fixed_candidates", values: [] },
      publishers: ["Test"],
      install: {
        kind: "verified_archive",
        artifactId: "gradle-1.0",
        url: "https://services.gradle.org/distributions/gradle-1.0.zip",
        sha256: "a".repeat(64),
      },
    },
    {
      id: "microsoft.visualstudio.2022.buildtools",
      target: "dotnet",
      displayName: "Visual Studio Build Tools 2022",
      versions: ["17.0"],
      discovery: { kind: "fixed_candidates", values: [] },
      publishers: ["Microsoft"],
      install: { kind: "winget", packageId: "Microsoft.VisualStudio.2022.BuildTools", source: "winget" },
    },
  ],
};

/** Shared mutable stub resolver. `mode` is swapped between plan and apply to
 *  simulate environment drift; the inspector holds this same object. */
const stubResolver = {
  mode: "ready",
  async resolveComponent(id) {
    if (this.mode === "missing") {
      return { componentId: id, target: "android", trusted: false, state: "missing", fileIdentity: "" };
    }
    const identity = this.mode === "drift" ? `id-${id}-drift` : `id-${id}`;
    return { componentId: id, target: "android", trusted: true, state: "ready", fileIdentity: identity, version: "1.0" };
  },
};
function setResolverMode(mode) {
  stubResolver.mode = mode;
}

let planCounter = 0;
function makeDeps(applier) {
  planCounter += 1;
  const inspector = new EnvironmentInspector({ catalog, resolver: stubResolver });
  const planner = new PlanPlanner({ catalog });
  const planStore = new PlanStore(path.join(root, `plans-${planCounter}`));
  return {
    deps: { catalog, inspector, planner, planStore, applier, ownerKey: () => ownerKey, userId: () => "owner" },
    planStore,
  };
}

function context({ state, decision } = {}) {
  return {
    mcpReq: {
      envelope: {},
      requestState: () => state,
      inputResponses: decision
        ? { approval: { action: "accept", content: { decision } } }
        : undefined,
    },
  };
}

async function approveOnce(applyArgs, deps) {
  const first = await applyEnvironmentPlan(applyArgs, deps, context());
  assert.equal(first.resultType, "input_required", "apply must elicit approval before applying");
  const state = await approvalStateCodec.verify(first.requestState, context());
  return applyEnvironmentPlan(applyArgs, deps, context({ state, decision: "allow_once" }));
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ------------------------------------------------------------- inspect ---

test("inspect returns structured public status without paths or identities", async () => {
  setResolverMode("ready");
  const { deps } = makeDeps(new PlanApplier({}));
  const result = await inspectDevelopmentEnvironment({ targets: ["android"] }, deps);
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(body.catalogVersion, 1);
  assert.deepEqual(body.targets, ["android"]);
  assert.match(body.environmentDigest, /^[0-9a-f]{64}$/);
  const ids = body.components.map((c) => c.componentId).sort();
  assert.deepEqual(ids, ["test.gradle", "test.jdk"]);
  const jdk = body.components.find((c) => c.componentId === "test.jdk");
  assert.equal(jdk.displayName, "Test JDK");
  assert.equal(jdk.state, "ready");
  assert.equal(jdk.version, "1.0");
  assert.equal("remediation" in jdk, true);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("realPath"), false);
  assert.equal(serialized.includes("fileIdentity"), false);
  assert.equal(serialized.includes("publisher"), false);
  assert.equal(serialized.includes("discovery"), false);
  assert.equal(serialized.includes("install"), false);
});

test("inspect filters to the requested target only", async () => {
  setResolverMode("ready");
  const { deps } = makeDeps(new PlanApplier({}));
  const body = parse(await inspectDevelopmentEnvironment({ targets: ["dotnet"] }, deps));
  assert.deepEqual(body.components.map((c) => c.componentId), ["microsoft.visualstudio.2022.buildtools"]);
});

test("inspect rejects duplicate targets and extra caller fields", () => {
  assert.throws(() => inspectInputSchema.parse({ targets: ["android", "android"] }));
  assert.throws(() => inspectInputSchema.parse({ targets: ["android"], url: "https://evil" }));
  assert.throws(() => inspectInputSchema.parse({ targets: [], executable: "x" }));
  assert.throws(() => inspectInputSchema.parse({ targets: ["android"], args: ["--evil"] }));
});

test("inspect requires an authenticated owner", async () => {
  setResolverMode("ready");
  const { deps } = makeDeps(new PlanApplier({}));
  const noUser = { ...deps, userId: () => null };
  const result = await inspectDevelopmentEnvironment({ targets: ["android"] }, noUser);
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "AUTHENTICATION_REQUIRED");
});

// --------------------------------------------------------------- plan ---

test("plan builds a signed single-use plan with a redacted summary", async () => {
  setResolverMode("ready");
  let applied = 0;
  const applier = new PlanApplier({ localLaunch: async () => { applied += 1; return { success: true }; } });
  const { deps } = makeDeps(applier);
  const result = await planEnvironmentChanges(
    { targets: ["android"], components: ["test.jdk"], intent: "install" },
    deps,
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.match(body.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(body.intent, "install");
  assert.equal(body.operations.length, 1);
  const op = body.operations[0];
  assert.equal(op.componentId, "test.jdk");
  assert.equal(op.displayName, "Test JDK");
  assert.equal(op.target, "android");
  assert.deepEqual(op.versions, ["1.0"]);
  assert.equal(typeof op.privilege, "boolean");
  assert.equal(typeof op.reboot, "boolean");
  assert.equal(typeof op.downloadBytes, "number");
  assert.equal(typeof op.diskBytes, "number");
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("packageId"), false, "no install descriptor");
  assert.equal(serialized.includes("workloadId"), false);
  assert.equal(serialized.includes("artifactId"), false);
  assert.equal(serialized.includes('"url"'), false);
  assert.equal(serialized.includes("sha256"), false);
  assert.equal(serialized.includes("hmac"), false);
  assert.equal(serialized.includes("ownerKey"), false);
  assert.equal(serialized.includes("catalogDigest"), false);
  assert.equal(serialized.includes("environmentDigest"), false);
  assert.equal(serialized.includes("realPath"), false);
  assert.equal(applied, 0, "plan must not apply");
  assert.equal("applied" in body, false);
  assert.equal("applicationId" in body, false);
});

test("plan is plan-only and never invokes the applier", async () => {
  setResolverMode("ready");
  const applier = new PlanApplier({ localLaunch: async () => { throw new Error("must not be called"); } });
  const { deps } = makeDeps(applier);
  await planEnvironmentChanges(
    { targets: ["android"], components: ["test.jdk", "test.gradle"], intent: "update" },
    deps,
  );
});

test("plan rejects unknown components, cross-target components, and extra fields", async () => {
  setResolverMode("ready");
  const { deps } = makeDeps(new PlanApplier({}));
  await assert.rejects(
    () => planEnvironmentChanges({ targets: ["android"], components: ["unknown.x"], intent: "install" }, deps),
    /unknown component/,
  );
  await assert.rejects(
    () => planEnvironmentChanges({ targets: ["android"], components: ["microsoft.visualstudio.2022.buildtools"], intent: "install" }, deps),
    /not in the requested targets/,
  );
  assert.throws(() => planInputSchema.parse({ targets: ["android"], components: ["test.jdk"], intent: "install", url: "https://evil" }));
  assert.throws(() => planInputSchema.parse({ targets: ["android", "android"], components: ["test.jdk"], intent: "install" }));
  assert.throws(() => planInputSchema.parse({ targets: ["android"], components: [], intent: "repair" }));
});

// --------------------------------------------------------------- apply ---

test("apply elicits single-use approval before claiming and applying", async () => {
  setResolverMode("ready");
  const localCalls = [];
  const applier = new PlanApplier({
    localLaunch: async (op) => { localCalls.push(op.componentId); return { componentId: op.componentId, kind: "local", success: true }; },
  });
  const { deps } = makeDeps(applier);
  const plan = parse(await planEnvironmentChanges(
    { targets: ["android"], components: ["test.jdk"], intent: "install" },
    deps,
  ));

  const first = await applyEnvironmentPlan({ planId: plan.planId }, deps, context());
  assert.equal(first.resultType, "input_required");
  const state = await approvalStateCodec.verify(first.requestState, context());
  const result = await applyEnvironmentPlan(
    { planId: plan.planId },
    deps,
    context({ state, decision: "allow_once" }),
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(body.planId, plan.planId);
  assert.match(body.applicationId, /^[0-9a-f]{8}-/);
  assert.deepEqual(body.applied, ["test.jdk"]);
  assert.equal(body.completed, true);
  assert.deepEqual(localCalls, ["test.jdk"]);
});

test("apply rejects a single-use plan that was already applied", async () => {
  setResolverMode("ready");
  const applier = new PlanApplier({ localLaunch: async (op) => ({ componentId: op.componentId, kind: "local", success: true }) });
  const { deps } = makeDeps(applier);
  const plan = parse(await planEnvironmentChanges(
    { targets: ["android"], components: ["test.jdk"], intent: "install" },
    deps,
  ));
  await approveOnce({ planId: plan.planId }, deps);
  // Second apply: fresh approval, but the plan is already claimed.
  const second = await approveOnce({ planId: plan.planId }, deps);
  assert.equal(second.isError, true);
  assert.equal(parse(second).code, "ENVIRONMENT_PLAN_ALREADY_USED");
});

test("apply rejects an unknown plan id", async () => {
  setResolverMode("ready");
  const { deps } = makeDeps(new PlanApplier({}));
  const result = await applyEnvironmentPlan(
    { planId: "00000000-0000-0000-0000-000000000000" },
    deps,
    context(),
  );
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ENVIRONMENT_PLAN_NOT_FOUND");
});

test("apply rejects when the environment has changed since planning (stale)", async () => {
  setResolverMode("ready");
  const applier = new PlanApplier({ localLaunch: async (op) => ({ componentId: op.componentId, kind: "local", success: true }) });
  const { deps } = makeDeps(applier);
  const plan = parse(await planEnvironmentChanges(
    { targets: ["android"], components: ["test.jdk"], intent: "install" },
    deps,
  ));
  setResolverMode("drift"); // environment digest now differs
  const result = await approveOnce({ planId: plan.planId }, deps);
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ENVIRONMENT_PLAN_STALE");
});

test("apply maps a missing broker to BROKER_UNAVAILABLE for privileged steps", async () => {
  setResolverMode("ready");
  // No brokerClient and no localLaunch; the privileged VS Build Tools step
  // must be routed to the broker and fail as unavailable.
  const applier = new PlanApplier({});
  const { deps } = makeDeps(applier);
  const plan = parse(await planEnvironmentChanges(
    { targets: ["dotnet"], components: ["microsoft.visualstudio.2022.buildtools"], intent: "install" },
    deps,
  ));
  const result = await approveOnce({ planId: plan.planId }, deps);
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "BROKER_UNAVAILABLE");
});

test("apply rejects extra caller fields via Zod", () => {
  assert.throws(() => applyInputSchema.parse({ planId: "11111111-2222-3333-4444-555555555555", url: "https://evil" }));
  assert.throws(() => applyInputSchema.parse({ planId: "not-a-uuid" }));
  assert.throws(() => applyInputSchema.parse({ planId: "11111111-2222-3333-4444-555555555555", executable: "cmd.exe", args: [] }));
});

test("plan-store summary reports aggregate counts without secrets", () => {
  const store = new PlanStore(path.join(root, "summary-store"));
  // empty
  assert.deepEqual(store.summary(), { planned: 0, claimed: 0, applied: 0, total: 0 });
});
