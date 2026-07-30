import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAvdList,
  planEmulatorStart,
  planEmulatorStop,
  planAvdCreate,
  bootReadinessCommands,
  AVD_NAME_REGEX,
} from "../dist/development/android/emulator.js";
import { resolveAndroidToolchain } from "../dist/development/android/toolchain.js";

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

const AVD_LIST_OUTPUT = `Available Android Virtual Devices:
    Name: test_avd
    Path: C:\\Users\\me\\.android\\avd\\test_avd.avd
    Target: Google Play (Google Inc.)
          Based on: Android 15 (API level 35)
    Name: pixel_avd
    Path: C:\\Users\\me\\.android\\avd\\pixel_avd.avd
    Target: Android 15 (API level 35)
`;

test("parseAvdList parses avd names", () => {
  const avds = parseAvdList(AVD_LIST_OUTPUT);
  assert.equal(avds.length, 2);
  assert.equal(avds[0].name, "test_avd");
  assert.ok(avds[0].path?.includes("test_avd.avd"));
  assert.equal(avds[1].name, "pixel_avd");
});

test("parseAvdList empty output returns no avds", () => {
  assert.equal(parseAvdList("Available Android Virtual Devices:\n").length, 0);
});

test("planEmulatorStart uses explicit avd and port", () => {
  const p = planEmulatorStart(toolchain, { avdName: "test_avd", port: 5554 });
  assert.equal(p.executable, "C:\\sdk\\emulator.exe");
  assert.ok(p.args.includes("-avd"));
  assert.ok(p.args.includes("test_avd"));
  assert.ok(p.args.includes("-port"));
  assert.ok(p.args.includes("5554"));
});

test("planEmulatorStart rejects arbitrary flags", () => {
  assert.throws(() =>
    planEmulatorStart(toolchain, { avdName: "test_avd", port: 5554, extra: "-shell" }),
  );
});

test("planEmulatorStart rejects invalid avd name", () => {
  assert.throws(() => planEmulatorStart(toolchain, { avdName: "bad name!", port: 5554 }), /avd/i);
});

test("planEmulatorStop uses adb emu kill with explicit serial", () => {
  const p = planEmulatorStop(toolchain, { serial: "emulator-5554" });
  assert.deepEqual(p.args, ["-s", "emulator-5554", "emu", "kill"]);
});

test("planAvdCreate sends no on stdin", () => {
  const p = planAvdCreate(toolchain, {
    avdName: "new_avd",
    packageId: "system-images;android-35;google_apis;x86_64",
    device: "pixel_6",
  });
  assert.equal(p.stdin, "no\n");
  assert.ok(p.args.includes("create"));
  assert.ok(p.args.includes("avd"));
  assert.ok(p.args.includes("--name"));
  assert.ok(p.args.includes("new_avd"));
  assert.ok(p.args.includes("--package"));
  assert.ok(p.args.includes("system-images;android-35;google_apis;x86_64"));
  assert.ok(p.args.includes("--device"));
  assert.ok(p.args.includes("pixel_6"));
});

test("planAvdCreate rejects shell metacharacter in avd name", () => {
  assert.throws(
    () =>
      planAvdCreate(toolchain, {
        avdName: "x; rm -rf /",
        packageId: "system-images;android-35;google_apis;x86_64",
        device: "pixel_6",
      }),
    /avd/i,
  );
});

test("bootReadinessCommands polls both boot props via explicit serial", () => {
  const cmds = bootReadinessCommands("C:\\sdk\\adb.exe", "emulator-5554");
  assert.equal(cmds.length, 2);
  const allArgs = cmds.map((c) => c.args.join(" "));
  assert.ok(allArgs.some((a) => a.includes("sys.boot_completed")));
  assert.ok(allArgs.some((a) => a.includes("dev.bootcomplete")));
  for (const c of cmds) {
    assert.ok(c.args.includes("-s"));
    assert.ok(c.args.includes("emulator-5554"));
  }
});

test("AVD_NAME_REGEX accepts and rejects expected values", () => {
  assert.ok(AVD_NAME_REGEX.test("test_avd"));
  assert.ok(AVD_NAME_REGEX.test("Pixel-6.1"));
  assert.ok(!AVD_NAME_REGEX.test("bad name!"));
  assert.ok(!AVD_NAME_REGEX.test("a;b"));
});
