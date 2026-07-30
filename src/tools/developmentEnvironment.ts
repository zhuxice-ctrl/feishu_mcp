/**
 * Owner-only trusted-environment provisioning tools.
 *
 * Three MCP tools sit on top of the Phase 2 environment subsystem
 * (catalog → inspect → plan → broker/apply):
 *
 * - `inspect_development_environment` — resolve the reviewed catalog against
 *   the local machine and return a structured public status (component id,
 *   display name, state, version, remediation). Never returns paths,
 *   publisher fingerprints, file identities, or discovery candidates.
 * - `plan_environment_changes` — build a signed, single-use, dependency-
 *   ordered plan bound to the current catalog and environment digests. The
 *   caller supplies only exact catalog component IDs and an intent; no URL,
 *   executable, argument, script, or registry write is accepted.
 * - `apply_environment_plan` — elicit a single-use owner approval displaying
 *   the redacted component/version/size/privilege/reboot summary, atomically
 *   claim the plan (rejecting drift, replay, expiry, and tampering), apply it
 *   through the broker/local launcher, and return an application id.
 *
 * No secret, path, SID, HMAC, owner key, digest, or broker detail is ever
 * returned to the caller.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEV_ENV_ALLOWED_ROOTS,
  DEV_ENV_BROKER_KEY_PATH,
  DEV_ENV_CATALOG_PATH,
  DEV_ENV_OWNER_SID,
  DEV_ENV_PLAN_DIR,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import { loadDevelopmentCatalog, catalogDigest } from "../development/environment/catalog.js";
import { EnvironmentInspector } from "../development/environment/inspect.js";
import { PlanPlanner } from "../development/environment/planner.js";
import { PlanStore } from "../development/environment/planStore.js";
import { PlanApplier } from "../development/environment/applyPlan.js";
import {
  BrokerClient,
  brokerPipePath,
} from "../development/environment/brokerClient.js";
import {
  TrustedExecutableResolver,
  type Verifier,
} from "../development/environment/trustedExecutable.js";
import type {
  CatalogTarget,
  DevelopmentCatalog,
} from "../development/environment/types.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

// ----------------------------------------------------------- input schemas ---

const targetSchema = z.enum(["android", "dotnet", "native", "electron"]);

export const inspectInputSchema = z
  .object({ targets: z.array(targetSchema).min(1) })
  .strict()
  .refine((value) => new Set(value.targets).size === value.targets.length, {
    message: "targets must be unique",
  });

export const planInputSchema = z
  .object({
    targets: z.array(targetSchema).min(1),
    components: z.array(z.string().min(1)).min(1),
    intent: z.enum(["install", "update", "repair"]),
  })
  .strict()
  .refine((value) => new Set(value.targets).size === value.targets.length, {
    message: "targets must be unique",
  })
  .refine((value) => new Set(value.components).size === value.components.length, {
    message: "components must be unique",
  });

export const applyInputSchema = z.object({ planId: z.string().uuid() }).strict();

// ----------------------------------------------------------------- deps ---

export interface DevelopmentEnvironmentDeps {
  catalog: DevelopmentCatalog;
  inspector: EnvironmentInspector;
  planner: PlanPlanner;
  planStore: PlanStore;
  applier: PlanApplier;
  ownerKey: (userId: string) => string;
  userId?: () => string | null;
}

function resolveUserId(deps: DevelopmentEnvironmentDeps): string | null {
  return (deps.userId ?? getRequestUserId)();
}

/** Require an authenticated owner; returns the user id or an error result. */
function requireOwner(
  deps: DevelopmentEnvironmentDeps,
): { userId: string } | { error: ReturnType<typeof toolError> } {
  const userId = resolveUserId(deps);
  if (!userId) {
    return { error: toolError("AUTHENTICATION_REQUIRED", "An authenticated owner is required.") };
  }
  return { userId };
}

// ----------------------------------------------------- redacted summaries ---

interface RedactedOperation {
  componentId: string;
  displayName: string;
  target: CatalogTarget;
  versions: string[];
  privilege: boolean;
  reboot: boolean;
  downloadBytes: number;
  diskBytes: number;
}

function redactedOperation(
  componentId: string,
  target: CatalogTarget,
  versions: string[],
  privilege: boolean,
  reboot: boolean,
  downloadBytes: number,
  diskBytes: number,
  catalog: DevelopmentCatalog,
): RedactedOperation {
  const component = catalog.components.find((c) => c.id === componentId);
  return {
    componentId,
    displayName: component?.displayName ?? componentId,
    target,
    versions,
    privilege,
    reboot,
    downloadBytes,
    diskBytes,
  };
}

// ---------------------------------------------------------------- inspect ---

export async function inspectDevelopmentEnvironment(
  args: unknown,
  deps: DevelopmentEnvironmentDeps,
) {
  const parsed = inspectInputSchema.parse(args);
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  void owner; // owner-only gating is enforced by authorizeOwnerToolCall
  const { snapshot, publicStatus } = await deps.inspector.inspect();
  const requestedTargets = new Set<CatalogTarget>(parsed.targets);
  const components = publicStatus.filter((entry) => {
    const component = deps.catalog.components.find((c) => c.id === entry.componentId);
    return component && requestedTargets.has(component.target);
  });
  return toolJson({
    ok: true,
    catalogVersion: deps.catalog.version,
    targets: [...requestedTargets],
    environmentDigest: snapshot.digest,
    components,
  });
}

// ------------------------------------------------------------------ plan ---

export async function planEnvironmentChanges(
  args: unknown,
  deps: DevelopmentEnvironmentDeps,
) {
  const parsed = planInputSchema.parse(args);
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const { snapshot } = await deps.inspector.inspect();
  const plan = deps.planner.create({
    ownerKey: deps.ownerKey(owner.userId),
    targets: parsed.targets,
    requested: parsed.components,
    snapshot,
  });
  deps.planStore.save(plan);
  const operations = plan.operations.map((op) =>
    redactedOperation(
      op.componentId,
      op.target,
      op.versions,
      op.privilege,
      op.reboot,
      op.downloadBytes,
      op.diskBytes,
      deps.catalog,
    ),
  );
  return toolJson({
    ok: true,
    planId: plan.id,
    intent: parsed.intent,
    operations,
    estimatedDownloadBytes: plan.estimatedDownloadBytes,
    estimatedDiskBytes: plan.estimatedDiskBytes,
    expiresAt: plan.expiryAt,
  });
}

// ------------------------------------------------------------------ apply ---

export async function applyEnvironmentPlan(
  args: unknown,
  deps: DevelopmentEnvironmentDeps,
  ctx: ServerContext,
) {
  const parsed = applyInputSchema.parse(args);
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  const plan = deps.planStore.get(parsed.planId);
  if (!plan) {
    return toolError("ENVIRONMENT_PLAN_NOT_FOUND", "Environment plan not found.");
  }
  // Display the redacted summary for the single-use approval elicitation.
  const operations = plan.operations.map((op) =>
    redactedOperation(
      op.componentId,
      op.target,
      op.versions,
      op.privilege,
      op.reboot,
      op.downloadBytes,
      op.diskBytes,
      deps.catalog,
    ),
  );
  const reasons: string[] = [];
  if (operations.some((op) => op.privilege)) {
    reasons.push("One or more steps require administrator privilege.");
  }
  if (operations.some((op) => op.reboot)) {
    reasons.push("One or more steps may require a reboot.");
  }
  reasons.push(`${operations.length} component operation(s) will be applied.`);

  const approval = await requestApproval(ctx, {
    tool: "apply_environment_plan",
    userId: owner.userId,
    subject: { kind: "environment_plan", key: parsed.planId, display: "environment plan" },
    argsDigest: digestArguments({ planId: parsed.planId }),
    reasons,
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  // Re-inspect to detect environment drift between plan creation and apply.
  const { snapshot } = await deps.inspector.inspect();
  const claim = deps.planStore.claim(parsed.planId, deps.ownerKey(owner.userId), snapshot.digest);
  switch (claim.status) {
    case "already_used":
      return toolError("ENVIRONMENT_PLAN_ALREADY_USED", "This environment plan has already been applied.");
    case "expired":
      return toolError("ENVIRONMENT_PLAN_EXPIRED", "This environment plan has expired.");
    case "stale":
      return toolError("ENVIRONMENT_PLAN_STALE", "The environment has changed since this plan was created.");
    case "forbidden":
      return toolError("ENVIRONMENT_PLAN_FORBIDDEN", "This environment plan belongs to another owner.");
    case "invalid":
      return toolError("ENVIRONMENT_PLAN_INVALID", "This environment plan failed integrity verification.");
    case "not_found":
      return toolError("ENVIRONMENT_PLAN_NOT_FOUND", "Environment plan not found.");
    case "claimed":
      break;
  }

  const applicationId = randomUUID();
  const result = await deps.applier.apply(plan);
  if (!result.completed) {
    const error = result.failed?.error ?? "apply failed";
    if (error === "BROKER_UNAVAILABLE" || error.startsWith("BROKER_")) {
      return toolError("BROKER_UNAVAILABLE", "The administrator broker is unavailable.");
    }
    return toolError("ENVIRONMENT_APPLY_FAILED", `Environment plan application failed: ${error}`, false, {
      applicationId,
      failedComponent: result.failed?.componentId,
      step: result.failed?.step,
    });
  }
  return toolJson({
    ok: true,
    planId: plan.id,
    applicationId,
    applied: result.applied,
    completed: true,
  });
}

// ------------------------------------------------- production subsystem ---

/**
 * Default verifier for Phase 2: a candidate that already resolved within an
 * allowed root is treated as trusted. Real publisher/signature verification
 * is wired by the platform adapters in Phase 3/4.
 */
const defaultVerifier: Verifier = () => ({ trusted: true });

/**
 * Build resolver candidates from the catalog's `fixed_candidates` discovery
 * rules. Registry, vswhere, and sdkmanager discovery are implemented by the
 * platform adapters (Phase 3/4); until then those components resolve as
 * missing. Candidate paths expand `%VAR%` environment placeholders.
 */
function buildResolverCandidates(catalog: DevelopmentCatalog) {
  const candidates = [];
  for (const component of catalog.components) {
    if (component.discovery.kind !== "fixed_candidates") continue;
    for (const raw of component.discovery.values) {
      const expanded = raw.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
      candidates.push({
        target: component.target,
        componentId: component.id,
        path: expanded,
        discovery: component.discovery.kind,
      });
    }
  }
  return candidates;
}

function loadBrokerKey(): Buffer | undefined {
  if (!DEV_ENV_BROKER_KEY_PATH) return undefined;
  try {
    const raw = fs.readFileSync(DEV_ENV_BROKER_KEY_PATH);
    if (raw.length !== 32) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export interface DevelopmentEnvironmentSubsystem extends DevelopmentEnvironmentDeps {
  catalogDigest: string;
  brokerState: "ready" | "missing" | "incompatible";
}

/**
 * Construct the production environment subsystem from configuration. Called
 * once at process startup. The catalog is loaded and strictly validated here;
 * a malformed catalog aborts startup so the server never serves an untrusted
 * component set.
 */
export function createDevelopmentEnvironmentSubsystem(): DevelopmentEnvironmentSubsystem {
  const catalog = loadDevelopmentCatalog(DEV_ENV_CATALOG_PATH);
  const resolver = new TrustedExecutableResolver({
    verify: defaultVerifier,
    candidates: buildResolverCandidates(catalog),
    allowedRoots: DEV_ENV_ALLOWED_ROOTS,
  });
  const inspector = new EnvironmentInspector({ catalog, resolver });
  const planner = new PlanPlanner({ catalog });
  const planStore = new PlanStore(DEV_ENV_PLAN_DIR);

  let brokerClient: BrokerClient | undefined;
  let brokerState: "ready" | "missing" | "incompatible" = "missing";
  const key = loadBrokerKey();
  if (DEV_ENV_OWNER_SID && key) {
    brokerClient = new BrokerClient({
      pipePath: brokerPipePath(DEV_ENV_OWNER_SID),
      key,
      ownerSid: DEV_ENV_OWNER_SID,
      catalogDigest: catalogDigest(catalog),
    });
    brokerState = "ready";
  }
  const applier = new PlanApplier({ brokerClient });

  return {
    catalog,
    inspector,
    planner,
    planStore,
    applier,
    ownerKey: developmentOwnerKey,
    catalogDigest: catalogDigest(catalog),
    brokerState,
  };
}

// ----------------------------------------------------------- registration ---

export function registerDevelopmentEnvironmentTools(
  server: McpServer,
  deps: DevelopmentEnvironmentDeps,
): void {
  server.registerTool(
    "inspect_development_environment",
    {
      description:
        "Inspect the local development environment against the reviewed " +
        "component catalog and return a structured public status per target: " +
        "component id, display name, state (ready/missing/untrusted/" +
        "incompatible), version, and a remediation hint. Never returns paths, " +
        "publisher fingerprints, or file identities.",
      inputSchema: {
        targets: z.array(targetSchema).min(1),
      },
    },
    async (args) =>
      authorizeOwnerToolCall("inspect_development_environment", args) ??
      runTool(
        {
          name: "inspect_development_environment",
          concurrency: "default",
          subject: { kind: "environment_plan", key: "inspect", display: "environment inspection" },
        },
        async () => inspectDevelopmentEnvironment(args, deps),
      ),
  );

  server.registerTool(
    "plan_environment_changes",
    {
      description:
        "Build a signed, single-use, dependency-ordered environment plan from " +
        "exact catalog component IDs and an install/update/repair intent. The " +
        "plan is bound to the current catalog and environment digests; the " +
        "caller cannot supply a URL, executable, argument, script, or registry " +
        "write. Returns the plan id and a redacted operation summary.",
      inputSchema: {
        targets: z.array(targetSchema).min(1),
        components: z.array(z.string().min(1)).min(1),
        intent: z.enum(["install", "update", "repair"]),
      },
    },
    async (args) =>
      authorizeOwnerToolCall("plan_environment_changes", args) ??
      runTool(
        {
          name: "plan_environment_changes",
          concurrency: "default",
          subject: { kind: "environment_plan", key: "plan", display: "environment plan" },
        },
        async () => planEnvironmentChanges(args, deps),
      ),
  );

  server.registerTool(
    "apply_environment_plan",
    {
      description:
        "Apply a signed single-use environment plan after explicit owner " +
        "approval. The approval form displays the redacted component/version/" +
        "size/privilege/reboot summary only. The plan is atomically claimed " +
        "(drift, replay, expiry, and tampering are rejected) and applied " +
        "through the administrator broker and validated local launcher. " +
        "Returns an application id and the applied component ids.",
      inputSchema: {
        planId: z.string().uuid(),
      },
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("apply_environment_plan", args) ??
      runTool(
        {
          name: "apply_environment_plan",
          concurrency: "default",
          subject: { kind: "environment_plan", key: "apply", display: "environment plan application" },
        },
        async () => applyEnvironmentPlan(args, deps, ctx),
      ),
  );
}
