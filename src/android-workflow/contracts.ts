/**
 * Android Workflow — Versioned Contracts and Capability Boundaries
 *
 * This module is the single source of truth for all types, interfaces, and
 * validation rules that the core coordinator depends on.  No core module may
 * import application-specific values (package names, UI text, API paths, or
 * project directories) — those live exclusively inside Profile definitions.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Run request / result
// ---------------------------------------------------------------------------

export interface RunRequest {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly profileId: string;
  readonly workdir: string;
  readonly apkPath: string;
  readonly deviceId: "emulator-5554";
  readonly sshHost: string;
}

export interface RunResult {
  readonly runId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly apkDigest: string;
  readonly nodes: ReadonlyArray<NodeExecutionRecord>;
  readonly evidencePath: string | null;
  readonly error: StagingError | null;
}

export interface NodeExecutionRecord {
  readonly nodeId: string;
  readonly state: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly durationMs: number;
  readonly redactedMessage: string;
}

// ---------------------------------------------------------------------------
// Tunnel adapter contract
// ---------------------------------------------------------------------------

export interface TunnelSpec {
  readonly alias: string;
  readonly localPort: number;
  readonly remotePort: number;
}

export interface TunnelHandle {
  readonly spec: TunnelSpec;
  readonly startedAt: number;
}

export interface TunnelAdapter {
  connect(spec: TunnelSpec): Promise<TunnelHandle>;
  disconnect(handle: TunnelHandle): Promise<void>;
  probe(handle: TunnelHandle): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Android device adapter contract
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  readonly deviceId: "emulator-5554";
  readonly apiLevel: number;
  readonly abi: string;
}

export interface ApkArtifact {
  readonly path: string;
  readonly packageName: string;
  readonly sha256: string;
}

export interface UiTarget {
  readonly resourceId?: string;
  readonly textHint?: string;
  readonly coordinates?: { x: number; y: number };
}

export type UiAssertionKind = "text_present" | "text_absent" | "http_status" | "http_body_contains";

export interface UiAssertion {
  readonly kind: UiAssertionKind;
  readonly value: string;
  readonly timeoutMs?: number;
}

export interface RedactedArtifact {
  readonly path: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly redacted: true;
}

export interface AndroidDeviceAdapter {
  preflight(deviceId: string): Promise<DeviceInfo>;
  install(apk: ApkArtifact): Promise<void>;
  launch(packageName: string, activity?: string): Promise<void>;
  tap(target: UiTarget): Promise<void>;
  input(value: string): Promise<void>;
  assert(assertion: UiAssertion): Promise<void>;
  screenshot(): Promise<RedactedArtifact>;
  logcatTail(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Workflow node / graph
// ---------------------------------------------------------------------------

export type NodeActionType =
  | "install_apk"
  | "launch_app"
  | "tap"
  | "input"
  | "wait"
  | "assert_text"
  | "assert_http"
  | "disconnect_tunnel"
  | "reconnect_tunnel"
  | "write_evidence";

export const ALLOWED_NODE_ACTIONS: ReadonlySet<NodeActionType> = new Set<NodeActionType>([
  "install_apk", "launch_app", "tap", "input", "wait",
  "assert_text", "assert_http", "disconnect_tunnel",
  "reconnect_tunnel", "write_evidence",
]);

export interface WorkflowNode {
  readonly id: string;
  readonly type: NodeActionType;
  readonly label?: string;
  readonly target?: UiTarget;
  readonly inputValue?: string;
  readonly assertion?: UiAssertion;
  readonly waitMs?: number;
  /** State to transition to after this node succeeds. */
  readonly onSuccess: string;
  /** Optional state to transition to if this node fails (e.g. offline branch). */
  readonly onFailure?: string;
}

export interface WorkflowGraph {
  readonly entryState: string;
  readonly nodes: ReadonlyArray<WorkflowNode>;
}

// ---------------------------------------------------------------------------
// Profile contract
// ---------------------------------------------------------------------------

export type ProfileCapability = "ui" | "http" | "offline" | "recovery";

export interface ProfileInput {
  readonly workdir: string;
  readonly apkPath: string;
  readonly sshHost: string;
}

export interface AndroidAppProfile {
  readonly id: string;
  readonly version: number;
  readonly packageName: string;
  readonly activity?: string;
  readonly tunnel: { readonly remotePort: number; readonly localPort: number };
  readonly graph: WorkflowGraph;
  readonly capabilities: ReadonlySet<ProfileCapability>;
  validate(input: ProfileInput): void;
}

// ---------------------------------------------------------------------------
// Profile plugin (restricted extension seam)
// ---------------------------------------------------------------------------

export interface WorkflowContext {
  readonly runId: string;
  readonly device: AndroidDeviceAdapter;
  readonly tunnel: TunnelAdapter;
  readonly tunnelHandle: TunnelHandle | null;
  /** Redact sensitive values before returning or logging. */
  redact(value: string): string;
  /** Abort signal honoured by all adapter calls. */
  readonly signal: AbortSignal;
}

export interface ProfilePlugin {
  readonly id: string;
  readonly version: number;
  readonly capabilities: ReadonlySet<ProfileCapability>;
  /** Called by the coordinator before node execution; may return override targets. */
  beforeNode?(node: WorkflowNode, context: WorkflowContext): Promise<WorkflowNode | void>;
  /** Called after node execution for custom evidence or recovery decisions. */
  afterNode?(node: WorkflowNode, context: WorkflowContext, result: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export interface StagingError {
  readonly code: string;
  readonly nodeId: string;
  readonly retryable: boolean;
  readonly redactedMessage: string;
  readonly cleanupState: "pending" | "completed" | "failed";
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  readonly runId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: string;
  readonly nodes: ReadonlyArray<NodeExecutionRecord>;
  readonly apkDigest: string;
  readonly deviceInfo: { readonly deviceId: string; readonly apiLevel: number; readonly abi: string } | null;
  readonly errors: ReadonlyArray<StagingError>;
}

// ---------------------------------------------------------------------------
// Workflow topology — states and valid transitions
// ---------------------------------------------------------------------------

export const WORKFLOW_STATES: ReadonlySet<string> = new Set([
  "created",
  "preflight_passed",
  "tunnel_connected",
  "app_ready",
  "scenario_started",
  "scenario_passed",
  "tunnel_interrupted",
  "failure_state_confirmed",
  "tunnel_reconnected",
  "recovery_passed",
  "evidence_written",
  "completed",
  "failed",
  "cancelled",
  "cleanup_failed",
]);

export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  created: ["preflight_passed", "cancelled", "failed"],
  preflight_passed: ["tunnel_connected", "failed", "cancelled"],
  tunnel_connected: ["app_ready", "tunnel_interrupted", "failed", "cancelled"],
  app_ready: ["scenario_started", "failed", "cancelled"],
  scenario_started: ["scenario_passed", "tunnel_interrupted", "failed", "cancelled"],
  scenario_passed: ["evidence_written", "failed", "cancelled"],
  tunnel_interrupted: ["tunnel_reconnected", "failure_state_confirmed", "cancelled"],
  failure_state_confirmed: ["failed", "cancelled"],
  tunnel_reconnected: ["recovery_passed", "failure_state_confirmed", "cancelled"],
  recovery_passed: ["scenario_started", "evidence_written", "failed", "cancelled"],
  evidence_written: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  cleanup_failed: [],
};

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

export function parseRunRequest(raw: Record<string, unknown>): RunRequest {
  const { profileId, workdir, apkPath, sshHost, deviceId } = raw;

  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new Error("RunRequest.profileId is required");
  }
  if (typeof workdir !== "string" || workdir.length === 0) {
    throw new Error("RunRequest.workdir is required");
  }
  if (typeof apkPath !== "string" || apkPath.length === 0) {
    throw new Error("RunRequest.apkPath is required");
  }
  if (typeof sshHost !== "string" || sshHost.length === 0) {
    throw new Error("RunRequest.sshHost is required");
  }

  const resolvedDeviceId = deviceId ?? "emulator-5554";
  if (resolvedDeviceId !== "emulator-5554") {
    throw new Error(`deviceId must be "emulator-5554", got: ${resolvedDeviceId}`);
  }

  return {
    contractVersion: CONTRACT_VERSION,
    profileId,
    workdir,
    apkPath,
    deviceId: "emulator-5554",
    sshHost,
  };
}

export function validateNode(node: unknown): asserts node is WorkflowNode {
  const record = node as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !ALLOWED_NODE_ACTIONS.has(type as NodeActionType)) {
    throw new Error(`undeclared action: ${String(type)}`);
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("WorkflowNode.id is required");
  }
  if (typeof record.onSuccess !== "string" || record.onSuccess.length === 0) {
    throw new Error("WorkflowNode.onSuccess is required");
  }
  if (record.onFailure !== undefined && (typeof record.onFailure !== "string" || record.onFailure.length === 0)) {
    throw new Error("WorkflowNode.onFailure must be a non-empty string when present");
  }
}

/**
 * Validate that a state transition is allowed by the topology.
 * Throws if the transition is not declared in VALID_TRANSITIONS.
 */
export function validateTransition(from: string, to: string): void {
  if (!WORKFLOW_STATES.has(from)) {
    throw new Error(`unknown source state: ${from}`);
  }
  if (!WORKFLOW_STATES.has(to)) {
    throw new Error(`unknown target state: ${to}`);
  }
  const allowed = VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid transition: ${from} → ${to}`);
  }
}

/**
 * Validate an entire WorkflowGraph: every node's action type must be declared,
 * and every onSuccess / onFailure target must be a known state.
 */
export function validateGraph(graph: WorkflowGraph): void {
  if (!WORKFLOW_STATES.has(graph.entryState)) {
    throw new Error(`unknown entry state: ${graph.entryState}`);
  }
  for (const node of graph.nodes) {
    validateNode(node);
    if (!WORKFLOW_STATES.has(node.onSuccess)) {
      throw new Error(`node ${node.id}: onSuccess targets unknown state ${node.onSuccess}`);
    }
    if (node.onFailure && !WORKFLOW_STATES.has(node.onFailure)) {
      throw new Error(`node ${node.id}: onFailure targets unknown state ${node.onFailure}`);
    }
  }
}
