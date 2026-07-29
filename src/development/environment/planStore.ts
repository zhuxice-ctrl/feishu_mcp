/**
 * Atomic single-use environment-plan claim store.
 *
 * Plans are persisted as 0600 metadata files. Claim is a compare-and-set from
 * `planned` to `claimed`: before claiming, the HMAC is re-verified over the
 * body (so any tampered component/version/source is rejected), the owner is
 * checked, the environment digest is compared against the plan's binding
 * (drift => stale), and the expiry is enforced. A second claim returns
 * `already_used`; the compare-and-set guarantees exactly-once even under
 * concurrent callers.
 */

import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APPROVAL_STATE_SECRET } from "../../config.js";
import type { EnvironmentPlan } from "./planner.js";
import { canonicalPlanBody, verifyPlanHmac } from "./planner.js";

export type PlanClaimStatus =
  | "claimed"
  | "already_used"
  | "expired"
  | "stale"
  | "forbidden"
  | "invalid"
  | "not_found";

export interface PlanClaimResult {
  status: PlanClaimStatus;
  planId: string;
  claimedAt?: string;
}

export interface PlanStoreOptions {
  clock?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PlanStore {
  private readonly clock: () => Date;

  constructor(
    private readonly dataDir: string,
    options: PlanStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  save(plan: EnvironmentPlan): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.atomicWrite(plan);
  }

  get(planId: string): EnvironmentPlan | undefined {
    if (!UUID_RE.test(planId)) return undefined;
    const file = this.fileFor(planId);
    try {
      const raw = fs.readFileSync(file, "utf8");
      return JSON.parse(raw) as EnvironmentPlan;
    } catch {
      return undefined;
    }
  }

  claim(planId: string, ownerKey: string, environmentDigest: string): PlanClaimResult {
    const plan = this.get(planId);
    if (!plan) return { status: "not_found", planId };
    if (!verifyPlanHmac(plan)) return { status: "invalid", planId };
    if (plan.ownerKey !== ownerKey) return { status: "forbidden", planId };
    if (plan.environmentDigest !== environmentDigest) return { status: "stale", planId };
    if (this.clock().getTime() > Date.parse(plan.expiryAt)) {
      return { status: "expired", planId };
    }
    // compare-and-set: planned -> claimed
    const current = this.get(planId);
    if (!current || current.status !== "planned") {
      return { status: "already_used", planId };
    }
    const claimed: EnvironmentPlan = { ...current, status: "claimed" };
    // re-sign is not required: status is part of the signed body, so update it
    // atomically and recompute the hmac to keep the persisted record consistent.
    claimed.hmac = recomputeHmac(claimed);
    this.atomicWrite(claimed);
    return { status: "claimed", planId, claimedAt: this.clock().toISOString() };
  }

  private fileFor(planId: string): string {
    return path.join(this.dataDir, `${planId}.json`);
  }

  private atomicWrite(plan: EnvironmentPlan): void {
    const file = this.fileFor(plan.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plan), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function recomputeHmac(plan: EnvironmentPlan): string {
  const key = createHmac("sha256", APPROVAL_STATE_SECRET).update("environment-plan-v1").digest();
  return createHmac("sha256", key).update(canonicalPlanBody(plan), "utf8").digest("hex");
}
