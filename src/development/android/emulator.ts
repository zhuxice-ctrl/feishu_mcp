/**
 * Emulator and AVD lifecycle planning.
 *
 * AVD creation, detached start, boot-readiness polling, and stop all use
 * fixed argument arrays produced by {@link buildEmulatorCommand} /
 * {@link buildAvdmanagerCommand}. The adapter exposes a finite, adapter-owned
 * emulator flag set; a caller can never pass an arbitrary emulator flag. Boot
 * readiness is probed through an explicit serial (`sys.boot_completed` and
 * `dev.bootcomplete`) — process creation is never treated as boot success.
 */

import { buildEmulatorCommand, buildAvdmanagerCommand } from "./commands.js";
import type { AndroidToolchain } from "./toolchain.js";
import { AVD_NAME_REGEX } from "./types.js";

export { AVD_NAME_REGEX };

export interface AvdInfo {
  name: string;
  path?: string;
  target?: string;
}

export function parseAvdList(output: string): AvdInfo[] {
  const avds: AvdInfo[] = [];
  let current: AvdInfo | null = null;
  for (const line of output.split(/\r?\n/)) {
    const nameMatch = line.match(/^\s*Name:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) avds.push(current);
      current = { name: nameMatch[1] };
      continue;
    }
    if (current) {
      const pathMatch = line.match(/^\s*Path:\s*(.+?)\s*$/);
      if (pathMatch) {
        current.path = pathMatch[1];
        continue;
      }
      const targetMatch = line.match(/^\s*Target:\s*(.+?)\s*$/);
      if (targetMatch) {
        current.target = targetMatch[1];
      }
    }
  }
  if (current) avds.push(current);
  return avds;
}

export interface EmulatorStartRequest {
  avdName: string;
  port: number;
}

export interface EmulatorStopRequest {
  serial: string;
}

export interface AvdCreateRequest {
  avdName: string;
  packageId: string;
  device: string;
}

export interface PlannedCommand {
  executable: string;
  args: string[];
  stdin?: string;
}

export function planEmulatorStart(
  toolchain: AndroidToolchain,
  request: EmulatorStartRequest,
): PlannedCommand {
  return buildEmulatorCommand(toolchain, { action: "start", ...request });
}

export function planEmulatorStop(
  toolchain: AndroidToolchain,
  request: EmulatorStopRequest,
): PlannedCommand {
  return buildEmulatorCommand(toolchain, { action: "stop", ...request });
}

export function planAvdCreate(
  toolchain: AndroidToolchain,
  request: AvdCreateRequest,
): PlannedCommand {
  return buildAvdmanagerCommand(toolchain, { action: "create", ...request });
}

/**
 * The two `getprop` commands used to poll boot readiness for an explicit
 * serial. The tool layer polls both until they report `1` or the timeout
 * elapses; neither process creation nor a single prop alone is treated as
 * boot success.
 */
export function bootReadinessCommands(adbPath: string, serial: string): PlannedCommand[] {
  return [
    {
      executable: adbPath,
      args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
    },
    {
      executable: adbPath,
      args: ["-s", serial, "shell", "getprop", "dev.bootcomplete"],
    },
  ];
}
