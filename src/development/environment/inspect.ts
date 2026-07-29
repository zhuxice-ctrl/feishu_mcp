/**
 * Deterministic environment snapshots.
 *
 * The inspector walks the reviewed catalog (sorted by component id), resolves
 * each component through the trusted-executable resolver, and produces two
 * views:
 *
 * - a **private canonical snapshot** hashed into a stable digest (bound to the
 *   catalog digest) — used to detect environment drift between plan creation
 *   and plan application;
 * - a **public status** containing only component id, display name, state,
 *   version, and a remediation hint — never paths, environment variables,
 *   publisher fingerprints, or file identities.
 */

import { createHash } from "node:crypto";
import type { DevelopmentCatalog, CatalogInstallOperation } from "./types.js";
import { catalogDigest } from "./catalog.js";
import type { TrustedExecutableResolver, ResolveResult, ComponentState } from "./trustedExecutable.js";

export interface PrivateComponentSnapshot {
  componentId: string;
  target: string;
  state: ComponentState;
  realPath?: string;
  fileIdentity: string;
  version?: string;
  publisher?: string;
  discovery?: string;
}

export interface EnvironmentSnapshot {
  version: 1;
  catalogDigest: string;
  digest: string;
  createdAt: string;
  components: PrivateComponentSnapshot[];
}

export interface PublicComponentStatus {
  componentId: string;
  displayName: string;
  state: ComponentState;
  version?: string;
  remediation: string;
}

export interface EnvironmentInspectorOptions {
  catalog: DevelopmentCatalog;
  resolver: TrustedExecutableResolver;
  clock?: () => Date;
}

function installSummary(op: CatalogInstallOperation): string {
  switch (op.kind) {
    case "winget":
      return `winget ${op.packageId}`;
    case "vs_workload":
      return `Visual Studio workload ${op.workloadId}`;
    case "android_sdk":
      return `sdkmanager ${op.packageId}`;
    case "verified_archive":
      return `download ${op.artifactId}`;
  }
}

function remediationFor(state: ComponentState, install: CatalogInstallOperation): string {
  switch (state) {
    case "ready":
      return "";
    case "missing":
      return `install via ${installSummary(install)}`;
    case "untrusted":
      return "publisher or signature not trusted";
    case "incompatible":
      return "version or candidate incompatible";
  }
}

/**
 * Redact a private snapshot entry to its public form. Always includes a
 * remediation key (empty string when none) so callers can never accidentally
 * surface a path, publisher, or file identity.
 */
export function publicComponentStatus(entry: {
  componentId: string;
  displayName: string;
  state: ComponentState;
  version?: string;
  remediation?: string;
}): PublicComponentStatus {
  return {
    componentId: entry.componentId,
    displayName: entry.displayName,
    state: entry.state,
    version: entry.version,
    remediation: entry.remediation ?? "",
  };
}

export class EnvironmentInspector {
  private readonly catalog: DevelopmentCatalog;
  private readonly resolver: TrustedExecutableResolver;
  private readonly clock: () => Date;

  constructor(options: EnvironmentInspectorOptions) {
    this.catalog = options.catalog;
    this.resolver = options.resolver;
    this.clock = options.clock ?? (() => new Date());
  }

  async inspect(): Promise<{ snapshot: EnvironmentSnapshot; publicStatus: PublicComponentStatus[] }> {
    const components = [...this.catalog.components].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const privateEntries: PrivateComponentSnapshot[] = [];
    const publicEntries: PublicComponentStatus[] = [];
    for (const component of components) {
      const result: ResolveResult = await this.resolver.resolveComponent(component.id);
      const state = this.deriveState(result, component.versions);
      const remediation = remediationFor(state, component.install);
      privateEntries.push({
        componentId: component.id,
        target: component.target,
        state,
        realPath: result.realPath,
        fileIdentity: result.fileIdentity,
        version: result.version,
        publisher: result.publisher,
        discovery: result.discovery,
      });
      publicEntries.push(
        publicComponentStatus({
          componentId: component.id,
          displayName: component.displayName,
          state,
          version: result.version,
          remediation,
        }),
      );
    }
    const catDigest = catalogDigest(this.catalog);
    const canonical = JSON.stringify({
      version: 1 as const,
      catalogDigest: catDigest,
      components: privateEntries,
    });
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const snapshot: EnvironmentSnapshot = {
      version: 1,
      catalogDigest: catDigest,
      digest,
      createdAt: this.clock().toISOString(),
      components: privateEntries,
    };
    return { snapshot, publicStatus: publicEntries };
  }

  private deriveState(result: ResolveResult, supportedVersions: string[]): ComponentState {
    if (result.state === "missing") return "missing";
    if (result.state === "untrusted") return "untrusted";
    if (result.state === "incompatible") return "incompatible";
    // ready candidate: verify the version is one of the supported profiles
    if (result.version && !supportedVersions.includes(result.version)) {
      return "incompatible";
    }
    return "ready";
  }
}
