import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-worker-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "worker-test-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";
// Exercise the production default. The dedicated recovery test injects a
// 250ms stale window to cover prompt missing-worker interruption.
process.env.DEV_TASK_HEARTBEAT_MS = "2000";
process.env.DEV_TASK_CANCEL_GRACE_MS = "300";
process.env.MCP_AUTH_TOKEN = "must-not-reach-development-worker";
process.env.AUTH_PIN = "must-not-reach-development-worker-pin";

const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator, developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");
const { runWorker } = await import("../dist/development/tasks/worker.js");
const { issueWorkerToken } = await import("../dist/development/tasks/workerProtocol.js");

const fixture = path.resolve(import.meta.dirname, "fixtures/development-worker-fixture.mjs");
const ownerKey = developmentOwnerKey("owner");

test.after(async () => rm(root, { recursive: true, force: true }));

function newCoordinator() {
  const store = new DevelopmentTaskStore(path.join(root, "tasks-" + Math.random().toString(36).slice(2)));
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 30_000 });
  return new DevelopmentTaskCoordinator(store, scheduler, { approvalDataDir: root });
}

function launch(overrides = {}) {
  return {
    executable: process.execPath,
    args: [fixture],
    cwd: root,
    env: {},
    timeoutMs: 10_000,
    successExitCodes: [0],
    ...overrides,
  };
}

async function waitForState(store, id, state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = store.get(id);
    if (r?.state === state) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${id} did not reach ${state} within ${timeoutMs}ms (last: ${JSON.stringify(store.get(id)?.state)})`);
}

async function waitForTerminal(store, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"];
  while (Date.now() < deadline) {
    const r = store.get(id);
    if (r && terminal.includes(r.state)) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${id} did not terminate within ${timeoutMs}ms (last: ${JSON.stringify(store.get(id)?.state)})`);
}

async function assertNoSinkStaging(dir, targetName) {
  const names = await readdir(dir);
  assert.equal(names.some((name) => name.startsWith(`.${targetName}.`) && name.endsWith(".tmp")), false);
}

test("a successful fixture run reaches succeeded", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"], launch: launch({ args: [fixture, "--stdout", "hello"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.equal(final.exit?.code, 0);
  const log = await readFile(path.join(c.store.taskDir(task.id), "stdout.log"), "utf8");
  assert.match(log, /hello/);
});

test("a nonzero exit reaches failed", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"], launch: launch({ args: [fixture, "--exit", "3"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "failed");
  assert.equal(final.exit?.code, 3);
});

test("secret env values are redacted from logs", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({
      args: [fixture, "--env-echo", "FIXTURE_OUTPUT"],
      env: { FIXTURE_OUTPUT: "super-secret-value" },
    }),
  });
  await waitForTerminal(c.store, task.id);
  const log = await readFile(path.join(c.store.taskDir(task.id), "stdout.log"), "utf8");
  assert.doesNotMatch(log, /super-secret-value/);
  assert.match(log, /\[REDACTED\]/);
});

test("worker children do not inherit MCP credentials or worker tokens", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "environment-isolation",
    class: "default", resources: ["project:environment-isolation"],
    launch: launch({ args: [fixture, "--env-echo", "MCP_AUTH_TOKEN"] }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  const taskDir = c.store.taskDir(task.id);
  const stdout = await readFile(path.join(taskDir, "stdout.log"), "utf8");
  const launchJson = await readFile(path.join(taskDir, "launch.json"), "utf8");
  assert.doesNotMatch(stdout, /must-not-reach|FEISHU_MCP_WORKER_TOKEN/);
  assert.doesNotMatch(launchJson, /must-not-reach|FEISHU_MCP_WORKER_TOKEN/);
});

test("worker resolves secret refs in memory, injects them, and redacts split stdout and stderr", async () => {
  const store = new DevelopmentTaskStore(path.join(root, "injected-credential-worker"));
  const record = store.create({ ownerKey, tool: "android_development", action: "sign", class: "default", resources: ["credential-test"] });
  const secret = "resolved-plaintext-never-persist";
  store.saveLaunchSpec(record.id, launch({
    args: [fixture, "--env-echo-both-split", "FIXTURE_SECRET"],
    secretEnvRefs: { FIXTURE_SECRET: "11111111-1111-4111-8111-111111111111" },
  }));
  store.update(record.id, "queued", { state: "running" });
  const token = issueWorkerToken(store.taskDir(record.id));
  const resolver = {
    resolveRefs(refs) {
      assert.deepEqual(refs, { FIXTURE_SECRET: "11111111-1111-4111-8111-111111111111" });
      return new Map([["FIXTURE_SECRET", secret]]);
    },
    describe() { return "test credential resolver"; },
  };

  await runWorker({ taskDir: store.taskDir(record.id), token, approvalDataDir: path.join(root, "configured-approval"), credentialResolver: resolver });

  const final = store.get(record.id);
  assert.equal(final?.state, "succeeded");
  const stdout = await readFile(path.join(store.taskDir(record.id), "stdout.log"), "utf8");
  const stderr = await readFile(path.join(store.taskDir(record.id), "stderr.log"), "utf8");
  const launchJson = await readFile(store.launchPath(record.id), "utf8");
  const metadata = await readFile(store.metadataPath(record.id), "utf8");
  for (const persisted of [stdout, stderr, launchJson, metadata]) assert.doesNotMatch(persisted, new RegExp(secret));
  assert.match(stdout, /\[REDACTED\]/);
  assert.match(stderr, /\[REDACTED\]/);
  assert.equal(process.env.FIXTURE_SECRET, undefined);
});

test("worker reports only stable credential failure and never spawns the target", async () => {
  const store = new DevelopmentTaskStore(path.join(root, "failed-credential-worker"));
  const marker = path.join(root, "must-not-be-created.txt");
  const record = store.create({ ownerKey, tool: "android_development", action: "sign", class: "default", resources: ["credential-test-fail"] });
  store.saveLaunchSpec(record.id, launch({
    args: [fixture, "--artifact", marker],
    secretEnvRefs: { FIXTURE_SECRET: "11111111-1111-4111-8111-111111111111" },
  }));
  store.update(record.id, "queued", { state: "running" });
  const token = issueWorkerToken(store.taskDir(record.id));
  const resolver = { resolveRefs() { throw new Error("private helper diagnostic 11111111-1111-4111-8111-111111111111"); }, describe() { return "test"; } };

  await runWorker({ taskDir: store.taskDir(record.id), token, approvalDataDir: path.join(root, "configured-approval"), credentialResolver: resolver });

  const final = store.get(record.id);
  assert.equal(final?.state, "failed");
  assert.deepEqual(final?.exit, { code: null, errorCode: "CREDENTIAL_UNAVAILABLE", message: "credential unavailable" });
  await assert.rejects(readFile(marker), /ENOENT/);
  assert.doesNotMatch(JSON.stringify(final), /private helper|11111111/);
});

test("coordinator passes its configured approval data directory instead of deriving it from the task root", async () => {
  const configuredApproval = path.join(root, "configured-approval-data");
  const observedFile = path.join(root, "observed-approval-data.txt");
  const workerScript = path.join(root, "capture-approval-data.mjs");
  await writeFile(workerScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(observedFile)}, process.env.APPROVAL_DATA_DIR ?? "missing");`);
  const previousAmbient = process.env.APPROVAL_DATA_DIR;
  process.env.APPROVAL_DATA_DIR = path.join(root, "ambient-must-not-win");
  try {
    const store = new DevelopmentTaskStore(path.join(root, "unrelated-task-root", "nested"));
    const scheduler = new DevelopmentTaskScheduler({ total: 1, builds: 1, queueTimeoutMs: 30_000 });
    const coordinator = new DevelopmentTaskCoordinator(store, scheduler, {
      approvalDataDir: configuredApproval,
      workerScript,
      startupGraceMs: 100,
      pollIntervalMs: 20,
    });
    coordinator.enqueue({
      ownerKey, tool: "windows_development", action: "capture-approval",
      class: "default", resources: ["capture-approval"], launch: launch(),
    });
    const deadline = Date.now() + 5_000;
    let observed;
    while (Date.now() < deadline) {
      try { observed = await readFile(observedFile, "utf8"); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(observed, configuredApproval);
  } finally {
    process.env.APPROVAL_DATA_DIR = previousAmbient;
  }
});

test("worker captures exact binary stdout as a screenshot artifact without logging it", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "binary-sink-success");
  await mkdir(outputRoot, { recursive: true });
  const target = path.join(outputRoot, "screen.png");
  await writeFile(target, "previous-screenshot");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "screenshot",
    class: "default", resources: ["device:screenshot-success"],
    launch: launch({
      args: [fixture, "--stdout-hex", bytes.toString("hex")],
      artifactRoots: [outputRoot],
      binaryStdoutSinks: [{ stream: "stdout", type: "png", target, name: "screen.png", kind: "screenshot" }],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await readFile(path.join(c.store.taskDir(task.id), "stdout.log"))).length, 0);
  assert.equal((await readFile(path.join(c.store.taskDir(task.id), "stderr.log"))).length, 0);
  assert.deepEqual(final.artifacts.map(({ name, kind, size }) => ({ name, kind, size })), [
    { name: "screen.png", kind: "screenshot", size: bytes.length },
  ]);
  assert.match(final.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  await assertNoSinkStaging(outputRoot, "screen.png");
});

test("binary stdout sink preserves an existing target and cleans staging on nonzero exit", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "binary-sink-failure");
  await mkdir(outputRoot, { recursive: true });
  const target = path.join(outputRoot, "screen.png");
  await writeFile(target, "existing-target");
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "screenshot",
    class: "default", resources: ["device:screenshot-failure"],
    launch: launch({
      args: [fixture, "--stdout-hex", "89504e47ff", "--exit", "7"],
      artifactRoots: [outputRoot],
      binaryStdoutSinks: [{ stream: "stdout", type: "png", target, name: "screen.png", kind: "screenshot" }],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "failed");
  assert.equal(await readFile(target, "utf8"), "existing-target");
  assert.deepEqual(final.artifacts, []);
  await assertNoSinkStaging(outputRoot, "screen.png");
});

test("binary stdout sink cleans staging on cancellation and timeout", async () => {
  for (const mode of ["cancel", "timeout"]) {
    const c = newCoordinator();
    const outputRoot = path.join(root, `binary-sink-${mode}`);
    await mkdir(outputRoot, { recursive: true });
    const target = path.join(outputRoot, "screen.png");
    const task = c.enqueue({
      ownerKey, tool: "android_development", action: "screenshot",
      class: "default", resources: [`device:screenshot-${mode}`],
      launch: launch({
        args: [fixture, "--stdout-hex", "89504e47ff", "--sleep", "5000"],
        timeoutMs: mode === "timeout" ? 300 : 10_000,
        artifactRoots: [outputRoot],
        binaryStdoutSinks: [{ stream: "stdout", type: "png", target, name: "screen.png", kind: "screenshot" }],
      }),
    });
    await waitForState(c.store, task.id, "running");
    if (mode === "cancel") c.cancel(task.id, ownerKey);
    const final = await waitForTerminal(c.store, task.id, 15_000);
    assert.equal(final.state, mode === "cancel" ? "cancelled" : "failed");
    if (mode === "timeout") assert.equal(final.exit?.errorCode, "PROCESS_TIMEOUT");
    await assert.rejects(readFile(target), /ENOENT/);
    await assertNoSinkStaging(outputRoot, "screen.png");
  }
});

test("binary stdout sink rejects outside-root and junction targets before spawn", async () => {
  for (const mode of ["outside", "junction"]) {
    const c = newCoordinator();
    const outputRoot = path.join(root, `binary-boundary-${mode}`);
    const outsideRoot = path.join(root, `binary-boundary-${mode}-outside`);
    await mkdir(outputRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    let target = path.join(outsideRoot, "screen.png");
    if (mode === "junction") {
      const linked = path.join(outputRoot, "linked");
      await symlink(outsideRoot, linked, process.platform === "win32" ? "junction" : "dir");
      target = path.join(linked, "screen.png");
    }
    const marker = path.join(outsideRoot, `${mode}-spawned.txt`);
    const task = c.enqueue({
      ownerKey, tool: "android_development", action: "screenshot",
      class: "default", resources: [`device:screenshot-boundary-${mode}`],
      launch: launch({
        args: [fixture, "--artifact", marker, "--stdout-hex", "89504e47"],
        artifactRoots: [outputRoot],
        binaryStdoutSinks: [{ stream: "stdout", type: "png", target, name: "screen.png", kind: "screenshot" }],
      }),
    });
    const final = await waitForTerminal(c.store, task.id);
    assert.equal(final.state, "failed");
    assert.equal(final.exit?.errorCode, "ARTIFACT_SINK_INVALID");
    await assert.rejects(readFile(marker), /ENOENT/);
    await assert.rejects(readFile(target), /ENOENT/);
  }
});

test("worker publishes a verified Windows signing stage and records its artifact", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "windows-sign-publish");
  await mkdir(outputRoot, { recursive: true });
  const outFile = path.join(outputRoot, "signed.exe");
  const stagingPath = path.join(outputRoot, ".signed.0123456789ab.exe");
  await writeFile(outFile, "old-output");
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "sign", class: "default", resources: ["sign:publish"],
    launch: launch({
      args: [fixture, "--write-file", stagingPath],
      artifactRoots: [outputRoot],
      directArtifacts: [{ name: "signed.exe", path: outFile, kind: "windows-signed" }],
      windowsSigningCleanup: { stagingPath, outFile },
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.equal(await readFile(outFile, "utf8"), "verified-signed-output\n");
  await assert.rejects(readFile(stagingPath), /ENOENT/);
  assert.deepEqual(final.artifacts.map(({ name, kind, size }) => ({ name, kind, size })), [
    { name: "signed.exe", kind: "windows-signed", size: Buffer.byteLength("verified-signed-output\n") },
  ]);
});

test("worker preserves existing signed output and cleans staging on signing failure", async () => {
  for (const mode of ["nonzero", "cancel", "timeout"]) {
    const c = newCoordinator();
    const outputRoot = path.join(root, `windows-sign-${mode}`);
    await mkdir(outputRoot, { recursive: true });
    const outFile = path.join(outputRoot, "signed.exe");
    const stagingPath = path.join(outputRoot, `.signed.${mode.padEnd(12, "0")}.exe`);
    await writeFile(outFile, "old-output");
    const fixtureArgs = [fixture, "--write-file", stagingPath];
    if (mode === "nonzero") fixtureArgs.push("--exit", "9");
    else fixtureArgs.push("--sleep", "5000");
    const task = c.enqueue({
      ownerKey, tool: "windows_development", action: "sign", class: "default", resources: [`sign:${mode}`],
      launch: launch({
        args: fixtureArgs, timeoutMs: mode === "timeout" ? 300 : 10_000, artifactRoots: [outputRoot],
        directArtifacts: [{ name: "signed.exe", path: outFile, kind: "windows-signed" }],
        windowsSigningCleanup: { stagingPath, outFile },
      }),
    });
    await waitForState(c.store, task.id, "running");
    if (mode === "cancel") c.cancel(task.id, ownerKey);
    const final = await waitForTerminal(c.store, task.id, 15_000);
    assert.equal(final.state, mode === "cancel" ? "cancelled" : "failed");
    assert.equal(await readFile(outFile, "utf8"), "old-output");
    await assert.rejects(readFile(stagingPath), /ENOENT/);
    assert.deepEqual(final.artifacts, []);
  }
});

test("worker records only artifacts inside authorized real output roots", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "authorized-output");
  await mkdir(outputRoot, { recursive: true });
  const artifact = path.join(outputRoot, "app.apk");
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "build",
    class: "build", resources: ["project:artifact-safe"],
    launch: launch({
      args: [fixture, "--artifact", artifact],
      artifactRoots: [outputRoot],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.equal(final.artifacts.length, 1);
  assert.deepEqual(
    { name: final.artifacts[0].name, kind: final.artifacts[0].kind, size: final.artifacts[0].size },
    { name: "app.apk", kind: "fixture", size: Buffer.byteLength("artifact\n") },
  );
  assert.match(final.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(final.artifacts[0].path, await import("node:fs/promises").then((fs) => fs.realpath(artifact)));
});

test("worker rejects artifact manifests outside roots and through junctions", async () => {
  const c = newCoordinator();
  const outputRoot = path.join(root, "authorized-output-links");
  const outsideRoot = path.join(root, "outside-output");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const linked = path.join(outputRoot, "linked");
  await import("node:fs/promises").then((fs) =>
    fs.symlink(outsideRoot, linked, process.platform === "win32" ? "junction" : "dir")
  );
  const escapedArtifact = path.join(linked, "escaped.apk");
  const task = c.enqueue({
    ownerKey, tool: "android_development", action: "build",
    class: "build", resources: ["project:artifact-link"],
    launch: launch({
      args: [fixture, "--artifact", escapedArtifact],
      artifactRoots: [outputRoot],
    }),
  });
  const final = await waitForTerminal(c.store, task.id);
  assert.equal(final.state, "succeeded");
  assert.deepEqual(final.artifacts, []);
  assert.equal(await readFile(path.join(outsideRoot, "escaped.apk"), "utf8"), "artifact\n");
});

test("cancel while running reaches cancelled", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({ args: [fixture, "--sleep", "5000"], timeoutMs: 15_000 }),
  });
  await waitForState(c.store, task.id, "running");
  const res = c.cancel(task.id, ownerKey);
  assert.equal("cancelled" in res && res.cancelled, true);
  const final = await waitForTerminal(c.store, task.id, 15_000);
  assert.equal(final.state, "cancelled");
});

test("cancel before start (queued) reaches cancelled", async () => {
  const c = newCoordinator();
  // Occupy the shared resource so the second task stays queued.
  const blocker = c.enqueue({
    ownerKey, tool: "windows_development", action: "block",
    class: "build", resources: ["project:block"],
    launch: launch({ args: [fixture, "--sleep", "800"], timeoutMs: 10_000 }),
  });
  await waitForState(c.store, blocker.id, "running");
  const queued = c.enqueue({
    ownerKey, tool: "windows_development", action: "queued",
    class: "build", resources: ["project:block"],
    launch: launch({ args: [fixture, "--stdout", "queued"] }),
  });
  // same resource as the running blocker -> must be queued
  assert.equal(c.scheduler.summary().queued, 1);
  const res = c.cancel(queued.id, ownerKey);
  assert.equal("cancelled" in res && res.cancelled, true);
  const final = c.store.get(queued.id);
  assert.equal(final?.state, "cancelled");
  await waitForTerminal(c.store, blocker.id);
});

test("cross-owner cancel is denied", async () => {
  const c = newCoordinator();
  const task = c.enqueue({
    ownerKey, tool: "windows_development", action: "test_fixture",
    class: "build", resources: ["project:test"],
    launch: launch({ args: [fixture, "--sleep", "2000"], timeoutMs: 10_000 }),
  });
  await waitForState(c.store, task.id, "running");
  const res = c.cancel(task.id, "wrong-key");
  assert.equal("denied" in res && res.denied, true);
  c.cancel(task.id, ownerKey);
  await waitForTerminal(c.store, task.id, 15_000);
});
