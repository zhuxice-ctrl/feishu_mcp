import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  validateGradleWrapper,
  digestProjectScripts,
  planGradleAction,
  discoverModules,
} from "../dist/development/android/gradle.js";
import { collectArtifacts } from "../dist/development/android/artifacts.js";
import { resolveAndroidToolchain } from "../dist/development/android/toolchain.js";

function readySnapshot() {
  return {
    version: 1,
    catalogDigest: "d",
    digest: "x",
    createdAt: "2026-07-30T00:00:00.000Z",
    components: [
      snap("microsoft.openjdk.17", "ready", "C:\\jdk17\\bin\\java.exe", "17.0.11"),
      snap("org.gradle.distribution", "ready", "C:\\gradle\\bin\\gradle.bat", "8.9"),
      snap("google.android.commandlinetools", "ready", "C:\\sdk\\cmdline\\bin\\sdkmanager.bat", "11.0"),
      snap("google.android.platform-tools", "ready", "C:\\sdk\\platform-tools\\adb.exe", "35.0.2"),
      snap("google.android.emulator", "ready", "C:\\sdk\\emulator\\emulator.exe", "35.1.0"),
      snap("google.android.build-tools.35", "ready", "C:\\sdk\\build-tools\\35\\apksigner.bat", "35.0.0"),
    ],
  };
}
function snap(id, state, realPath, version) {
  return { componentId: id, target: "android", state, realPath, fileIdentity: `id:${id}`, version };
}
const toolchain = resolveAndroidToolchain(readySnapshot()).toolchain;

function makeProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradle-proj-"));
  fs.writeFileSync(
    path.join(root, "settings.gradle.kts"),
    'pluginManagement { repositories { google(); mavenCentral() } }\ninclude(":app")\ninclude(":lib")\n',
  );
  fs.writeFileSync(path.join(root, "build.gradle.kts"), "// root\n");
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/build.gradle.kts"), "// app\n");
  fs.writeFileSync(path.join(root, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g\n");
  const wrapperDir = path.join(root, "gradle", "wrapper");
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(
    path.join(wrapperDir, "gradle-wrapper.properties"),
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n" +
      "distributionSha256Sum=" + "a".repeat(64) + "\n",
  );
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "gradlew.bat"), "@echo off\n");
  // fake wrapper jar (text placeholder so digest is stable)
  fs.writeFileSync(path.join(wrapperDir, "gradle-wrapper.jar"), "JAR");
  Object.assign(overrides, {});
  return root;
}

test("validateGradleWrapper accepts a catalog-aligned wrapper", () => {
  const root = makeProject();
  const r = validateGradleWrapper(root);
  assert.equal(r.valid, true);
  assert.ok(r.distributionUrl?.includes("services.gradle.org"));
  assert.equal(r.distributionSha256Sum, "a".repeat(64));
  fs.rmSync(root, { recursive: true, force: true });
});

test("validateGradleWrapper rejects non-gradle distribution host", () => {
  const root = makeProject();
  const props = path.join(root, "gradle/wrapper/gradle-wrapper.properties");
  fs.writeFileSync(
    props,
    "distributionUrl=https\\://evil.example/gradle-8.9-bin.zip\ndistributionSha256Sum=" +
      "a".repeat(64) + "\n",
  );
  const r = validateGradleWrapper(root);
  assert.equal(r.valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("validateGradleWrapper rejects missing checksum", () => {
  const root = makeProject();
  const props = path.join(root, "gradle/wrapper/gradle-wrapper.properties");
  fs.writeFileSync(props, "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n");
  const r = validateGradleWrapper(root);
  assert.equal(r.valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("validateGradleWrapper rejects missing gradlew", () => {
  const root = makeProject();
  fs.rmSync(path.join(root, "gradlew"));
  fs.rmSync(path.join(root, "gradlew.bat"));
  const r = validateGradleWrapper(root);
  assert.equal(r.valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("discoverModules parses include declarations", () => {
  const root = makeProject();
  const modules = discoverModules(root);
  assert.ok(modules.includes("app"));
  assert.ok(modules.includes("lib"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("digestProjectScripts is stable for identical inputs", () => {
  const root = makeProject();
  const d1 = digestProjectScripts(root, "app");
  const d2 = digestProjectScripts(root, "app");
  assert.equal(d1, d2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("digestProjectScripts changes when a build script changes", () => {
  const root = makeProject();
  const d1 = digestProjectScripts(root, "app");
  fs.writeFileSync(path.join(root, "app/build.gradle.kts"), "// changed\n");
  const d2 = digestProjectScripts(root, "app");
  assert.notEqual(d1, d2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("digestProjectScripts redacts sensitive gradle.properties keys", () => {
  const root = makeProject();
  fs.appendFileSync(path.join(root, "gradle.properties"), "SIGNING_STORE_PASSWORD=hunter2\n");
  const d1 = digestProjectScripts(root, "app");
  fs.writeFileSync(
    path.join(root, "gradle.properties"),
    "org.gradle.jvmargs=-Xmx2g\nSIGNING_STORE_PASSWORD=another\n",
  );
  const d2 = digestProjectScripts(root, "app");
  // redacted -> digest unchanged despite secret value change
  assert.equal(d1, d2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("planGradleAction builds fixed flags and binds script digest", () => {
  const root = makeProject();
  const plan = planGradleAction(toolchain, {
    root,
    module: "app",
    variant: "debug",
    action: "build",
    timeoutMs: 600000,
  });
  assert.equal(plan.executable, "C:\\gradle\\bin\\gradle.bat");
  assert.deepEqual(plan.args, [
    "--no-daemon",
    "--console=plain",
    "--stacktrace",
    "-p",
    root,
    ":app:assembleDebug",
  ]);
  assert.equal(plan.cwd, root);
  assert.ok(plan.scriptDigest.length === 64);
  assert.deepEqual(plan.successExitCodes, [0]);
  assert.equal(plan.timeoutMs, 600000);
  assert.ok(plan.artifactRoots.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("planGradleAction rejects unknown module", () => {
  const root = makeProject();
  assert.throws(
    () =>
      planGradleAction(toolchain, {
        root,
        module: "nope",
        variant: "debug",
        action: "build",
        timeoutMs: 60000,
      }),
    /module/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("planGradleAction rejects untrusted wrapper", () => {
  const root = makeProject();
  const props = path.join(root, "gradle/wrapper/gradle-wrapper.properties");
  fs.writeFileSync(props, "distributionUrl=https\\://evil/gradle.zip\n");
  assert.throws(
    () =>
      planGradleAction(toolchain, {
        root,
        module: "app",
        variant: "debug",
        action: "build",
        timeoutMs: 60000,
      }),
    /wrapper/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("planGradleAction maps clean/test_unit/test_instrumented", () => {
  const root = makeProject();
  const clean = planGradleAction(toolchain, { root, module: "app", variant: "debug", action: "clean", timeoutMs: 1000 });
  assert.ok(clean.args.includes(":app:clean"));
  const unit = planGradleAction(toolchain, { root, module: "app", variant: "debug", action: "test_unit", timeoutMs: 1000 });
  assert.ok(unit.args.includes(":app:testDebugUnitTest"));
  const instr = planGradleAction(toolchain, { root, module: "app", variant: "debug", action: "test_instrumented", timeoutMs: 1000 });
  assert.ok(instr.args.includes(":app:connectedDebugAndroidTest"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("collectArtifacts gathers apk from build/outputs", () => {
  const root = makeProject();
  const apkDir = path.join(root, "app/build/outputs/apk/debug");
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(apkDir, "app-debug.apk"), "APKBYTES");
  const arts = collectArtifacts(root, "app", "debug", "build");
  assert.ok(arts.length >= 1);
  const apk = arts.find((a) => a.name === "app-debug.apk");
  assert.ok(apk, "apk artifact present");
  assert.equal(apk.kind, "apk");
  assert.ok(apk.size === Buffer.byteLength("APKBYTES"));
  assert.ok(apk.sha256 && apk.sha256.length === 64);
  fs.rmSync(root, { recursive: true, force: true });
});

test("collectArtifacts gathers aab for bundle release", () => {
  const root = makeProject();
  const dir = path.join(root, "app/build/outputs/bundle/release");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app-release.aab"), "AAB");
  const arts = collectArtifacts(root, "app", "release", "bundle");
  const aab = arts.find((a) => a.name === "app-release.aab");
  assert.ok(aab);
  assert.equal(aab.kind, "aab");
  fs.rmSync(root, { recursive: true, force: true });
});

test("collectArtifacts gathers junit xml and html report", () => {
  const root = makeProject();
  const tr = path.join(root, "app/build/test-results/testDebugUnitTest");
  fs.mkdirSync(tr, { recursive: true });
  fs.writeFileSync(path.join(tr, "TEST-com.x.xml"), "<tests/>");
  const rep = path.join(root, "app/build/reports/tests/testDebugUnitTest");
  fs.mkdirSync(rep, { recursive: true });
  fs.writeFileSync(path.join(rep, "index.html"), "<html/>");
  const arts = collectArtifacts(root, "app", "debug", "test_unit");
  assert.ok(arts.some((a) => a.kind === "junit-xml"));
  assert.ok(arts.some((a) => a.kind === "html-report"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("collectArtifacts refuses symlinks", () => {
  const root = makeProject();
  const apkDir = path.join(root, "app/build/outputs/apk/debug");
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(root, "secret.txt"), "secret");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(apkDir, "evil.apk"));
  const arts = collectArtifacts(root, "app", "debug", "build");
  assert.ok(!arts.some((a) => a.name === "evil.apk"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("collectArtifacts refuses files outside expected roots", () => {
  const root = makeProject();
  // a stray apk in the project root must not be collected
  fs.writeFileSync(path.join(root, "app-debug.apk"), "x");
  const arts = collectArtifacts(root, "app", "debug", "build");
  assert.ok(!arts.some((a) => a.name === "app-debug.apk"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("planGradleAction carries cancellation-aware timeout", () => {
  const root = makeProject();
  const plan = planGradleAction(toolchain, { root, module: "app", variant: "debug", action: "build", timeoutMs: 12345 });
  assert.equal(plan.timeoutMs, 12345);
  fs.rmSync(root, { recursive: true, force: true });
});
