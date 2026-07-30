import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-android-tool-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "android-tool-secret-0123456789ab";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const {
  androidDevelopmentInputSchema,
  androidDevelopment,
} = await import("../dist/tools/androidDevelopment.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");

test.after(async () => rm(root, { recursive: true, force: true }));

// ----------------------------------------------------------- test harness ---

/** Fake coordinator that records enqueue calls and returns a queued record. */
function makeCoordinator() {
  const enqueued = [];
  let counter = 0;
  return {
    enqueued,
    enqueue(input) {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const record = {
        version: 1,
        id,
        ownerKey: input.ownerKey,
        tool: input.tool,
        action: input.action,
        class: input.class,
        resources: input.resources,
        state: "queued",
        stage: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      };
      enqueued.push({ input, record });
      return record;
    },
  };
}

/** Fake inspector returning a snapshot with ready Android toolchain components. */
function makeInspector() {
  return {
    async inspect() {
      const components = [
        "microsoft.openjdk.17",
        "org.gradle.distribution",
        "google.android.commandlinetools",
        "google.android.platform-tools",
        "google.android.emulator",
        "google.android.build-tools.35",
      ].map((id) => ({
        componentId: id,
        target: "android",
        state: "ready",
        realPath: `/fake/${id}/bin/${id === "google.android.commandlinetools" ? "sdkmanager" : id}`,
        fileIdentity: `id-${id}`,
        version: "1.0",
      }));
      return {
        snapshot: {
          version: 1,
          catalogDigest: "d".repeat(64),
          digest: "e".repeat(64),
          createdAt: new Date().toISOString(),
          components,
        },
      };
    },
  };
}

function makeProvider(projectRoot) {
  return {
    ecosystem: "android",
    async inspect(r) {
      return {
        ecosystem: "android",
        root: r,
        gradleFiles: existsSync(path.join(r, "settings.gradle.kts")) ? ["settings.gradle.kts"] : [],
        manifestPackage: "com.example.app",
      };
    },
    templates() {
      return [{ id: "kotlin-basic", displayName: "Kotlin — Basic", description: "minimal" }];
    },
  };
}

function makeCredentialStore() {
  const ids = new Set(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  return {
    has: (id) => ids.has(id),
    list: () => [],
    get: (id) => (ids.has(id) ? { id, kind: "keystore", alias: "a", fingerprint: "f" } : undefined),
  };
}

function makeDeps(opts = {}) {
  const coordinator = makeCoordinator();
  return {
    deps: {
      coordinator,
      inspector: makeInspector(),
      projectProvider: makeProvider(),
      credentialStore: makeCredentialStore(),
      generateWrapper: () => ({ distributionSha256Sum: "a".repeat(64) }),
      userId: () => "owner",
      hasDirectoryAccess: () => true,
      runReadOnly: opts.runReadOnly ?? (() => ({ stdout: "", exitCode: 0 })),
      taskTimeoutMs: 60_000,
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

async function approveOnce(args, deps, ctx, decision = "allow_once", mode = "single_use") {
  const first = await androidDevelopment(args, deps, ctx);
  if (!("resultType" in first)) return first;
  assert.equal(first.resultType, "input_required", `${JSON.stringify(args)} must elicit approval`);
  const state = await approvalStateCodec.verify(first.requestState, context());
  return androidDevelopment(args, deps, context({ state, decision }));
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ----------------------------------------------------------- schema tests ---

test("schema rejects unknown fields, url, executable, and args", () => {
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "list_templates", url: "https://evil" }));
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "build", executable: "x" }));
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "install", args: ["--evil"] }));
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "inspect_project" })); // missing root
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "build", root: "/p", module: "app", variant: "debug", extra: 1 }));
});

test("schema rejects dangerous serial keywords", () => {
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "install", serial: "fastboot", hostApk: "/p/a.apk" }));
  assert.throws(() => androidDevelopmentInputSchema.parse({ action: "clear", serial: "bootloader", packageId: "com.x" }));
});

// ----------------------------------------------------- synchronous tests ---

test("inspect_project returns structured inspection", async () => {
  const { deps } = makeDeps();
  const body = parse(await androidDevelopment({ action: "inspect_project", root: "/proj" }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.project.ecosystem, "android");
  assert.equal(body.project.manifestPackage, "com.example.app");
});

test("list_templates returns reviewed templates", async () => {
  const { deps } = makeDeps();
  const body = parse(await androidDevelopment({ action: "list_templates" }, deps, context()));
  assert.equal(body.templates.length, 1);
  assert.equal(body.templates[0].id, "kotlin-basic");
});

test("list_devices parses adb output", async () => {
  const { deps } = makeDeps({
    runReadOnly: () => ({ stdout: "List of devices attached\nemulator-5554  device product:sdk model:sdk device:generic transport_id:1\n", exitCode: 0 }),
  });
  const body = parse(await androidDevelopment({ action: "list_devices" }, deps, context()));
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].serial, "emulator-5554");
  assert.equal(body.devices[0].state, "device");
  assert.equal(body.devices[0].emulator, true);
});

test("list_avds parses avdmanager output", async () => {
  const { deps } = makeDeps({
    runReadOnly: () => ({ stdout: "Available Android Virtual Devices:\n    Name: test_avd\n  Device: pixel\n    Path: /home/.android/avd/test_avd.avd\n  Target: Android 14\n", exitCode: 0 }),
  });
  const body = parse(await androidDevelopment({ action: "list_avds" }, deps, context()));
  assert.equal(body.avds.length, 1);
  assert.equal(body.avds[0].name, "test_avd");
});

test("synchronous actions require an authenticated owner", async () => {
  const { deps } = makeDeps();
  const noUser = { ...deps, userId: () => null };
  const result = await androidDevelopment({ action: "list_templates" }, noUser, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "AUTHENTICATION_REQUIRED");
});

// --------------------------------------------------------- gradle tests ---

async function makeGradleProject() {
  const proj = await mkdtemp(path.join(os.tmpdir(), "android-gradle-"));
  await writeFile(path.join(proj, "gradlew"), "#!/bin/sh\nexit 0\n");
  await mkdir(path.join(proj, "gradle/wrapper"), { recursive: true });
  await writeFile(
    path.join(proj, "gradle/wrapper/gradle-wrapper.properties"),
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.0-bin.zip\ndistributionSha256Sum=" + "a".repeat(64) + "\n",
  );
  await writeFile(path.join(proj, "settings.gradle.kts"), 'include(":app")\n');
  await mkdir(path.join(proj, "app"), { recursive: true });
  await writeFile(path.join(proj, "app/build.gradle.kts"), 'plugins { id("com.android.application") }\n');
  return proj;
}

test("build elicits standard approval then enqueues a build task", async () => {
  const proj = await makeGradleProject();
  const { deps, coordinator } = makeDeps();
  const first = await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context());
  assert.equal(first.resultType, "input_required", "build must elicit standard approval");
  const state = await approvalStateCodec.verify(first.requestState, context());
  const second = await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context({ state, decision: "allow_once" }));
  const body = parse(second);
  assert.equal(body.ok, true);
  assert.equal(body.state, "queued");
  assert.equal(coordinator.enqueued.length, 1);
  assert.equal(coordinator.enqueued[0].input.class, "build");
  assert.equal(coordinator.enqueued[0].input.resources[0], proj);
  await rm(proj, { recursive: true, force: true });
});

test("build rejects unknown module", async () => {
  const proj = await makeGradleProject();
  const { deps } = makeDeps();
  const result = await androidDevelopment({ action: "build", root: proj, module: "nope", variant: "debug" }, deps, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_MODULE_UNKNOWN");
  await rm(proj, { recursive: true, force: true });
});

test("build rejects untrusted wrapper", async () => {
  const proj = await mkdtemp(path.join(os.tmpdir(), "android-nogradle-"));
  // no gradlew / no wrapper properties
  await writeFile(path.join(proj, "settings.gradle.kts"), 'include(":app")\n');
  const { deps } = makeDeps();
  const result = await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_WRAPPER_INVALID");
  await rm(proj, { recursive: true, force: true });
});

test("standard approval can be remembered for unchanged script", async () => {
  const proj = await makeGradleProject();
  const { deps } = makeDeps();
  // allow_session makes subsequent identical calls skip elicitation
  const first = await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context());
  const state = await approvalStateCodec.verify(first.requestState, context());
  await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context({ state, decision: "allow_session" }));
  // second call should NOT elicit (remembered)
  const third = await androidDevelopment({ action: "build", root: proj, module: "app", variant: "debug" }, deps, context());
  assert.equal("resultType" in third, false, "session approval must be remembered");
  assert.equal(parse(third).ok, true);
  await rm(proj, { recursive: true, force: true });
});

// --------------------------------------------------- single-use device tests ---

test("install elicits single-use approval then enqueues", async () => {
  const { deps, coordinator } = makeDeps();
  const args = { action: "install", serial: "emulator-5554", hostApk: "/proj/app.apk" };
  const body = parse(await approveOnce(args, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.state, "queued");
  assert.equal(coordinator.enqueued.length, 1);
  assert.equal(coordinator.enqueued[0].input.action, "install");
});

test("single-use approval cannot be replayed (allow_session rejected)", async () => {
  const { deps } = makeDeps();
  const args = { action: "clear", serial: "emulator-5554", packageId: "com.example.app" };
  const first = await androidDevelopment(args, deps, context());
  const state = await approvalStateCodec.verify(first.requestState, context());
  // allow_session is not a valid single-use decision
  const second = await androidDevelopment(args, deps, context({ state, decision: "allow_session" }));
  assert.equal(second.isError, true);
  assert.equal(parse(second).code, "APPROVAL_DENIED");
});

test("device write on a non-allowed host path is denied before approval", async () => {
  const { deps } = makeDeps();
  const custom = { ...deps, hasDirectoryAccess: () => false };
  const result = await androidDevelopment({ action: "install", serial: "emulator-5554", hostApk: "/secret/app.apk" }, custom, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_HOST_PATH_DENIED");
});

test("push rejects a denied device path before approval", async () => {
  const { deps } = makeDeps();
  // /data is a denied root
  const result = await androidDevelopment({ action: "push", serial: "emulator-5554", hostFile: "/proj/f", deviceFile: "/data/app/x" }, deps, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_DEVICE_PATH_DENIED");
});

test("forward enqueues after single-use approval", async () => {
  const { deps, coordinator } = makeDeps();
  const body = parse(await approveOnce({ action: "forward", serial: "emulator-5554", localPort: 8080, remoteSpec: "tcp:8081" }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(coordinator.enqueued[0].input.action, "forward");
});

test("diagnostic enqueues after single-use approval", async () => {
  const { deps } = makeDeps();
  const body = parse(await approveOnce({ action: "diagnostic", serial: "emulator-5554", diagnostic: "getprop_subset" }, deps, context()));
  assert.equal(body.ok, true);
});

// --------------------------------------------------- emulator / avd tests ---

test("emulator_start enqueues after single-use approval", async () => {
  const { deps, coordinator } = makeDeps();
  const body = parse(await approveOnce({ action: "emulator_start", avdName: "test_avd", port: 5554 }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(coordinator.enqueued[0].input.action, "emulator_start");
});

test("avd_create enqueues after single-use approval", async () => {
  const { deps } = makeDeps();
  const body = parse(await approveOnce({ action: "avd_create", avdName: "new_avd", packageId: "system-images;android-35;google_apis;x86_64", device: "pixel_6" }, deps, context()));
  assert.equal(body.ok, true);
});

// ----------------------------------------------------------- signing tests ---

test("sign enqueues with secretEnvRefs after single-use approval", async () => {
  const { deps, coordinator } = makeDeps();
  const args = {
    action: "sign",
    inApk: "/proj/app.apk",
    outApk: "/proj/app-signed.apk",
    keystore: "/proj/release.keystore",
    ksAlias: "release",
    ksCredentialId: "11111111-1111-4111-8111-111111111111",
    keyCredentialId: "22222222-2222-4222-8222-222222222222",
  };
  const body = parse(await approveOnce(args, deps, context()));
  assert.equal(body.ok, true);
  const launch = coordinator.enqueued[0].input.launch;
  assert.ok(launch.secretEnvRefs, "sign launch must carry secretEnvRefs");
  assert.equal(launch.secretEnvRefs.FEISHU_MCP_KS_PASS, "11111111-1111-4111-8111-111111111111");
});

test("sign rejects an unknown credential id before approval", async () => {
  const { deps } = makeDeps();
  const args = {
    action: "sign",
    inApk: "/proj/app.apk",
    outApk: "/proj/app-signed.apk",
    keystore: "/proj/release.keystore",
    ksAlias: "release",
    ksCredentialId: "33333333-3333-4333-8333-333333333333",
    keyCredentialId: "22222222-2222-4222-8222-222222222222",
  };
  const result = await androidDevelopment(args, deps, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_CREDENTIAL_UNKNOWN");
});

test("verify enqueues after single-use approval", async () => {
  const { deps } = makeDeps();
  const body = parse(await approveOnce({ action: "verify", inApk: "/proj/app.apk" }, deps, context()));
  assert.equal(body.ok, true);
});

// ------------------------------------------- legacy client denial test ---

test("legacy client that cannot elicit is denied", async () => {
  const { deps } = makeDeps();
  const noEnvelope = { mcpReq: { envelope: undefined, requestState: () => undefined, inputResponses: undefined } };
  const result = await androidDevelopment({ action: "install", serial: "emulator-5554", hostApk: "/proj/app.apk" }, deps, noEnvelope);
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "CLIENT_ELICITATION_UNSUPPORTED");
});

// ------------------------------------------- toolchain unavailable test ---

test("toolchain unavailable when a component is missing", async () => {
  const { deps } = makeDeps();
  const missing = { ...deps, inspector: { async inspect() { return { snapshot: { version: 1, catalogDigest: "d".repeat(64), digest: "e".repeat(64), createdAt: "", components: [] } }; } } };
  const result = await androidDevelopment({ action: "list_devices" }, missing, context());
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, "ANDROID_TOOLCHAIN_UNAVAILABLE");
});
