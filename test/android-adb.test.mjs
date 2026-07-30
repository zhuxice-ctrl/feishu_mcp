import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDevices, planAdbAction, validateDevicePath } from "../dist/development/android/adb.js";
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
const allowHost = (p) => p.startsWith("C:\\authorized\\");

const DEVICES_OUTPUT = `List of devices attached
emulator-5554          device product:emu64 model:Pixel_6 device:emu64x86_64 transport_id:1
emulator-5556          offline transport_id:2
1234567890abcdef       unauthorized transport_id:3
`;

test("parseDevices parses online, offline, and unauthorized devices", () => {
  const devices = parseDevices(DEVICES_OUTPUT);
  assert.equal(devices.length, 3);
  const d0 = devices[0];
  assert.equal(d0.serial, "emulator-5554");
  assert.equal(d0.state, "device");
  assert.equal(d0.model, "Pixel_6");
  assert.equal(d0.product, "emu64");
  assert.equal(d0.transportId, "1");
  assert.equal(d0.emulator, true);
  const d1 = devices[1];
  assert.equal(d1.state, "offline");
  const d2 = devices[2];
  assert.equal(d2.state, "unauthorized");
  assert.equal(d2.emulator, false);
});

test("parseDevices ignores header and empty lines", () => {
  const devices = parseDevices("List of devices attached\n\n");
  assert.equal(devices.length, 0);
});

test("planAdbAction devices needs no serial", () => {
  const p = planAdbAction(toolchain, { action: "devices" }, { authorizeHostPath: allowHost });
  assert.deepEqual(p.args, ["devices", "-l"]);
});

test("planAdbAction install requires authorized host apk", () => {
  const p = planAdbAction(
    toolchain,
    { action: "install", serial: "emulator-5554", hostApk: "C:\\authorized\\app.apk" },
    { authorizeHostPath: allowHost },
  );
  assert.deepEqual(p.args, ["-s", "emulator-5554", "install", "-r", "C:\\authorized\\app.apk"]);
});

test("planAdbAction install rejects unauthorized host path", () => {
  assert.throws(
    () =>
      planAdbAction(
        toolchain,
        { action: "install", serial: "emulator-5554", hostApk: "C:\\evil\\app.apk" },
        { authorizeHostPath: allowHost },
      ),
    /authorized|outside/i,
  );
});

test("planAdbAction push requires authorized host and allowed device root", () => {
  const p = planAdbAction(
    toolchain,
    { action: "push", serial: "emulator-5554", hostFile: "C:\\authorized\\data.bin", deviceFile: "/sdcard/data.bin" },
    { authorizeHostPath: allowHost },
  );
  assert.deepEqual(p.args, ["-s", "emulator-5554", "push", "C:\\authorized\\data.bin", "/sdcard/data.bin"]);
});

test("planAdbAction push rejects denied device root /data", () => {
  assert.throws(
    () =>
      planAdbAction(
        toolchain,
        { action: "push", serial: "emulator-5554", hostFile: "C:\\authorized\\data.bin", deviceFile: "/data/local/tmp/x" },
        { authorizeHostPath: allowHost },
      ),
    /device|path|denied/i,
  );
});

test("planAdbAction pull rejects path traversal on device path", () => {
  assert.throws(
    () =>
      planAdbAction(
        toolchain,
        { action: "pull", serial: "emulator-5554", deviceFile: "/sdcard/../../etc/passwd", hostFile: "C:\\authorized\\x" },
        { authorizeHostPath: allowHost },
      ),
    /traversal|\.\.|device|path/i,
  );
});

test("planAdbAction forward fixed", () => {
  const p = planAdbAction(
    toolchain,
    { action: "forward", serial: "emulator-5554", localPort: 8080, remoteSpec: "tcp:8080" },
    { authorizeHostPath: allowHost },
  );
  assert.deepEqual(p.args, ["-s", "emulator-5554", "forward", "tcp:8080", "tcp:8080"]);
});

test("planAdbAction diagnostic dumpsys_package", () => {
  const p = planAdbAction(
    toolchain,
    { action: "diagnostic", diagnostic: "dumpsys_package", serial: "emulator-5554", packageId: "com.example.app" },
    { authorizeHostPath: allowHost },
  );
  assert.deepEqual(p.args, ["-s", "emulator-5554", "shell", "dumpsys", "package", "com.example.app"]);
});

test("planAdbAction rejects missing serial for device-targeted action", () => {
  assert.throws(
    () =>
      planAdbAction(
        toolchain,
        { action: "force_stop", packageId: "com.example.app" },
        { authorizeHostPath: allowHost },
      ),
    /serial/i,
  );
});

test("validateDevicePath accepts sdcard and storage", () => {
  assert.equal(validateDevicePath("/sdcard/x"), "/sdcard/x");
  assert.equal(validateDevicePath("/storage/emulated/0/x"), "/storage/emulated/0/x");
});

test("validateDevicePath denies system roots", () => {
  for (const bad of ["/data/x", "/system/x", "/proc/x", "/sys/x", "/dev/x", "/vendor/x"]) {
    assert.throws(() => validateDevicePath(bad), /denied|root/i, `should deny ${bad}`);
  }
});

test("validateDevicePath rejects relative and traversal", () => {
  assert.throws(() => validateDevicePath("relative/x"));
  assert.throws(() => validateDevicePath("/sdcard/../etc"));
});

test("validateDevicePath rejects non-posix paths", () => {
  assert.throws(() => validateDevicePath("C:\\sdcard\\x"));
});
