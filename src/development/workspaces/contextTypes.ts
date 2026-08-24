/**
 * Workspace context and route contracts.
 *
 * These types are shared by the owner-scoped context store and the pure route
 * planner. No public type carries an absolute root or a raw user ID.
 */

export const WORKSPACE_PHASES = [
  "selected",
  "instructions_ready",
  "inspected",
  "editing",
  "verification_queued",
  "verification_running",
  "verification_terminal",
] as const;

export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];

export interface WorkspaceContext {
  version: 1;
  contextId: string;
  /** Internal only — derived one-way owner key, never a raw user ID. */
  ownerKey: string;
  workspaceId: string;
  catalogDigest: string;
  phase: WorkspacePhase;
  instructionFilesRead: string[];
  lastError?: RouteErrorSummary;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export const VALID_WORKSPACE_TRANSITIONS: Record<
  WorkspacePhase,
  readonly WorkspacePhase[]
> = {
  selected: ["instructions_ready"],
  instructions_ready: ["inspected", "editing"],
  inspected: ["editing", "verification_queued"],
  editing: ["inspected", "verification_queued"],
  verification_queued: ["verification_running", "verification_terminal"],
  verification_running: ["verification_terminal"],
  verification_terminal: ["editing", "verification_queued"],
};

export const validateWorkspaceTransition = (
  from: WorkspacePhase,
  to: WorkspacePhase,
): boolean => VALID_WORKSPACE_TRANSITIONS[from].includes(to);

/** Root-free public view of a context, safe for an MCP response. */
export interface WorkspacePublicContext {
  version: 1;
  contextId: string;
  workspaceId: string;
  phase: WorkspacePhase;
  instructionFilesRead: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RouteStep {
  purpose: string;
  tool: string;
  action?: string;
  required: boolean;
  /** IDs / relative file names only, never an absolute root. */
  input: Record<string, string | string[]>;
}

export interface ProhibitedRoute {
  reason: string;
  tool: string;
}

export interface RoutePlan {
  workspaceId: string;
  phase: WorkspacePhase;
  recommended: RouteStep[];
  prohibited: ProhibitedRoute[];
}

/** Safe, bounded failure summary stored on a context. */
export interface RouteErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
  nextAction?: {
    tool: string;
    action?: string;
    reason: string;
  };
  /** Root-free candidates, capped, visible to the owner only. */
  candidates?: Array<{ workspaceId: string; label: string }>;
}

export type FreshContextResult =
  | { kind: "fresh"; context: WorkspaceContext }
  | { kind: "stale"; context: WorkspaceContext }
  | { kind: "none" }
  | { kind: "ambiguous" };