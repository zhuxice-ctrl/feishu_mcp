/**
 * Stable task contracts for the development task subsystem.
 *
 * These types are persisted to disk and consumed by later Android, Windows,
 * and environment adapters. They must remain backward-compatible: never
 * remove a field, only widen unions or add optional fields.
 */

export type DevelopmentTaskState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "interrupted";

export type DevelopmentTaskClass = "default" | "build" | "privileged";

export type DevelopmentTaskKind = "command" | "workflow" | "server";

/** Terminal-safe per-step state for serial workflow execution. */
export type DevelopmentStepState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface DevelopmentArtifact {
  name: string;
  path: string;
  kind: string;
  size?: number;
  sha256?: string;
}

/** Closed binary capture contract; currently only Android PNG screenshots. */
export interface DevelopmentBinaryStdoutSink {
  stream: "stdout";
  type: "png";
  target: string;
  name: string;
  kind: "screenshot";
}

export interface DevelopmentDirectArtifact {
  name: string;
  path: string;
  kind: "windows-signed";
}

export interface DevelopmentWindowsSigningCleanup {
  stagingPath: string;
  outFile: string;
}

/**
 * Internal launch specification. Only the coordinator and validated internal
 * adapters may construct one; MCP tool callers never see this type.
 */
export interface DevelopmentLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** Non-secret adapter-generated values only. Sensitive keys are rejected. */
  env: Record<string, string>;
  /** Opaque local credential IDs resolved in worker memory before spawn. */
  secretEnvRefs?: Record<string, string>;
  /** At most 4096 bytes of internal adapter-provided stdin. */
  stdin?: string;
  timeoutMs: number;
  successExitCodes: number[];
  /** Canonical output roots inside already-authorized project directories. */
  artifactRoots?: string[];
  /** Raw binary stdout destinations owned and published by the worker. */
  binaryStdoutSinks?: DevelopmentBinaryStdoutSink[];
  /** Adapter-owned outputs that are collected only after successful exit. */
  directArtifacts?: DevelopmentDirectArtifact[];
  /** Fixed Windows signing staging path removed on every terminal outcome. */
  windowsSigningCleanup?: DevelopmentWindowsSigningCleanup;
}

// ---------------------------------------------------------------------------
// Workflow launch specification (Phase 1 — serial PNPM verification)
// ---------------------------------------------------------------------------

/**
 * A single fixed step in a serial development workflow. The executable and
 * arguments are constructed entirely by the closed web adapter from the
 * trusted catalog — an MCP caller can never supply them.
 */
export interface DevelopmentWorkflowStep {
  id: string;
  kind: "typecheck" | "lint" | "test_selected" | "build";
  executable: string;
  args: string[];
  /** Per-step timeout in milliseconds. */
  timeoutMs: number;
  enabled: boolean;
}

/**
 * Launch specification for a `kind: "workflow"` task. The worker executes
 * each enabled step serially with `shell: false`, redacts output, and
 * persists safe per-step results.
 */
export interface DevelopmentWorkflowLaunchSpec {
  workspaceId: string;
  recipeId: string;
  /** SHA-256 digest binding this launch to a specific catalog recipe version. */
  recipeDigest: string;
  /** Canonical workspace root used as cwd for every step. */
  cwd: string;
  steps: DevelopmentWorkflowStep[];
  /** Total timeout across all steps. */
  timeoutMs: number;
  /** Canonical output directories for artifact summaries. */
  artifactDirs?: string[];
}

// ---------------------------------------------------------------------------
// Persistent local-server sessions
// ---------------------------------------------------------------------------

import type { DevServerRuntime, DevServerScope, DevServerState } from "../servers/contracts.js";

/** Safe server details persisted on the task record and eligible for public views. */
export interface DevelopmentServerSession {
  serviceId: string;
  runtime: DevServerRuntime;
  scope: DevServerScope;
  port: number;
  state: DevServerState;
  localUrl: string;
  lanUrls: string[];
  healthPath?: string;
  readyAt?: string;
}

/** Internal, validated launch contract kept in server.json, never exposed by MCP. */
export interface DevelopmentServerLaunchSpec extends DevelopmentLaunchSpec {
  server: Omit<DevelopmentServerSession, "state" | "lanUrls" | "readyAt">;
  startupTimeoutMs: number;
}

/** Per-step result persisted in the task record. */
export interface DevelopmentTaskStepResult {
  id: string;
  kind: "typecheck" | "lint" | "test_selected" | "build";
  state: DevelopmentStepState;
  exitCode: number | null;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

/** Directory artifact summary published after a successful workflow. */
export interface DevelopmentDirectorySummary {
  id: string;
  kind: "directory-summary";
  path: string;
  fileCount: number;
  byteTotal: number;
}

export interface DevelopmentWorkerHandle {
  pid: number;
  nonce: string;
  heartbeatAt: string;
}

export interface DevelopmentTaskExit {
  code: number | null;
  errorCode?: string;
  message?: string;
}

export interface DevelopmentTaskRecord {
  version: 1;
  id: string;
  ownerKey: string;
  tool: string;
  action: string;
  class: DevelopmentTaskClass;
  /** Discriminates command-launch vs workflow-launch tasks. */
  kind?: DevelopmentTaskKind;
  resources: string[];
  state: DevelopmentTaskState;
  stage: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  worker?: DevelopmentWorkerHandle;
  exit?: DevelopmentTaskExit;
  artifacts: DevelopmentArtifact[];
  /** Per-step results for workflow tasks; absent for command tasks. */
  steps?: DevelopmentTaskStepResult[];
  /** Directory artifact summaries published after successful workflows. */
  directorySummaries?: DevelopmentDirectorySummary[];
  /** Present only for persistent local server tasks. */
  server?: DevelopmentServerSession;
}

/** Input accepted by the store when creating a new task record. */
export interface DevelopmentTaskCreateInput {
  ownerKey: string;
  tool: string;
  action: string;
  class: DevelopmentTaskClass;
  resources: string[];
  /** Optional kind for new tasks; legacy persisted JSON defaults to "command". */
  kind?: DevelopmentTaskKind;
}

/** Partial update applied by a compare-and-set transition. */
export interface DevelopmentTaskUpdatePatch {
  state?: DevelopmentTaskState;
  stage?: string;
  startedAt?: string;
  endedAt?: string;
  worker?: DevelopmentWorkerHandle;
  exit?: DevelopmentTaskExit;
  artifacts?: DevelopmentArtifact[];
  steps?: DevelopmentTaskStepResult[];
  directorySummaries?: DevelopmentDirectorySummary[];
  server?: DevelopmentServerSession;
}
