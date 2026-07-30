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
import type {
  CredentialKind,
  CredentialMetadata,
  CredentialRegisterInput,
  CredentialResolver,
} from "./types.js";

const ALLOWED_KINDS: readonly CredentialKind[] = ["keystore", "key"];

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
