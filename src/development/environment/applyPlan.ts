/**
 * Plan application orchestrator.
 *
 * After a plan is claimed (via PlanStore), PlanApplier walks the operations in
 * dependency order.  Non-privileged steps (android_sdk, verified_archive) are
 * executed through a validated launch-spec callback.  Privileged steps
 * (winget for VS/SDK, vs_workload) are delegated to the administrator broker
 * via BrokerClient.
 *
 * The applier stops on the first failed step, records the failed component,
 * and does NOT retry automatically.  No secret, path, SID, or key is exposed
 * in the result.
 */

import type { EnvironmentPlan, PlanOperation } from "./planner.js";
import type { BrokerClient, BrokerResult } from "./brokerClient.js";

export type OperationKind = "broker" | "local";

export interface ApplyStepResult {
  componentId: string;
  kind: OperationKind;
  success: boolean;
  exitCode?: number;
  stage?: string;
  message?: string;
  error?: string;
}

export interface ApplyPlanResult {
  planId: string;
  applied: string[];
  failed?: {
    componentId: string;
    error: string;
    step: number;
  };
  completed: boolean;
}

/** Callback for non-privileged operations (android_sdk, verified_archive). */
export type LocalLaunchFn = (op: PlanOperation) => Promise<ApplyStepResult>;

export interface PlanApplierOptions {
  brokerClient?: BrokerClient;
  localLaunch?: LocalLaunchFn;
}

function isPrivileged(op: PlanOperation): boolean {
  return op.privilege;
}

export class PlanApplier {
  private readonly brokerClient?: BrokerClient;
  private readonly localLaunch?: LocalLaunchFn;

  constructor(options: PlanApplierOptions = {}) {
    this.brokerClient = options.brokerClient;
    this.localLaunch = options.localLaunch;
  }

  async apply(plan: EnvironmentPlan): Promise<ApplyPlanResult> {
    const applied: string[] = [];
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      let result: ApplyStepResult;
      try {
        if (isPrivileged(op)) {
          result = await this.applyViaBroker(op);
        } else {
          result = await this.applyLocally(op);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : "unknown error";
        return {
          planId: plan.id,
          applied,
          failed: { componentId: op.componentId, error, step: i },
          completed: false,
        };
      }
      if (!result.success) {
        return {
          planId: plan.id,
          applied,
          failed: {
            componentId: op.componentId,
            error: result.error ?? "step failed",
            step: i,
          },
          completed: false,
        };
      }
      applied.push(op.componentId);
    }
    return { planId: plan.id, applied, completed: true };
  }

  private async applyViaBroker(op: PlanOperation): Promise<ApplyStepResult> {
    if (!this.brokerClient) {
      return {
        componentId: op.componentId,
        kind: "broker",
        success: false,
        error: "BROKER_UNAVAILABLE",
      };
    }
    const brokerResult: BrokerResult = await this.brokerClient.apply({
      operationId: op.install.kind as "winget" | "vs_workload" | "android_sdk" | "verified_archive",
      planId: "", // filled by caller context
      componentId: op.componentId,
      version: op.versions[0] ?? "",
    });
    return {
      componentId: op.componentId,
      kind: "broker",
      success: brokerResult.accepted,
      exitCode: brokerResult.exitCode,
      stage: brokerResult.stage,
      message: brokerResult.message,
      error: brokerResult.error,
    };
  }

  private async applyLocally(op: PlanOperation): Promise<ApplyStepResult> {
    if (!this.localLaunch) {
      return {
        componentId: op.componentId,
        kind: "local",
        success: false,
        error: "no local launch handler configured",
      };
    }
    return this.localLaunch(op);
  }
}
