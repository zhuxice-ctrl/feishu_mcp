/**
 * ADB device inspection and structured action planning.
 *
 * Read-only device inspection parses `adb devices -l` output without trusting
 * extra tokens. Structured lifecycle, transfer, and forwarding actions are
 * produced by {@link buildAdbCommand} (fixed argument arrays, `shell: false`)
 * and then gated here by host-path authorization and device-path confinement:
 * a host file must be inside an authorized directory, and a device file must
 * be an absolute POSIX path under an adapter-allowed root (`/sdcard`, `/storage`)
 * — never under `/data`, `/system`, `/vendor`, `/proc`, `/sys`, or `/dev`.
 */

import path from "node:path";
import type { AndroidToolchain } from "./toolchain.js";
import { buildAdbCommand } from "./commands.js";
import {
  ALLOWED_DEVICE_ROOTS,
  DENIED_DEVICE_ROOTS,
  DEVICE_PATH_REGEX,
} from "./types.js";

export interface DeviceInfo {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  emulator: boolean;
}

export function parseDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  const lines = output.split(/\r?\n/);
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed.startsWith("List of devices")) started = true;
      continue;
    }
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    if (serial === "*") continue; // adb daemon warning line
    const info: DeviceInfo = { serial, state, emulator: serial.startsWith("emulator-") };
    for (const token of parts.slice(2)) {
      const kv = token.split(":");
      if (kv.length === 2) {
        const [k, v] = kv;
        if (k === "model") info.model = v;
        else if (k === "product") info.product = v;
        else if (k === "device") info.device = v;
        else if (k === "transport_id") info.transportId = v;
      }
    }
    devices.push(info);
  }
  return devices;
}

/**
 * Validate and normalize a device-side POSIX path. Rejects relative paths,
 * path traversal (`..`), non-POSIX paths, system/process-filesystem roots, and
 * any path that does not fall under an adapter-allowed root.
 */
export function validateDevicePath(devicePath: string): string {
  if (!DEVICE_PATH_REGEX.test(devicePath)) {
    throw new Error(`invalid device path: ${devicePath}`);
  }
  // Normalize and reject traversal: posix-style normalization.
  const normalized = normalizePosix(devicePath);
  if (normalized !== devicePath && !normalized.startsWith(devicePath.replace(/\/$/, ""))) {
    // detect any '..' segment that escaped
  }
  if (devicePath.split("/").includes("..")) {
    throw new Error(`path traversal denied: ${devicePath}`);
  }
  const denied = (DENIED_DEVICE_ROOTS as readonly string[]).some((root) =>
    normalized === root || normalized.startsWith(root + "/"),
  );
  if (denied) {
    throw new Error(`device path under denied root: ${devicePath}`);
  }
  const allowed = (ALLOWED_DEVICE_ROOTS as readonly string[]).some((root) =>
    normalized === root || normalized.startsWith(root + "/"),
  );
  if (!allowed) {
    throw new Error(`device path outside allowed roots: ${devicePath}`);
  }
  return normalized;
}

function normalizePosix(p: string): string {
  // Collapse duplicate slashes; do NOT resolve '..' here (we reject it above).
  return p.replace(/\/+/g, "/");
}

export interface AdbPlanOptions {
  /** Returns true if a host path is inside an authorized directory. */
  authorizeHostPath: (hostPath: string) => boolean;
}

export interface AdbPlan {
  executable: string;
  args: string[];
  stdin?: string;
}

const HOST_PATH_FIELDS = new Set(["hostApk", "hostPng", "hostFile"]);
const DEVICE_PATH_FIELDS = new Set(["deviceFile"]);

/**
 * Plan an ADB action: validate the input (strict Zod in {@link buildAdbCommand}),
 * authorize any host path, and confine any device path. Throws before any
 * process spawn if validation, authorization, or confinement fails.
 */
export function planAdbAction(
  toolchain: AndroidToolchain,
  input: unknown,
  options: AdbPlanOptions,
): AdbPlan {
  const built = buildAdbCommand(toolchain, input);
  const rec = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (HOST_PATH_FIELDS.has(key) && typeof value === "string") {
      if (!options.authorizeHostPath(value)) {
        throw new Error(`host path outside authorized directory: ${value}`);
      }
    }
    if (DEVICE_PATH_FIELDS.has(key) && typeof value === "string") {
      validateDevicePath(value);
    }
  }
  return built;
}

// Re-export path-adjacent helper for callers that build transfer roots.
export { path as nodePath };
