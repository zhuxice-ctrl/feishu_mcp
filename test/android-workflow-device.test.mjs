import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { selectDevice, buildAdbArgs, verifyApkDigest, FIXED_DEVICE_ID } = await import("../dist/android-workflow/androidDeviceAdapter.js");

test("selectDevice picks emulator-5554 from adb devices output", () => {
  const lines = [
    "List of devices attached",
    "emulator-5554\tdevice",
  ];
  assert.equal(selectDevice(lines), "emulator-5554");
});

test("selectDevice throws when emulator-5554 is absent", () => {
  assert.throws(() => selectDevice(["emulator-5556\tdevice"]), /emulator-5554/);
  assert.throws(() => selectDevice(["emulator-5554\toffline"]), /emulator-5554/);
  assert.throws(() => selectDevice([]), /emulator-5554/);
});

test("FIXED_DEVICE_ID is emulator-5554", () => {
  assert.equal(FIXED_DEVICE_ID, "emulator-5554");
});

test("buildAdbArgs prefixes every command with the fixed device selector", () => {
  assert.deepEqual(buildAdbArgs(["install", "-r"], "app.apk"), [
    "-s", "emulator-5554", "install", "-r", "app.apk",
  ]);
  assert.deepEqual(buildAdbArgs(["shell", "getprop", "ro.build.version.sdk"]), [
    "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk",
  ]);
});

test("verifyApkDigest passes when the digest matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apk-digest-"));
  const apkPath = path.join(dir, "app.apk");
  const content = "fake apk bytes";
  await writeFile(apkPath, content, "utf8");
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update(content).digest("hex");
  await verifyApkDigest({ path: apkPath, packageName: "tech.test.app", sha256: expected });
  await rm(dir, { recursive: true, force: true });
});

test("verifyApkDigest throws on mismatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apk-digest-"));
  const apkPath = path.join(dir, "app.apk");
  await writeFile(apkPath, "real content", "utf8");
  await assert.rejects(
    () => verifyApkDigest({ path: apkPath, packageName: "tech.test.app", sha256: "wrong" }),
    /SHA-256 mismatch/,
  );
  await rm(dir, { recursive: true, force: true });
});
