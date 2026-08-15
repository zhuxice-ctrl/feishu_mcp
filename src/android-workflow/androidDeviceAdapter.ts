/**
 * AndroidDeviceAdapter — fixed `emulator-5554` ADB adapter.
 *
 * Every ADB command is prefixed with `-s emulator-5554`; the adapter never
 * accepts an arbitrary device serial from a Profile.  APK installation
 * validates the file path, declared package name, and SHA-256 digest before
 * invoking `adb install`.  Raw child-process handles are never exposed to
 * Profiles — only typed adapter methods are available.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "首版只接受已连接的 emulator-5554 … APK 安装前验证文件、包名和 SHA-256。"
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AndroidDeviceAdapter,
  ApkArtifact,
  DeviceInfo,
  RedactedArtifact,
  UiAssertion,
  UiTarget,
} from "./contracts.js";
import { redact } from "./redaction.js";

export const FIXED_DEVICE_ID = "emulator-5554" as const;

// ---------------------------------------------------------------------------
// Pure helpers — covered by unit tests without real ADB.
// ---------------------------------------------------------------------------

/**
 * Select `emulator-5554` from `adb devices` output lines.
 * Throws if the fixed device is absent or not in the "device" state.
 */
export function selectDevice(lines: ReadonlyArray<string>): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("List of devices")) continue;
    if (trimmed.length === 0) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (serial === FIXED_DEVICE_ID && state === "device") {
      return FIXED_DEVICE_ID;
    }
  }
  throw new Error(`emulator-5554 not found or not ready in adb devices output`);
}

/**
 * Build the ADB argument vector for a command, always prefixed with the
 * fixed device selector.
 */
export function buildAdbArgs(command: string[], ...extra: string[]): string[] {
  return ["-s", FIXED_DEVICE_ID, ...command, ...extra];
}

// ---------------------------------------------------------------------------
// APK validation
// ---------------------------------------------------------------------------

/**
 * Verify that an APK artifact's declared SHA-256 matches the actual file
 * digest.  Throws on mismatch.
 */
export async function verifyApkDigest(apk: ApkArtifact): Promise<void> {
  const buffer = await readFile(apk.path);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== apk.sha256) {
    throw new Error(`APK SHA-256 mismatch: expected ${apk.sha256}, got ${digest}`);
  }
}

// ---------------------------------------------------------------------------
// AdbDeviceAdapter — runs ADB against the fixed emulator.
// ---------------------------------------------------------------------------

function runAdb(args: string[], timeoutMs = 30_000): string {
  const result = spawnSync("adb", buildAdbArgs(args), {
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${redact(result.stderr ?? "")}`);
  }
  return result.stdout ?? "";
}

export class AdbDeviceAdapter implements AndroidDeviceAdapter {
  async preflight(deviceId: string): Promise<DeviceInfo> {
    if (deviceId !== FIXED_DEVICE_ID) {
      throw new Error(`deviceId must be ${FIXED_DEVICE_ID}, got: ${deviceId}`);
    }
    const output = runAdb(["devices"]);
    selectDevice(output.split(/\r?\n/));
    const apiLevel = parseInt(runAdb(["shell", "getprop", "ro.build.version.sdk"]).trim(), 10);
    const abi = runAdb(["shell", "getprop", "ro.product.cpu.abi"]).trim();
    return { deviceId: FIXED_DEVICE_ID, apiLevel, abi };
  }

  async install(apk: ApkArtifact): Promise<void> {
    await verifyApkDigest(apk);
    runAdb(["install", "-r", apk.path], 120_000);
  }

  async launch(packageName: string, activity?: string): Promise<void> {
    if (activity) {
      runAdb(["shell", "am", "start", "-n", `${packageName}/${activity}`]);
    } else {
      runAdb(["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
    }
  }

  async tap(target: UiTarget): Promise<void> {
    if (target.coordinates) {
      runAdb(["shell", "input", "tap", String(target.coordinates.x), String(target.coordinates.y)]);
      return;
    }
    throw new Error("tap requires coordinates");
  }

  async input(value: string): Promise<void> {
    runAdb(["shell", "input", "text", value]);
  }

  async assert(assertion: UiAssertion): Promise<void> {
    const timeoutMs = assertion.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const dump = runAdb(["shell", "uiautomator", "dump", "/dev/tty"], 15_000);
      if (assertion.kind === "text_present" && dump.includes(assertion.value)) return;
      if (assertion.kind === "text_absent" && !dump.includes(assertion.value)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`assertion failed (${assertion.kind}): ${redact(assertion.value)}`);
  }

  async screenshot(): Promise<RedactedArtifact> {
    const tmpPath = `/sdcard/staging_${Date.now()}.png`;
    runAdb(["shell", "screencap", "-p", tmpPath]);
    const localPath = `staging_${Date.now()}.png`;
    runAdb(["pull", tmpPath, localPath]);
    runAdb(["shell", "rm", tmpPath]);
    const buffer = await readFile(localPath);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    return { path: localPath, mimeType: "image/png", sha256, redacted: true };
  }

  async logcatTail(): Promise<string> {
    return redact(runAdb(["logcat", "-d", "-t", "100"]));
  }
}
