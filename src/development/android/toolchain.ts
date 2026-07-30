/**
 * Trusted Android toolchain resolution.
 *
 * The Android adapter never accepts a caller-supplied executable, path, or
 * SDK location. Every binary it invokes must first appear as a `ready`
 * component in the inspected environment snapshot — the same snapshot the
 * environment broker bound to the active plan. This module resolves the
 * finite set of component ids the Android operations require and returns
 * either a fully-populated toolchain (internal use only; real paths never
 * leave the server) or a structured error naming only the missing/untrusted
 * component ids.
 */

import type { EnvironmentSnapshot, PrivateComponentSnapshot } from "../environment/inspect.js";

/**
 * The exact catalog component ids an Android operation may invoke. Adding an
 * id here requires the catalog to declare it and the environment inspector to
 * have resolved it to `ready`.
 */
export const ANDROID_TOOLCHAIN_COMPONENTS = [
  "microsoft.openjdk.17",
  "org.gradle.distribution",
  "google.android.commandlinetools",
  "google.android.platform-tools",
  "google.android.emulator",
  "google.android.build-tools.35",
] as const;

export interface AndroidToolchain {
  java: string;
  gradle: string;
  sdkmanager: string;
  avdmanager: string;
  adb: string;
  emulator: string;
  apksigner: string;
}

export type ToolchainResolution =
  | { toolchain: AndroidToolchain }
  | { error: "ENVIRONMENT_MISSING" | "TOOLCHAIN_UNTRUSTED"; componentIds: string[] };

function findComponent(
  snapshot: EnvironmentSnapshot,
  componentId: string,
): PrivateComponentSnapshot | undefined {
  return snapshot.components.find((c) => c.componentId === componentId);
}

/**
 * Replace the last occurrence of `fromName` with `toName` in a trusted
 * executable path, deriving a sibling binary in the same reviewed directory.
 * Used only for `avdmanager` (shipped with `sdkmanager`). If `fromName` is not
 * present the original path is returned unchanged so the adapter fails loudly
 * rather than guessing.
 */
function siblingExecutable(trustedPath: string, fromName: string, toName: string): string {
  const idx = trustedPath.lastIndexOf(fromName);
  if (idx === -1) return trustedPath;
  return trustedPath.slice(0, idx) + toName + trustedPath.slice(idx + fromName.length);
}

/**
 * Resolve the Android toolchain from an inspected environment snapshot.
 *
 * The `commandlinetools` component provides both `sdkmanager` and
 * `avdmanager`; the catalog ships them as one package. The `build-tools`
 * component provides `apksigner`. A component that is `ready` but lacks a
 * resolved real path is treated as missing — the adapter must never guess a
 * location.
 */
export function resolveAndroidToolchain(snapshot: EnvironmentSnapshot): ToolchainResolution {
  const missing: string[] = [];
  const untrusted: string[] = [];

  for (const componentId of ANDROID_TOOLCHAIN_COMPONENTS) {
    const component = findComponent(snapshot, componentId);
    if (!component) {
      missing.push(componentId);
      continue;
    }
    if (component.state === "missing") {
      missing.push(componentId);
      continue;
    }
    if (component.state === "untrusted" || component.state === "incompatible") {
      untrusted.push(componentId);
      continue;
    }
    // ready
    if (!component.realPath) {
      missing.push(componentId);
    }
  }

  if (untrusted.length > 0) {
    return { error: "TOOLCHAIN_UNTRUSTED", componentIds: untrusted };
  }
  if (missing.length > 0) {
    return { error: "ENVIRONMENT_MISSING", componentIds: missing };
  }

  const lookup = (id: string): string => findComponent(snapshot, id)!.realPath!;

  const commandlinetools = lookup("google.android.commandlinetools");
  const buildTools = lookup("google.android.build-tools.35");

  return {
    toolchain: {
      java: lookup("microsoft.openjdk.17"),
      gradle: lookup("org.gradle.distribution"),
      sdkmanager: commandlinetools,
      // avdmanager ships alongside sdkmanager in the cmdline-tools bin dir;
      // derive its path from the trusted sdkmanager path without guessing a
      // location (same directory, reviewed component).
      avdmanager: siblingExecutable(commandlinetools, "sdkmanager", "avdmanager"),
      adb: lookup("google.android.platform-tools"),
      emulator: lookup("google.android.emulator"),
      apksigner: buildTools,
    },
  };
}
