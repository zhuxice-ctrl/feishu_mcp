import { z } from "zod";
/**
 * Pure Android command builders.
 *
 * Each builder takes a resolved {@link AndroidToolchain} and a validated
 * action, and returns a fixed `{ executable, args, stdin? }` triple. Builders
 * are pure: they never read `process.env`, never touch the filesystem, and
 * never concatenate a shell string. Every eventual execution path uses
 * `shell: false`.
 *
 * Inputs are validated against strict Zod schemas (see {@link
 * ../development/android/types.ts}). Unknown fields, shell metacharacters in
 * identifiers, and a missing mandatory serial are rejected before any
 * executable path is referenced.
 */

import type { AndroidToolchain } from "./toolchain.js";
import {
  AdbCommandInput,
  GradleCommandInput,
  EmulatorCommandInput,
  AvdmanagerCommandInput,
  ApksignerCommandInput,
  AdbDiagnosticKind,
  type BuiltCommand,
  type AdbCommand,
  type GradleCommand,
  type EmulatorCommand,
  type AvdmanagerCommand,
  type ApksignerCommand,
} from "./types.js";

function parse<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
  return schema.parse(input);
}

/**
 * Build an ADB command. The `serial` is mandatory for every device-targeted
 * action — `devices` is the only serial-free action — so a second attached
 * device can never silently receive an operation meant for another.
 */
export function buildAdbCommand(
  toolchain: AndroidToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(AdbCommandInput, raw) as AdbCommand;
  const adb = toolchain.adb;
  switch (input.action) {
    case "devices":
      return { executable: adb, args: ["devices", "-l"] };

    case "start_app":
      return {
        executable: adb,
        args: [
          "-s", input.serial,
          "shell", "am", "start", "-n",
          `${input.packageId}/${input.activity}`,
        ],
      };

    case "force_stop":
      return {
        executable: adb,
        args: ["-s", input.serial, "shell", "am", "force-stop", input.packageId],
      };

    case "clear":
      return {
        executable: adb,
        args: ["-s", input.serial, "shell", "pm", "clear", input.packageId],
      };

    case "install":
      return {
        executable: adb,
        args: ["-s", input.serial, "install", "-r", input.hostApk],
      };

    case "uninstall":
      return {
        executable: adb,
        args: ["-s", input.serial, "shell", "pm", "uninstall", input.packageId],
      };

    case "screenshot":
      // screencap streams PNG to stdout; the worker captures it to hostPng.
      return {
        executable: adb,
        args: ["-s", input.serial, "exec-out", "screencap", "-p"],
      };

    case "logcat":
      return {
        executable: adb,
        args: ["-s", input.serial, "logcat", "-d", `--pid=${input.pid}`],
      };

    case "push":
      return {
        executable: adb,
        args: ["-s", input.serial, "push", input.hostFile, input.deviceFile],
      };

    case "pull":
      return {
        executable: adb,
        args: ["-s", input.serial, "pull", input.deviceFile, input.hostFile],
      };

    case "forward":
      return {
        executable: adb,
        args: [
          "-s", input.serial,
          "forward",
          `tcp:${input.localPort}`,
          input.remoteSpec,
        ],
      };

    case "diagnostic":
      return { executable: adb, args: diagnosticArgs(input.serial, input.diagnostic, input.packageId) };
  }
}

function diagnosticArgs(
  serial: string,
  kind: z.infer<typeof AdbDiagnosticKind>,
  packageId: string | undefined,
): string[] {
  switch (kind) {
    case "getprop_subset":
      return ["-s", serial, "shell", "getprop"];
    case "dumpsys_package":
      return ["-s", serial, "shell", "dumpsys", "package", packageId ?? ""].filter(
        (a) => a !== "",
      );
    case "dumpsys_activity":
      return ["-s", serial, "shell", "dumpsys", "activity"];
    case "pm_path":
      return ["-s", serial, "shell", "pm", "path", packageId ?? ""].filter(
        (a) => a !== "",
      );
    case "df_data":
      return ["-s", serial, "shell", "df", "/data"];
    case "pidof_package":
      return ["-s", serial, "shell", "pidof", packageId ?? ""].filter((a) => a !== "");
  }
}

/** Gradle task mapping. A caller never supplies a Gradle task or flag. */
const GRADLE_TASK: Record<GradleCommand["action"], (module: string, variant: string) => string> = {
  build: (m, v) => `:${m}:assemble${cap(v)}`,
  bundle: (m, v) => `:${m}:bundle${cap(v)}`,
  test_unit: (m, v) => `:${m}:test${cap(v)}UnitTest`,
  test_instrumented: (m, v) => `:${m}:connected${cap(v)}AndroidTest`,
  clean: (m) => `:${m}:clean`,
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildGradleCommand(
  toolchain: AndroidToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(GradleCommandInput, raw) as GradleCommand;
  const task = GRADLE_TASK[input.action](input.module, input.variant);
  return {
    executable: toolchain.gradle,
    args: ["--no-daemon", "--console=plain", "--stacktrace", "-p", input.projectDir, task],
  };
}

/** Adapter-owned emulator flag set; no arbitrary flag passthrough. */
export function buildEmulatorCommand(
  toolchain: AndroidToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(EmulatorCommandInput, raw) as EmulatorCommand;
  switch (input.action) {
    case "start":
      return {
        executable: toolchain.emulator,
        args: [
          "-avd", input.avdName,
          "-port", String(input.port),
          "-no-snapshot-save",
          "-no-boot-anim",
          "-gpu", "swiftshader_indirect",
        ],
      };
    case "stop":
      return {
        executable: toolchain.adb,
        args: ["-s", input.serial, "emu", "kill"],
      };
  }
}

export function buildAvdmanagerCommand(
  toolchain: AndroidToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(AvdmanagerCommandInput, raw) as AvdmanagerCommand;
  switch (input.action) {
    case "list":
      return { executable: toolchain.avdmanager, args: ["list", "avd"] };
    case "create":
      return {
        executable: toolchain.avdmanager,
        args: [
          "create", "avd",
          "--name", input.avdName,
          "--package", input.packageId,
          "--device", input.device,
          "--force",
        ],
        stdin: "no\n",
      };
  }
}

export function buildApksignerCommand(
  toolchain: AndroidToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(ApksignerCommandInput, raw) as ApksignerCommand;
  switch (input.action) {
    case "sign":
      return {
        executable: toolchain.apksigner,
        args: [
          "sign",
          "--ks", input.keystore,
          "--ks-key-alias", input.ksAlias,
          "--ks-pass", `env:${input.ksPassEnv}`,
          "--key-pass", `env:${input.keyPassEnv}`,
          "--out", input.outApk,
          input.inApk,
        ],
      };
    case "verify":
      return {
        executable: toolchain.apksigner,
        args: ["verify", "--verbose", "--print-certs", input.inApk],
      };
  }
}
