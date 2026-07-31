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
}

/** Input accepted by the store when creating a new task record. */
export interface DevelopmentTaskCreateInput {
  ownerKey: string;
  tool: string;
  action: string;
  class: DevelopmentTaskClass;
  resources: string[];
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
}
