/**
 * Trusted executable discovery and canonicalization.
 *
 * Given a finite list of reviewed candidate paths (from the catalog discovery
 * rules), the resolver canonicalizes each path to its real location, denies
 * any symlink/junction that escapes an allowed root, injects the
 * publisher/checksum verifier (so no test depends on a real signature), and
 * caches a result keyed on a file identity that changes when the file is
 * replaced. It never accepts a caller-supplied executable, URL, or argument
 * list — candidates come only from the reviewed catalog discovery rules.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CatalogDiscoveryKind, CatalogTarget } from "./types.js";

export interface ExecutableCandidate {
  target: CatalogTarget;
  componentId: string;
  path: string;
  /** Optional pre-parsed version; otherwise read from `<path>.version`. */
  version?: string;
  discovery: CatalogDiscoveryKind;
}

export interface ResolvedCandidate {
  componentId: string;
  target: CatalogTarget;
  canonicalPath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  version?: string;
  discovery: CatalogDiscoveryKind;
  withinRoot: boolean;
}

export interface SignatureVerification {
  publisher?: string;
  trusted: boolean;
  thumbprint?: string;
}

export type Verifier = (candidate: ResolvedCandidate) => SignatureVerification | Promise<SignatureVerification>;

export type ComponentState = "ready" | "missing" | "untrusted" | "incompatible";

export interface ResolveResult {
  componentId: string;
  target: CatalogTarget;
  trusted: boolean;
  state: ComponentState;
  realPath?: string;
  fileIdentity: string;
  version?: string;
  publisher?: string;
  discovery?: CatalogDiscoveryKind;
  ambiguous?: boolean;
  reason?: string;
}

export interface TrustedExecutableResolverOptions {
  verify: Verifier;
  candidates: ExecutableCandidate[];
  /** Roots that candidate real paths must remain within. */
  allowedRoots?: string[];
}

interface CacheEntry {
  fileIdentity: string;
  result: ResolveResult;
}

function isWithin(roots: string[], candidate: string): boolean {
  const abs = path.resolve(candidate);
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

function fileIdentityFor(realPath: string, size: number, mtimeMs: number): string {
  return createHash("sha256")
    .update(`${realPath}\0${size}\0${mtimeMs}`)
    .digest("hex");
}

async function readVersion(candidatePath: string, fallback?: string): Promise<string | undefined> {
  if (fallback) return fallback;
  try {
    const v = await fs.readFile(`${candidatePath}.version`, "utf8");
    return v.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class TrustedExecutableResolver {
  private readonly verify: Verifier;
  private readonly candidates: ExecutableCandidate[];
  private readonly allowedRoots: string[];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: TrustedExecutableResolverOptions) {
    this.verify = options.verify;
    this.candidates = options.candidates;
    this.allowedRoots = options.allowedRoots ?? [];
  }

  async resolve(target: CatalogTarget): Promise<ResolveResult> {
    return this.resolveMany(this.candidates.filter((c) => c.target === target));
  }

  async resolveComponent(componentId: string): Promise<ResolveResult> {
    return this.resolveMany(this.candidates.filter((c) => c.componentId === componentId));
  }

  private async resolveMany(candidates: ExecutableCandidate[]): Promise<ResolveResult> {
    if (candidates.length === 0) {
      return {
        componentId: "",
        target: "native",
        trusted: false,
        state: "missing",
        fileIdentity: "",
        reason: "no candidate",
      };
    }
    const resolved: ResolveResult[] = [];
    for (const candidate of candidates) {
      resolved.push(await this.resolveOne(candidate));
    }
    const valid = resolved.filter((r) => r.state === "ready");
    const head = resolved[0];
    if (valid.length > 1) {
      return { ...head, ambiguous: true, state: "incompatible", reason: `ambiguous: ${valid.length} candidates` };
    }
    return head;
  }

  private async resolveOne(candidate: ExecutableCandidate): Promise<ResolveResult> {
    let stat: fsSync.Stats;
    let realPath: string;
    try {
      stat = await fs.stat(candidate.path);
      if (!stat.isFile()) {
        return this.missing(candidate);
      }
      realPath = await fs.realpath(candidate.path);
    } catch {
      return this.missing(candidate);
    }
    const withinRoot =
      this.allowedRoots.length === 0 ? true : isWithin(this.allowedRoots, realPath);
    if (!withinRoot) {
      return {
        componentId: candidate.componentId,
        target: candidate.target,
        trusted: false,
        state: "untrusted",
        realPath,
        fileIdentity: fileIdentityFor(realPath, stat.size, stat.mtimeMs),
        version: candidate.version,
        discovery: candidate.discovery,
        reason: "candidate real path escapes the allowed root",
      };
    }
    const identity = fileIdentityFor(realPath, stat.size, stat.mtimeMs);
    const cached = this.cache.get(candidate.path);
    if (cached && cached.fileIdentity === identity) {
      return cached.result;
    }
    const version = await readVersion(candidate.path, candidate.version);
    const resolved: ResolvedCandidate = {
      componentId: candidate.componentId,
      target: candidate.target,
      canonicalPath: candidate.path,
      realPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      version,
      discovery: candidate.discovery,
      withinRoot,
    };
    const verification = await this.verify(resolved);
    const state: ComponentState = verification.trusted ? "ready" : "untrusted";
    const result: ResolveResult = {
      componentId: candidate.componentId,
      target: candidate.target,
      trusted: verification.trusted,
      state,
      realPath,
      fileIdentity: identity,
      version,
      publisher: verification.publisher,
      discovery: candidate.discovery,
      reason: verification.trusted ? undefined : "untrusted publisher or signature",
    };
    this.cache.set(candidate.path, { fileIdentity: identity, result });
    return result;
  }

  private missing(candidate: ExecutableCandidate): ResolveResult {
    return {
      componentId: candidate.componentId,
      target: candidate.target,
      trusted: false,
      state: "missing",
      fileIdentity: "",
      version: candidate.version,
      discovery: candidate.discovery,
      reason: "candidate not found",
    };
  }
}
