/**
 * TunnelAdapter — Windows OpenSSH alias adapter with fixed staging loopback
 * constraints.
 *
 * The adapter accepts only an SSH config alias (validated against a strict
 * character whitelist) and fixed staging loopback ports.  It never accepts
 * raw command strings, port ranges, or arbitrary host arguments from a
 * Profile.  Real process spawning is performed via Node child_process; the
 * exported `buildTunnelArgs` / `validateAlias` helpers are pure functions
 * covered by unit tests without side effects.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "SSH 只使用 Windows ~/.ssh/config alias，固定转发 staging loopback 端口。"
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  TunnelAdapter,
  TunnelSpec,
  TunnelHandle,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Alias validation — reject shell metacharacters and path separators.
// ---------------------------------------------------------------------------

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate an SSH alias.  Throws on shell metacharacters or path separators. */
export function validateAlias(alias: string): void {
  if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
    throw new Error(`invalid SSH alias: ${alias}`);
  }
}

/**
 * Build the OpenSSH argument vector for a staging loopback tunnel.
 *
 * The remote and local ports must be equal and must be 3100 — the fixed
 * staging loopback port.  The alias is validated first.
 */
export function buildTunnelArgs(
  alias: string,
  localPort: number,
  remotePort: number,
): string[] {
  validateAlias(alias);
  if (!Number.isInteger(localPort) || localPort !== 3100) {
    throw new Error(`localPort must be 3100, got: ${localPort}`);
  }
  if (!Number.isInteger(remotePort) || remotePort !== 3100) {
    throw new Error(`remotePort must be 3100, got: ${remotePort}`);
  }
  return [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    alias,
  ];
}

// ---------------------------------------------------------------------------
// OpenSshTunnelAdapter — spawns `ssh` with the validated argument vector.
// ---------------------------------------------------------------------------

export class OpenSshTunnelAdapter implements TunnelAdapter {
  private readonly processes = new Map<string, ChildProcess>();

  async connect(spec: TunnelSpec): Promise<TunnelHandle> {
    const args = buildTunnelArgs(spec.alias, spec.localPort, spec.remotePort);
    const child = spawn("ssh", args, { stdio: "ignore", shell: false });
    const handle: TunnelHandle = { spec, startedAt: Date.now() };
    this.processes.set(JSON.stringify(spec), child);
    return handle;
  }

  async disconnect(handle: TunnelHandle): Promise<void> {
    const key = JSON.stringify(handle.spec);
    const child = this.processes.get(key);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    this.processes.delete(key);
  }

  async probe(handle: TunnelHandle): Promise<boolean> {
    const key = JSON.stringify(handle.spec);
    const child = this.processes.get(key);
    return child?.exitCode === null;
  }
}
