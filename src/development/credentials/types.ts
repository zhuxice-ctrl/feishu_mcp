/**
 * Stable credential contracts for the development subsystem.
 *
 * Secrets never travel through MCP arguments, metadata, logs, or process
 * argument arrays. A secret is referenced only by an opaque credential id;
 * the worker resolves the id to an in-memory environment value (registered
 * with the streaming redactor) immediately before spawn and discards it
 * afterward. Metadata persisted on disk carries only id, kind, alias,
 * fingerprint, and timestamps.
 */

export type CredentialKind = "keystore" | "key";

export interface CredentialMetadata {
  id: string;
  kind: CredentialKind;
  alias: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRegisterInput {
  kind: CredentialKind;
  alias: string;
  fingerprint: string;
}

/**
 * Resolves `secretEnvRefs` (envName → credentialId) to concrete secret values
 * in worker memory only. Implementations must never expose a secret through
 * `describe()` or any log/metadata path.
 */
export interface CredentialResolver {
  resolveRefs(refs: Record<string, string>): Map<string, string>;
  describe(): string;
}
