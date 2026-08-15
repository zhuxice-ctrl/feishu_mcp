/**
 * Closed command construction for the web verification workflow.
 *
 * Maps only `typecheck`, `lint`, `build`, and `test_selected` to fixed PNPM
 * invocations. No caller-supplied command string, package script name,
 * workdir, environment, timeout, or argv is accepted. The Windows
 * `cmd.exe /d /s /c pnpm.cmd` compatibility approach is reused.
 */

import path from "node:path";
import type { WorkflowStepKind } from "../workspaces/types.js";
import type { DevelopmentWorkflowStep } from "../tasks/types.js";

const STEP_TIMEOUT_MS = 5 * 60_000; // 5 minutes per step

/** Map a step kind to its fixed pnpm args. */
function pnpmArgsForKind(kind: WorkflowStepKind, testFiles?: string[]): string[] {
  switch (kind) {
    case "typecheck":
      return ["typecheck"];
    case "lint":
      return ["lint:check"];
    case "build":
      return ["build"];
    case "test_selected":
      return ["test:run", "--", ...(testFiles ?? [])];
  }
}

/** Resolve the pnpm executable for the current platform. */
function resolvePnpmExecutable(): { executable: string; args: string[] } {
  if (process.platform !== "win32") {
    return { executable: "pnpm", args: [] };
  }
  // Windows cannot directly spawn the pnpm.cmd shim with shell disabled.
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c"],
  };
}

/**
 * Build the fixed DevelopmentWorkflowStep array from a recipe's enabled steps.
 * Test file paths are restricted by `testFiles.ts` before being concatenated.
 */
export function buildWorkflowSteps(
  steps: Array<{ id: string; kind: WorkflowStepKind; enabled: boolean }>,
  cwd: string,
  testFiles?: string[],
): DevelopmentWorkflowStep[] {
  const pnpm = resolvePnpmExecutable();
  return steps.map((step) => {
      const scriptArgs = pnpmArgsForKind(step.kind, testFiles);
      const fullArgs = [...pnpm.args, `pnpm.cmd ${scriptArgs.join(" ")}`.trim()];
      // On non-Windows, the command is `pnpm <args>`.
      const finalArgs = process.platform !== "win32"
        ? scriptArgs
        : fullArgs;
      const enabled = step.enabled && (step.kind !== "test_selected" || (testFiles?.length ?? 0) > 0);
      return {
        id: step.id,
        kind: step.kind,
        executable: pnpm.executable,
        args: finalArgs,
        timeoutMs: STEP_TIMEOUT_MS,
        enabled,
      };
    });
}

/** Build the full workflow launch spec for a given workspace and recipe. */
export function buildWorkflowLaunchSpec(
  workspaceId: string,
  recipeId: string,
  recipeDigestValue: string,
  cwd: string,
  steps: Array<{ id: string; kind: WorkflowStepKind; enabled: boolean }>,
  testFiles: string[],
  totalTimeoutMs: number,
  artifactDirs?: string[],
): {
  workspaceId: string;
  recipeId: string;
  recipeDigest: string;
  cwd: string;
  steps: DevelopmentWorkflowStep[];
  timeoutMs: number;
  artifactDirs?: string[];
} {
  const workflowSteps = buildWorkflowSteps(steps, cwd, testFiles);
  return {
    workspaceId,
    recipeId,
    recipeDigest: recipeDigestValue,
    cwd,
    steps: workflowSteps,
    timeoutMs: totalTimeoutMs,
    ...(artifactDirs !== undefined && artifactDirs.length > 0 ? { artifactDirs } : {}),
  };
}
