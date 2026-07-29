/**
 * Stable type contracts for the development environment subsystem.
 *
 * The catalog is the single source of truth for trusted toolchain components.
 * Install operations are a closed discriminated union: no caller-controlled
 * URL, executable, free-form switch, script, or registry write is permitted.
 * These types are persisted/embedded and consumed by the C# administrator
 * broker; they must remain backward-compatible (never remove a field, only
 * widen unions or add optional fields).
 */

export type CatalogTarget = "android" | "dotnet" | "native" | "electron";

export type CatalogDiscoveryKind =
  | "registry"
  | "vswhere"
  | "fixed_candidates"
  | "sdkmanager";

export type CatalogInstallOperation =
  | { kind: "winget"; packageId: string; source: "winget" }
  | { kind: "vs_workload"; workloadId: string }
  | { kind: "android_sdk"; packageId: string }
  | {
      kind: "verified_archive";
      artifactId: string;
      url: string;
      sha256: string;
    };

export interface CatalogDiscovery {
  kind: CatalogDiscoveryKind;
  values: string[];
}

export interface CatalogComponent {
  id: string;
  target: CatalogTarget;
  displayName: string;
  versions: string[];
  discovery: CatalogDiscovery;
  publishers: string[];
  install: CatalogInstallOperation;
}

export interface DevelopmentCatalog {
  version: 1;
  components: CatalogComponent[];
}
