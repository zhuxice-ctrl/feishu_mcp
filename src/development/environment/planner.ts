/**
 * Immutable signed environment plans.
 *
 * A plan is a versioned body bound to an owner key, a catalog digest, and an
 * environment digest, signed with HMAC-SHA256 using a key derived from the
 * shared approval secret and the label `environment-plan-v1`. Operations are
 * the exact catalog install descriptors (no caller URL/executable/argument),
 * dependency-ordered, with download/disk estimates and privilege/reboot flags.
 * The body expires after 30 minutes and can be claimed exactly once; any
 * mutation to a component, version, or source field invalidates the signature.
 */

import { createHmac, randomUUID } from "node:crypto";
import { APPROVAL_STATE_SECRET } from "../../config.js";
import type {
  CatalogInstallOperation,
  CatalogTarget,
  DevelopmentCatalog,
} from "./types.js";
import { catalogDigest } from "./catalog.js";
import type { EnvironmentSnapshot } from "./inspect.js";

export const PLAN_LIFETIME_MS = 30 * 60 * 1000;
const PLAN_LABEL = "environment-plan-v1";

/** Dependency graph: component id -> ids that must be installed first. */
const DEPENDENCIES: Record<string, string[]> = {
  "google.android.platform-tools": ["google.android.commandlinetools"],
  "google.android.emulator": ["google.android.commandlinetools"],
  "google.android.platform.35": ["google.android.commandlinetools"],
  "google.android.build-tools.35": ["google.android.commandlinetools"],
  "google.android.system-image.35": [
    "google.android.commandlinetools",
    "google.android.platform.35",
  ],
  "microsoft.visualstudio.workload.manageddesktop": ["microsoft.visualstudio.2022.buildtools"],
  "microsoft.visualstudio.workload.nativedesktop": ["microsoft.visualstudio.2022.buildtools"],
  "microsoft.visualstudio.workload.universal": ["microsoft.visualstudio.2022.buildtools"],
};

/** Conservative planning estimates (bytes). Winget/vs workloads download via
 *  the package manager; verified archives carry their own download size. */
const ESTIMATES: Record<string, { downloadBytes: number; diskBytes: number }> = {
  "microsoft.openjdk.17": { downloadBytes: 0, diskBytes: 300 * 1024 * 1024 },
  "org.gradle.distribution": { downloadBytes: 130 * 1024 * 1024, diskBytes: 150 * 1024 * 1024 },
  "google.android.commandlinetools": { downloadBytes: 0, diskBytes: 0 },
  "google.android.platform-tools": { downloadBytes: 15 * 1024 * 1024, diskBytes: 15 * 1024 * 1024 },
  "google.android.emulator": { downloadBytes: 400 * 1024 * 1024, diskBytes: 400 * 1024 * 1024 },
  "google.android.platform.35": { downloadBytes: 80 * 1024 * 1024, diskBytes: 80 * 1024 * 1024 },
  "google.android.build-tools.35": { downloadBytes: 50 * 1024 * 1024, diskBytes: 50 * 1024 * 1024 },
  "google.android.system-image.35": { downloadBytes: 800 * 1024 * 1024, diskBytes: 800 * 1024 * 1024 },
  "microsoft.dotnet.sdk.8": { downloadBytes: 0, diskBytes: 700 * 1024 * 1024 },
  "microsoft.visualstudio.2022.buildtools": { downloadBytes: 0, diskBytes: 5 * 1024 * 1024 * 1024 },
  "microsoft.visualstudio.workload.manageddesktop": { downloadBytes: 0, diskBytes: 2 * 1024 * 1024 * 1024 },
  "microsoft.visualstudio.workload.nativedesktop": { downloadBytes: 0, diskBytes: 2 * 1024 * 1024 * 1024 },
  "microsoft.visualstudio.workload.universal": { downloadBytes: 0, diskBytes: 2 * 1024 * 1024 * 1024 },
  "microsoft.windows.sdk.11": { downloadBytes: 0, diskBytes: 3 * 1024 * 1024 * 1024 },
  "kitware.cmake": { downloadBytes: 0, diskBytes: 100 * 1024 * 1024 },
  "ninja-build.ninja": { downloadBytes: 0, diskBytes: 5 * 1024 * 1024 },
  "openjs.nodejs.lts": { downloadBytes: 0, diskBytes: 80 * 1024 * 1024 },
  "git.git": { downloadBytes: 0, diskBytes: 300 * 1024 * 1024 },
};

const PRIVILEGED = new Set([
  "microsoft.visualstudio.2022.buildtools",
  "microsoft.visualstudio.workload.manageddesktop",
  "microsoft.visualstudio.workload.nativedesktop",
  "microsoft.visualstudio.workload.universal",
  "microsoft.windows.sdk.11",
]);

const REQUIRES_REBOOT = new Set([
  "microsoft.visualstudio.2022.buildtools",
  "microsoft.visualstudio.workload.manageddesktop",
  "microsoft.visualstudio.workload.nativedesktop",
  "microsoft.visualstudio.workload.universal",
  "microsoft.windows.sdk.11",
]);

export interface PlanOperation {
  componentId: string;
  target: CatalogTarget;
  install: CatalogInstallOperation;
  versions: string[];
  privilege: boolean;
  reboot: boolean;
  downloadBytes: number;
  diskBytes: number;
}

export interface EnvironmentPlan {
  version: 1;
  id: string;
  ownerKey: string;
  catalogDigest: string;
  environmentDigest: string;
  operations: PlanOperation[];
  createdAt: string;
  expiryAt: string;
  estimatedDownloadBytes: number;
  estimatedDiskBytes: number;
  status: "planned" | "claimed" | "applied";
  hmac: string;
}

export interface PlanCreateInput {
  ownerKey: string;
  targets: CatalogTarget[];
  requested: string[];
  snapshot: EnvironmentSnapshot;
  clock?: () => Date;
}

function deriveKey(): Buffer {
  if (!APPROVAL_STATE_SECRET) {
    throw new Error("APPROVAL_STATE_SECRET is required for environment plans");
  }
  return createHmac("sha256", APPROVAL_STATE_SECRET).update(PLAN_LABEL).digest();
}

function operationCanonical(op: PlanOperation) {
  return {
    componentId: op.componentId,
    target: op.target,
    install: op.install,
    versions: op.versions,
    privilege: op.privilege,
    reboot: op.reboot,
    downloadBytes: op.downloadBytes,
    diskBytes: op.diskBytes,
  };
}

/** Canonical JSON of the signed portion of a plan (every field except hmac). */
export function canonicalPlanBody(plan: EnvironmentPlan): string {
  return JSON.stringify({
    version: plan.version,
    id: plan.id,
    ownerKey: plan.ownerKey,
    catalogDigest: plan.catalogDigest,
    environmentDigest: plan.environmentDigest,
    operations: plan.operations.map(operationCanonical),
    createdAt: plan.createdAt,
    expiryAt: plan.expiryAt,
    estimatedDownloadBytes: plan.estimatedDownloadBytes,
    estimatedDiskBytes: plan.estimatedDiskBytes,
    status: plan.status,
  });
}

function sign(plan: EnvironmentPlan): string {
  return createHmac("sha256", deriveKey()).update(canonicalPlanBody(plan), "utf8").digest("hex");
}

/** Re-verify a plan's HMAC over its body. */
export function verifyPlanHmac(plan: EnvironmentPlan): boolean {
  try {
    return plan.hmac === sign({ ...plan });
  } catch {
    return false;
  }
}

function topoSort(requested: string[]): string[] {
  const set = new Set(requested);
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of DEPENDENCIES[id] ?? []) {
      if (set.has(dep)) visit(dep);
    }
    order.push(id);
  };
  for (const id of requested) visit(id);
  return order;
}

export class PlanPlanner {
  private readonly catalog: DevelopmentCatalog;

  constructor(options: { catalog: DevelopmentCatalog }) {
    this.catalog = options.catalog;
  }

  create(input: PlanCreateInput): EnvironmentPlan {
    const targets = new Set(input.targets);
    if (targets.size === 0) throw new Error("at least one target is required");
    for (const t of input.targets) {
      if (!["android", "dotnet", "native", "electron"].includes(t)) {
        throw new Error(`unsupported target: ${t}`);
      }
    }
    if (input.requested.length === 0) throw new Error("at least one component is required");
    const requestedSet = new Set(input.requested);
    if (requestedSet.size !== input.requested.length) {
      throw new Error("requested component ids must be unique");
    }
    for (const id of input.requested) {
      const comp = this.catalog.components.find((c) => c.id === id);
      if (!comp) throw new Error(`unknown component: ${id}`);
      if (!targets.has(comp.target)) {
        throw new Error(`component ${id} is not in the requested targets`);
      }
    }
    const ordered = topoSort(input.requested);
    const operations: PlanOperation[] = ordered.map((id) => {
      const comp = this.catalog.components.find((c) => c.id === id)!;
      const est = ESTIMATES[id] ?? { downloadBytes: 0, diskBytes: 0 };
      return {
        componentId: id,
        target: comp.target,
        install: comp.install,
        versions: comp.versions,
        privilege: PRIVILEGED.has(id),
        reboot: REQUIRES_REBOOT.has(id),
        downloadBytes: est.downloadBytes,
        diskBytes: est.diskBytes,
      };
    });
    const created = (input.clock ?? (() => new Date()))();
    const expiry = new Date(created.getTime() + PLAN_LIFETIME_MS);
    const plan: EnvironmentPlan = {
      version: 1,
      id: randomUUID(),
      ownerKey: input.ownerKey,
      catalogDigest: catalogDigest(this.catalog),
      environmentDigest: input.snapshot.digest,
      operations,
      createdAt: created.toISOString(),
      expiryAt: expiry.toISOString(),
      estimatedDownloadBytes: operations.reduce((s, o) => s + o.downloadBytes, 0),
      estimatedDiskBytes: operations.reduce((s, o) => s + o.diskBytes, 0),
      status: "planned",
      hmac: "",
    };
    plan.hmac = sign(plan);
    return plan;
  }
}
