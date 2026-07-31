/**
 * Local DPAPI-backed credential metadata store and in-memory resolver.
 *
 * The store persists only non-secret metadata (id, kind, alias, fingerprint,
 * timestamps) in an owner-only `index.json` under
 * `<root>/credentials/`. The secret blob itself is written by the reviewed
 * PowerShell helper (`manage-development-credentials.ps1`), which prompts with
 * `Read-Host -AsSecureString`, encrypts with DPAPI CurrentUser, and never
 * accepts a plaintext secret on the command line. This module never reads or
 * holds a secret.
 *
 * `InMemoryCredentialResolver` is the worker-side resolver: it converts
 * `secretEnvRefs` to concrete env values in memory only and registers them
 * with the streaming redactor before spawn. Its `describe()` never includes a
 * secret value.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeRuntimeEnvironment } from "../tasks/runtimeEnvironment.js";
import type {
  CredentialKind,
  CredentialMetadata,
  CredentialRegisterInput,
  CredentialResolver,
} from "./types.js";

const ALLOWED_KINDS: readonly CredentialKind[] = ["keystore", "key", "certificate"];
const CREDENTIAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const RESOLVE_HELPER = fileURLToPath(
  new URL("../../../scripts/resolve-development-credential.ps1", import.meta.url),
);
// StreamingTaskRedactor retains at most 4095 bytes between chunks, so resolved
// values must stay within this bound to remain redaction-safe across writes.
const MAX_SECRET_BYTES = 4_096;
const HELPER_TIMEOUT_MS = 10_000;

interface CredentialHelperResult {
  status: number | null;
  stdout?: Buffer | Uint8Array | string | null;
  stderr?: Buffer | Uint8Array | string | null;
  error?: Error;
}

interface CredentialHelperOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
  encoding: "buffer";
}

export type CredentialHelperRunner = (
  executable: string,
  args: readonly string[],
  options: CredentialHelperOptions,
) => CredentialHelperResult;

export class CredentialResolutionError extends Error {
  readonly code = "CREDENTIAL_UNAVAILABLE" as const;

  constructor() {
    super("credential unavailable");
    this.name = "CredentialResolutionError";
  }
}

function helperBytes(value: CredentialHelperResult["stdout"]): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(value);
}

/**
 * Production resolver for DPAPI CurrentUser blobs. The executable and helper
 * are repository-owned constants; only the process runner is injectable for
 * non-Windows behavioral tests.
 */
export class WindowsDpapiCredentialResolver implements CredentialResolver {
  private readonly approvalDataDir: string;
  private readonly runner: CredentialHelperRunner;

  constructor(approvalDataDir: string, runner: CredentialHelperRunner = spawnSync as CredentialHelperRunner) {
    this.approvalDataDir = path.resolve(approvalDataDir);
    this.runner = runner;
  }

  resolveRefs(refs: Record<string, string>): Map<string, string> {
    const byId = new Map<string, string>();
    const resolved = new Map<string, string>();
    try {
      for (const [envName, credentialId] of Object.entries(refs)) {
        if (!CREDENTIAL_ID_RE.test(credentialId)) throw new CredentialResolutionError();
        let value = byId.get(credentialId);
        if (value === undefined) {
          value = this.resolveOne(credentialId);
          byId.set(credentialId, value);
        }
        resolved.set(envName, value);
      }
      byId.clear();
      return resolved;
    } catch {
      byId.clear();
      resolved.clear();
      throw new CredentialResolutionError();
    }
  }

  describe(): string {
    return "WindowsDpapiCredentialResolver";
  }

  private resolveOne(credentialId: string): string {
    const result = this.runner(
      WINDOWS_POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        RESOLVE_HELPER,
        "-CredentialId",
        credentialId,
      ],
      {
        env: { ...safeRuntimeEnvironment(), APPROVAL_DATA_DIR: this.approvalDataDir },
        shell: false,
        windowsHide: true,
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: MAX_SECRET_BYTES,
        encoding: "buffer",
      },
    );
    const stdout = helperBytes(result.stdout);
    const stderr = helperBytes(result.stderr);
    if (result.error || result.status !== 0 || stderr.length !== 0 || stdout.length > MAX_SECRET_BYTES) {
      stdout.fill(0);
      stderr.fill(0);
      throw new CredentialResolutionError();
    }
    try {
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
      if (value.includes("\0")) throw new CredentialResolutionError();
      return value;
    } catch {
      throw new CredentialResolutionError();
    } finally {
      stdout.fill(0);
      stderr.fill(0);
    }
  }
}

export class LocalCredentialStore {
  private readonly indexDir: string;
  private readonly indexPath: string;
  private entries: CredentialMetadata[];

  constructor(root: string) {
    this.indexDir = path.join(root, "credentials");
    this.indexPath = path.join(this.indexDir, "index.json");
    this.entries = this.load();
  }

  register(input: CredentialRegisterInput): CredentialMetadata {
    if (!ALLOWED_KINDS.includes(input.kind)) {
      throw new Error(`invalid credential kind: ${input.kind}`);
    }
    if (!input.alias || !input.fingerprint) {
      throw new Error("credential alias and fingerprint are required");
    }
    const now = new Date().toISOString();
    const entry: CredentialMetadata = {
      id: randomUUID(),
      kind: input.kind,
      alias: input.alias,
      fingerprint: input.fingerprint,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  list(): CredentialMetadata[] {
    return this.entries.map((e) => ({ ...e }));
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  get(id: string): CredentialMetadata | undefined {
    const entry = this.entries.find((e) => e.id === id);
    return entry ? { ...entry } : undefined;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  private load(): CredentialMetadata[] {
    if (!fs.existsSync(this.indexPath)) return [];
    try {
      const raw = fs.readFileSync(this.indexPath, "utf8");
      return JSON.parse(raw) as CredentialMetadata[];
    } catch {
      // Corrupt index: start empty rather than risk exposing partial data.
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(this.indexDir, { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexPath);
    // Re-assert owner-only mode (rename may preserve tmp mode on some systems).
    try {
      fs.chmodSync(this.indexPath, 0o600);
    } catch {
      // chmod is best-effort on non-posix; the 0600 write mode is the primary guard.
    }
  }
}

/**
 * Worker-side credential resolver. Holds secrets only in memory; `describe()`
 * returns a non-sensitive summary so the value can never leak through logs or
 * task metadata.
 */
export class InMemoryCredentialResolver implements CredentialResolver {
  private readonly secrets = new Map<string, string>();

  set(credentialId: string, value: string): void {
    this.secrets.set(credentialId, value);
  }

  resolveRefs(refs: Record<string, string>): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [envName, credentialId] of Object.entries(refs)) {
      if (!this.secrets.has(credentialId)) {
        throw new Error(`unknown credential id: ${credentialId}`);
      }
      resolved.set(envName, this.secrets.get(credentialId)!);
    }
    return resolved;
  }

  describe(): string {
    return `InMemoryCredentialResolver(refs=${this.secrets.size})`;
  }

  clear(): void {
    this.secrets.clear();
  }
}
