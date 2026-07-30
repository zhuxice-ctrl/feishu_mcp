import { test } from "node:test";
import assert from "node:assert/strict";

import { planAdbAction, validateDevicePath } from "../dist/development/android/adb.js";
import { resolveAndroidToolchain } from "../dist/development/android/toolchain.js";
import { ADB_DIAGNOSTIC_KINDS, isAllowedDiagnosticKind } from "../dist/development/android/adbDiagnostics.js";

function readySnapshot() {
  return {
    version: 1, catalogDigest: "d", digest: "x", createdAt: "2026-07-30T00:00:00.000Z",
    components: [
      { componentId: "microsoft.openjdk.17", target: "android", state: "ready", realPath: "C:\\jdk\\java.exe", fileIdentity: "i", version: "17" },
      { componentId: "org.gradle.distribution", target: "android", state: "ready", realPath: "C:\\gradle\\gradle.bat", fileIdentity: "i", version: "8.9" },
      { componentId: "google.android.commandlinetools", target: "android", state: "ready", realPath: "C:\\sdk\\cmdline\\sdkmanager.bat", fileIdentity: "i", version: "11" },
      { componentId: "google.android.platform-tools", target: "android", state: "ready", realPath: "C:\\sdk\\adb.exe", fileIdentity: "i", version: "35" },
      { componentId: "google.android.emulator", target: "android", state: "ready", realPath: "C:\\sdk\\emulator.exe", fileIdentity: "i", version: "35" },
      { componentId: "google.android.build-tools.35", target: "android", state: "ready", realPath: "C:\\sdk\\apksigner.bat", fileIdentity: "i", version: "35" },
    ],
  };
}
const toolchain = resolveAndroidToolchain(readySnapshot()).toolchain;
const allowHost = (p) => p.startsWith("C:\\authorized\\");
const opts = { authorizeHostPath: allowHost };

// Every case here must throw BEFORE any process spawn — i.e. at plan time.
const mustFail = (name, input) => {
  test(`security: ${name}`, () => {
    assert.throws(() => planAdbAction(toolchain, input, opts), Error);
  });
};

mustFail("pipe in serial", { action: "force_stop", serial: "x | cat", packageId: "com.example.app" });
mustFail("redirection in serial", { action: "force_stop", serial: "x > /tmp/p", packageId: "com.example.app" });
mustFail("command joining in serial", { action: "force_stop", serial: "x; whoami", packageId: "com.example.app" });
mustFail("backtick in serial", { action: "force_stop", serial: "x`id`", packageId: "com.example.app" });
mustFail("dollar substitution in serial", { action: "force_stop", serial: "x$HOME", packageId: "com.example.app" });
mustFail("su-like package id", { action: "force_stop", serial: "emulator-5554", packageId: "com.evil; su" });
mustFail("run-as injection in package", { action: "force_stop", serial: "emulator-5554", packageId: "com.evil && run-as" });
mustFail("setprop in remote spec", { action: "forward", serial: "emulator-5554", localPort: 8080, remoteSpec: "tcp:8080; setprop x y" });
mustFail("settings put in remote spec", { action: "forward", serial: "emulator-5554", localPort: 8080, remoteSpec: "tcp:8080 ; settings put" });
mustFail("pm install as package id", { action: "force_stop", serial: "emulator-5554", packageId: "com.x; pm install /evil" });
mustFail("arbitrary sh in package id", { action: "force_stop", serial: "emulator-5554", packageId: "com.x; sh -c evil" });
mustFail("host substitution in package id", { action: "force_stop", serial: "emulator-5554", packageId: "com.x $(cat /etc/passwd)" });
mustFail("path traversal in device path", { action: "push", serial: "emulator-5554", hostFile: "C:\\authorized\\x", deviceFile: "/sdcard/../../etc" });
mustFail("second device no serial", { action: "start_app", packageId: "com.example.app", activity: ".MainActivity" });
mustFail("bootloader keyword in serial", { action: "force_stop", serial: "bootloader", packageId: "com.example.app" });
mustFail("recovery keyword in serial", { action: "force_stop", serial: "recovery", packageId: "com.example.app" });

test("security: no raw shell token field accepted", () => {
  assert.throws(() =>
    planAdbAction(
      toolchain,
      { action: "force_stop", serial: "emulator-5554", packageId: "com.example.app", shell: "rm -rf /" },
      opts,
    ),
  );
});

test("security: extra command field rejected", () => {
  assert.throws(() =>
    planAdbAction(
      toolchain,
      { action: "force_stop", serial: "emulator-5554", packageId: "com.example.app", cmd: "su" },
      opts,
    ),
  );
});

test("ADB_DIAGNOSTIC_KINDS is a closed enum with no arbitrary token", () => {
  assert.ok(ADB_DIAGNOSTIC_KINDS.includes("dumpsys_package"));
  assert.ok(!ADB_DIAGNOSTIC_KINDS.includes("shell"));
  assert.equal(isAllowedDiagnosticKind("dumpsys_package"), true);
  assert.equal(isAllowedDiagnosticKind("shell"), false);
  assert.equal(isAllowedDiagnosticKind("getprop"), false); // getprop alone not allowed; only getprop_subset
});
