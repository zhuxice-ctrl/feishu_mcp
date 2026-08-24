/**
 * Pure workspace route planning.
 *
 * Converts catalog hints and context phase into a deterministic RoutePlan.
 * This module has no filesystem, process, shell, approval, task-store, or MCP
 * registration imports — it is a pure, testable contract.
 */

import type { WorkspaceHints } from "./types.js";
import type {
  ProhibitedRoute,
  RoutePlan,
  RouteStep,
  WorkspacePhase,
} from "./contextTypes.js";

/** Android build/test/install must go through the background adapter. */
function androidStep(): RouteStep {
  return {
    purpose: "Run Android build/test/install through the background adapter",
    tool: "android_development",
    required: true,
    input: {},
  };
}

/** Fixed Node verification runs through the local workflow recipe. */
function nodeWorkflowStep(): RouteStep {
  return {
    purpose: "Run the fixed verification recipe on the selected workspace",
    tool: "run_local_workflow",
    required: false,
    input: {},
  };
}

/**
 * Executable routes that are never allowed for a workspace, mapped to the
 * tool the client must not use as a workaround.
 */
function prohibitedRoutes(hints: WorkspaceHints): ProhibitedRoute[] {
  const prohibited: ProhibitedRoute[] = [];
  if (hints.capabilities.includes("android_development")) {
    prohibited.push({
      tool: "execute_command",
      reason:
        "Android build, test, and install must use the android_development background adapter; generic shell and raw Gradle calls are not routed.",
    });
  }
  if (hints.capabilities.includes("node_workflow")) {
    prohibited.push({
      tool: "execute_command",
      reason:
        "Fixed Node verification must use run_local_workflow; raw pnpm and shell retries are not routed.",
    });
  }
  if (hints.capabilities.includes("content_search")) {
    prohibited.push({
      tool: "execute_command",
      reason:
        "Source inspection must use search_content scoped to the selected workspace; shell quoting for text search is not routed.",
    });
  }
  return prohibited;
}

export function planWorkspaceRoute(
  hints: WorkspaceHints,
  phase: WorkspacePhase,
  workspaceId = "",
): RoutePlan {
  const recommended: RouteStep[] =
    phase === "selected"
      ? [
          {
            purpose: "Read the declared instruction files",
            tool: "read_file",
            required: true,
            input: { files: hints.instructionFiles },
          },
        ]
      : [
          { purpose: "Read source", tool: "read_file", required: false, input: {} },
          { purpose: "Search source", tool: "search_content", required: false, input: {} },
        ];
  if (hints.capabilities.includes("android_development")) {
    recommended.push(androidStep());
  }
  if (hints.capabilities.includes("node_workflow")) {
    recommended.push(nodeWorkflowStep());
  }
  return {
    workspaceId,
    phase,
    recommended,
    prohibited: prohibitedRoutes(hints),
  };
}

/**
 * Returns a bounded candidate view for a selection ambiguity. Root-free and
 * capped at 16, safe for an owner-scoped error response.
 */
export function boundedCandidates(
  workspaces: ReadonlyArray<{ id: string; label: string }>,
): Array<{ workspaceId: string; label: string }> {
  return workspaces
    .slice(0, 16)
    .map((workspace) => ({
      workspaceId: workspace.id,
      label: workspace.label,
    }));
}