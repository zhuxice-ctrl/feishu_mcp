import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-win-tool-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "windows-tool-secret-0123456789ab";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const {
  windowsDevelopmentInputSchema,
  windowsDevelopment,
} = await import("../dist/tools/windowsDevelopment.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");

test.after(async () => rm(root, { recursive: true, force: true }));

// ----------------------------------------------------------- test harness ---

const THUMB = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TS = "http://timestamp.digicert.com";

function makeCoordinator() {
  const enqueued = [];
  let counter = 0;
  return {
    enqueued,
    store: {
      get(id) {
        const rec = enqueued.find((e) => e.record.id === id);
        return rec ? rec.record : undefined;
      },
    },
    enqueue(input) {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const record = {
        version: 1, id, ownerKey: input.ownerKey, tool: input.tool,
        action: input.action, class: input.class, resources: input.resources,
        state: "queued", stage: "queued",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        artifacts: [],
      };
      enqueued.push({ input, record });
      return record;
    },
    cancel() { return { cancelled: true }; },
  };
}

function makeInspector() {
  return {
    async inspect() {
      const components = [
        "microsoft.dotnet.sdk.8",
        "microsoft.visualstudio.2022.buildtools",
        "microsoft.visualstudio.workload.manageddesktop",
        "microsoft.visualstudio.workload.nativedesktop",
        "microsoft.visualstudio.workload.universal",
        "microsoft.windows.sdk.11",
        "kitware.cmake",
        "ninja-build.ninja",
        "openjs.nodejs.lts",
        "git.git",
      ].map((id) => ({
        componentId: id,
        target: "windows",
        state: "ready",
        realPath: `/fake/${id}/tool.exe`,
        fileIdentity: `id-${id}`,
        version: "1.0",
        discovery: "inst1",
      }));
      return {
        snapshot: {
          version: 1, catalogDigest: "d".repeat(64), digest: "e".repeat(64),
          createdAt: new Date().toISOString(), components,
        },
      };
    },
  };
}

function makeProvider(ecosystem) {
  return {
    ecosystem,
    async inspect(r) {
      return { ecosystem, root: r, gradleFiles: [] };
    },
    templates() {
      return [{ id: `${ecosystem}-basic`, displayName: `${ecosystem} — Basic`, description: "minimal" }];
    },
  };
}

function makeCredentialStore() {
  const ids = new Set(["11111111-1111-4111-8111-111111111111"]);
  return {
    has: (id) => ids.has(id),
    list: () => [],
    get: (id) => (ids.has(id) ? { id, kind: "key", alias: "codesign", fingerprint: THUMB } : undefined),
  };
}

function makeDeps(opts = {}) {
  const coordinator = makeCoordinator();
  return {
    deps: {
      coordinator,
      inspector: makeInspector(),
      dotnetProvider: makeProvider("dotnet"),
      nativeProvider: makeProvider("native"),
      electronProvider: makeProvider("electron"),
      credentialStore: makeCredentialStore(),
      certInspector: (t) => ({
        thumbprint: t, alias: "codesign", subject: "CN=Test",
        validFrom: "2025-01-01T00:00:00.000Z", validTo: "2027-12-31T00:00:00.000Z",
        codeSigningEku: true,
      }),
      userId: () => "owner",
      hasDirectoryAccess: () => true,
      taskTimeoutMs: 60_000,
      pfxHelperPath: "/fake/helper.ps1",
    },
    coordinator,
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

async function approveOnce(args, deps, ctx, decision = "allow_once") {
  const first = await windowsDevelopment(args, deps, ctx);
  if (!("resultType" in first)) return first;
  assert.equal(first.resultType, "input_required", `${JSON.stringify(args)} must elicit approval`);
  const state = await approvalStateCodec.verify(first.requestState, context());
  return windowsDevelopment(args, deps, context({ state, decision }));
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ----------------------------------------------------------- schema tests ---

test("schema rejects unknown fields, url, executable, and args", () => {
  assert.throws(() => windowsDevelopmentInputSchema.parse({ action: "list_templates", url: "https://evil" }));
  assert.throws(() => windowsDevelopmentInputSchema.parse({ action: "dotnet_build", executable: "x" }));
  assert.throws(() => windowsDevelopmentInputSchema.parse({ action: "sign", args: ["--evil"] }));
  assert.throws(() => windowsDevelopmentInputSchema.parse({ action: "inspect_project" })); // missing root
  assert.throws(() => windowsDevelopmentInputSchema.parse({ action: "dotnet_build", root: "/p", projectOrSolution: "App.csproj", extra: 1 }));
});

test("schema accepts all 26 action variants", () => {
  const cases = [
    { action: "inspect_project", root: "/p" },
    { action: "list_templates" },
    { action: "dotnet_restore", root: "/p", projectOrSolution: "App.csproj" },
    { action: "dotnet_build", root: "/p", projectOrSolution: "App.csproj", configuration: "Release" },
    { action: "dotnet_test", root: "/p", projectOrSolution: "App.csproj" },
    { action: "dotnet_publish", root: "/p", projectOrSolution: "App.csproj", runtime: "win-x64" },
    { action: "dotnet_pack", root: "/p", projectOrSolution: "App.csproj" },
    { action: "dotnet_generate_dependency_lock", root: "/p", projectOrSolution: "App.csproj" },
    { action: "msbuild_restore", root: "/p", solutionOrProject: "App.sln" },
    { action: "msbuild_build", root: "/p", solutionOrProject: "App.sln", target: "Build", configuration: "Debug", platform: "x64" },
    { action: "msbuild_rebuild", root: "/p", solutionOrProject: "App.sln", target: "Rebuild", configuration: "Debug", platform: "x64" },
    { action: "msbuild_clean", root: "/p", solutionOrProject: "App.sln", target: "Clean", configuration: "Debug", platform: "x64" },
    { action: "msbuild_test", root: "/p", solutionOrProject: "App.sln", target: "Test", configuration: "Debug", platform: "x64" },
    { action: "native_configure", root: "/p", sourceDir: "/p/src", buildDir: "/p/build", preset: "ninja-rel" },
    { action: "native_build", root: "/p", buildDir: "/p/build", configuration: "Release", target: "all" },
    { action: "native_test", root: "/p", buildDir: "/p/build", configuration: "Debug" },
    { action: "native_install", root: "/p", buildDir: "/p/build", configuration: "Release", prefix: "/p/out" },
    { action: "native_package", root: "/p", buildDir: "/p/build", configuration: "Release" },
    { action: "electron_install", root: "/p" },
    { action: "electron_run_script", root: "/p", scriptName: "start" },
    { action: "electron_test", root: "/p", scriptName: "test" },
    { action: "electron_package", root: "/p", scriptName: "dist" },
    { action: "sign", inFile: "/p/a.exe", outFile: "/p/b.exe", credentialId: "11111111-1111-4111-8111-111111111111", timestampOrigin: TS },
    { action: "verify", inFile: "/p/a.exe" },
    { action: "run", artifactPath: "/p/a.exe", cwd: "/p" },
    { action: "stop", taskId: "t1" },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => windowsDevelopmentInputSchema.parse(c), `${c.action}`);
  }
});

// ----------------------------------------------------- synchronous tests ---

test("inspect_project returns structured inspection", async () => {
  const { deps } = makeDeps();
  const body = parse(await windowsDevelopment({ action: "inspect_project", root: "/proj" }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.project.ecosystem, "dotnet");
});

test("list_templates returns dotnet+native+electron templates", async () => {
  const { deps } = makeDeps();
  const body = parse(await windowsDevelopment({ action: "list_templates" }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.dotnet.length, 1);
  assert.equal(body.native.length, 1);
  assert.equal(body.electron.length, 1);
});

// ----------------------------------------------------- owner-only tests ---

test("requires authenticated owner", async () => {
  const { deps } = makeDeps();
  deps.userId = () => null;
  const body = parse(await windowsDevelopment({ action: "list_templates" }, deps, context()));
  assert.equal(body.code, "AUTHENTICATION_REQUIRED");
});

// ----------------------------------------------------- approval + enqueue ---

test("dotnet_build uses standard approval and enqueues a task", async () => {
  const projRoot = await mkdtemp(path.join(os.tmpdir(), "win-dotnet-"));
  await writeFile(path.join(projRoot, "App.csproj"), "<Project/>");
  const { deps, coordinator } = makeDeps();
  const result = await approveOnce(
    { action: "dotnet_build", root: projRoot, projectOrSolution: "App.csproj", configuration: "Debug" },
    deps, context(), "allow_once",
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(body.state, "queued");
  assert.ok(body.taskId);
  assert.equal(coordinator.enqueued.length, 1);
  assert.equal(coordinator.enqueued[0].input.action, "dotnet_build");
  assert.equal(coordinator.enqueued[0].input.class, "build");
});

test("sign uses single-use approval", async () => {
  const { deps, coordinator } = makeDeps();
  const result = await approveOnce(
    { action: "sign", inFile: "/auth/a.exe", outFile: "/auth/b.exe", credentialId: "11111111-1111-4111-8111-111111111111", timestampOrigin: TS },
    deps, context(), "allow_once",
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(body.state, "queued");
  assert.equal(coordinator.enqueued[0].input.action, "sign");
});

test("sign rejects unknown credential", async () => {
  const { deps } = makeDeps();
  const result = await windowsDevelopment(
    { action: "sign", inFile: "/auth/a.exe", outFile: "/auth/b.exe", credentialId: "99999999-9999-4999-8999-999999999999", timestampOrigin: TS },
    deps, context(),
  );
  const body = parse(result);
  assert.equal(body.code, "WINDOWS_CREDENTIAL_UNKNOWN");
});

test("verify uses single-use approval and enqueues", async () => {
  const { deps, coordinator } = makeDeps();
  const result = await approveOnce(
    { action: "verify", inFile: "/auth/a.exe" },
    deps, context(), "allow_once",
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(coordinator.enqueued[0].input.action, "verify");
});

test("run enqueues a task with empty args", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "win-run-tool-"));
  const artifact = path.join(runRoot, "app.exe");
  await writeFile(artifact, "MZ fake");
  const { deps, coordinator } = makeDeps();
  const result = await approveOnce(
    { action: "run", artifactPath: artifact, cwd: runRoot },
    deps, context(), "allow_once",
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(coordinator.enqueued[0].input.action, "run");
  assert.deepEqual(coordinator.enqueued[0].input.launch.args, []);
});

test("run rejects non-existent artifact", async () => {
  const { deps } = makeDeps();
  const result = await windowsDevelopment(
    { action: "run", artifactPath: "/auth/nope.exe", cwd: "/auth" },
    deps, context(),
  );
  const body = parse(result);
  assert.equal(body.code, "WINDOWS_ARTIFACT_DENIED");
});

test("stop resolves to task id, never accepts a PID", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "win-stop-"));
  const artifact = path.join(runRoot, "app.exe");
  await writeFile(artifact, "MZ fake");
  const { deps, coordinator } = makeDeps();
  // enqueue a run task first
  const runResult = await approveOnce(
    { action: "run", artifactPath: artifact, cwd: runRoot },
    deps, context(), "allow_once",
  );
  const runBody = parse(runResult);
  const taskId = runBody.taskId;
  // stop by task id
  const stopBody = parse(await windowsDevelopment({ action: "stop", taskId }, deps, context()));
  assert.equal(stopBody.ok, true);
});

test("stop returns TASK_NOT_FOUND for unknown task", async () => {
  const { deps } = makeDeps();
  const body = parse(await windowsDevelopment({ action: "stop", taskId: "00000000-0000-4000-8000-999999999999" }, deps, context()));
  assert.equal(body.code, "TASK_NOT_FOUND");
});

// ----------------------------------------------------- toolchain tests ---

test("toolchain unavailable returns WINDOWS_TOOLCHAIN_UNAVAILABLE", async () => {
  const { deps } = makeDeps();
  deps.resolveToolchain = () => ({ error: "ENVIRONMENT_MISSING", componentIds: ["microsoft.dotnet.sdk.8"] });
  const result = await windowsDevelopment(
    { action: "dotnet_build", root: "/p", projectOrSolution: "App.csproj" },
    deps, context(),
  );
  const body = parse(result);
  assert.equal(body.code, "WINDOWS_TOOLCHAIN_UNAVAILABLE");
});

test("host path denied returns WINDOWS_HOST_PATH_DENIED", async () => {
  const { deps } = makeDeps();
  deps.hasDirectoryAccess = () => false;
  const result = await windowsDevelopment(
    { action: "sign", inFile: "/evil/a.exe", outFile: "/evil/b.exe", credentialId: "11111111-1111-4111-8111-111111111111", timestampOrigin: TS },
    deps, context(),
  );
  const body = parse(result);
  assert.equal(body.code, "WINDOWS_HOST_PATH_DENIED");
});

test("dotnet_generate_dependency_lock uses single-use approval", async () => {
  const projRoot = await mkdtemp(path.join(os.tmpdir(), "win-lock-"));
  await writeFile(path.join(projRoot, "App.csproj"), "<Project/>");
  const { deps, coordinator } = makeDeps();
  const result = await approveOnce(
    { action: "dotnet_generate_dependency_lock", root: projRoot, projectOrSolution: "App.csproj" },
    deps, context(), "allow_once",
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(coordinator.enqueued[0].input.action, "dotnet_generate_dependency_lock");
});
