/**
 * Strict type contracts and validation schemas for the Android development
 * adapter.
 *
 * Every action input the MCP layer accepts is validated by a strict Zod schema
 * before it reaches a command builder. Schemas reject unknown fields (no
 * passthrough of arbitrary flags), reject shell metacharacters in identifiers,
 * and constrain free-form values to a closed enum where possible. Command
 * builders consume the validated, narrowed types and never touch `process.env`
 * or the filesystem.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifier validators
// ---------------------------------------------------------------------------

/**
 * Device serials: ADB serials are `emulator-NNNN` or hex USB serials. We
 * accept a conservative charset that excludes every shell metacharacter and
 * whitespace.
 */
export const DEVICE_SERIAL_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Android package id: dot-separated Java identifiers, e.g. `com.example.app`.
 * No whitespace, no shell metacharacters, no path separators.
 */
export const PACKAGE_ID_REGEX = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * Activity: a package id, or a leading-dot shorthand class (`.MainActivity`),
 * or a fully-qualified class (`com.example.app.MainActivity`).
 */
export const ACTIVITY_REGEX =
  /^(?:\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/;

/** AVD name: conservative charset, bounded length. */
export const AVD_NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * SDK package path as accepted by sdkmanager/avdmanager, e.g.
 * `system-images;android-35;google_apis;x86_64`. Semicolons are the SDK
 * separator; we still reject shell metacharacters and whitespace.
 */
export const SDK_PACKAGE_PATH_REGEX = /^[A-Za-z0-9._;:-]{1,256}$/;

/** A safe device path: absolute POSIX path under an adapter-allowed root. */
export const DEVICE_PATH_REGEX = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*$/;

/**
 * Serial-like keywords that name an ADB/fastboot *mode* rather than a device.
 * Rejecting them prevents an operation meant for a running device from being
 * routed at a bootloader/recovery/fastboot state.
 */
export const DANGEROUS_SERIAL_KEYWORDS = [
  "bootloader",
  "recovery",
  "sideload",
  "fastboot",
] as const;

const deviceSerial = z
  .string()
  .min(1)
  .max(128)
  .regex(DEVICE_SERIAL_REGEX, "invalid device serial")
  .refine(
    (value) => !(DANGEROUS_SERIAL_KEYWORDS as readonly string[]).includes(value),
    "dangerous serial keyword",
  );

const packageId = z
  .string()
  .min(1)
  .max(255)
  .regex(PACKAGE_ID_REGEX, "invalid package id");

const activity = z
  .string()
  .min(1)
  .max(255)
  .regex(ACTIVITY_REGEX, "invalid activity");

const avdName = z.string().min(1).max(64).regex(AVD_NAME_REGEX, "invalid avd name");

const sdkPackagePath = z
  .string()
  .min(1)
  .max(256)
  .regex(SDK_PACKAGE_PATH_REGEX, "invalid sdk package path");

const devicePath = z.string().min(1).max(1024).regex(DEVICE_PATH_REGEX, "invalid device path");

const hostPath = z.string().min(1).max(4096);

const port = z.number().int().min(1).max(65535);

const pid = z.number().int().min(1).max(2147483647);

/**
 * Adapter-owned device-path roots. Device write/transfer targets must be
 * canonical POSIX paths that normalize into one of these roots. System and
 * process-filesystem roots are always denied.
 */
export const ALLOWED_DEVICE_ROOTS = ["/sdcard", "/storage"] as const;

export const DENIED_DEVICE_ROOTS = [
  "/data",
  "/system",
  "/vendor",
  "/proc",
  "/sys",
  "/dev",
] as const;

// ---------------------------------------------------------------------------
// Action schemas
// ---------------------------------------------------------------------------

export const AdbDiagnosticKind = z.enum([
  "getprop_subset",
  "dumpsys_package",
  "dumpsys_activity",
  "pm_path",
  "df_data",
  "pidof_package",
]);

export const GradleAction = z.enum(["build", "bundle", "test_unit", "test_instrumented", "clean"]);
export const GradleVariant = z.enum(["debug", "release"]);
export const EmulatorAction = z.enum(["start", "stop"]);
export const AvdmanagerAction = z.enum(["list", "create"]);
export const ApksignerAction = z.enum(["sign", "verify"]);

const requireSerial = { serial: deviceSerial };

export const AdbCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("devices"),
    })
    .strict(),
  z
    .object({
      action: z.literal("start_app"),
      ...requireSerial,
      packageId,
      activity,
    })
    .strict(),
  z
    .object({
      action: z.literal("force_stop"),
      ...requireSerial,
      packageId,
    })
    .strict(),
  z
    .object({
      action: z.literal("clear"),
      ...requireSerial,
      packageId,
    })
    .strict(),
  z
    .object({
      action: z.literal("install"),
      ...requireSerial,
      hostApk: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("uninstall"),
      ...requireSerial,
      packageId,
    })
    .strict(),
  z
    .object({
      action: z.literal("screenshot"),
      ...requireSerial,
      hostPng: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("logcat"),
      ...requireSerial,
      pid,
    })
    .strict(),
  z
    .object({
      action: z.literal("push"),
      ...requireSerial,
      hostFile: hostPath,
      deviceFile: devicePath,
    })
    .strict(),
  z
    .object({
      action: z.literal("pull"),
      ...requireSerial,
      deviceFile: devicePath,
      hostFile: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("forward"),
      ...requireSerial,
      localPort: port,
      remoteSpec: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/, "invalid remote spec"),
    })
    .strict(),
  z
    .object({
      action: z.literal("diagnostic"),
      ...requireSerial,
      diagnostic: AdbDiagnosticKind,
      packageId: packageId.optional(),
    })
    .strict(),
]);

export const GradleCommandInput = z
  .object({
    action: GradleAction,
    module: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "invalid gradle module"),
    variant: GradleVariant,
    projectDir: hostPath,
  })
  .strict();

export const EmulatorCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      avdName,
      port,
    })
    .strict(),
  z
    .object({
      action: z.literal("stop"),
      serial: deviceSerial,
    })
    .strict(),
]);

export const AvdmanagerCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      avdName,
      packageId: sdkPackagePath,
      device: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9._-]+$/, "invalid device id"),
    })
    .strict(),
]);

export const ApksignerCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("sign"),
      inApk: hostPath,
      outApk: hostPath,
      keystore: hostPath,
      ksAlias: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._-]+$/, "invalid keystore alias"),
      ksPassEnv: z.literal("FEISHU_MCP_KS_PASS"),
      keyPassEnv: z.literal("FEISHU_MCP_KEY_PASS"),
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      inApk: hostPath,
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface BuiltCommand {
  executable: string;
  args: string[];
  stdin?: string;
}

export type AdbCommand = z.infer<typeof AdbCommandInput>;
export type GradleCommand = z.infer<typeof GradleCommandInput>;
export type EmulatorCommand = z.infer<typeof EmulatorCommandInput>;
export type AvdmanagerCommand = z.infer<typeof AvdmanagerCommandInput>;
export type ApksignerCommand = z.infer<typeof ApksignerCommandInput>;
