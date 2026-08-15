/**
 * Topology — graph validation, node execution, retry/cancel rules, and
 * transition events for the Android verification workflow.
 *
 * The engine validates the declared workflow graph against the contract
 * topology, executes nodes through adapter interfaces, and emits state
 * transitions that the coordinator persists as checkpoints.  Nodes honour an
 * AbortSignal and may only be retried when the resulting error is marked
 * retryable by the contract error model.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "工作流是节点图 … 节点通过明确输入/输出契约连接，可插入、替换和重试。"
 */

import {
  validateTransition,
  validateGraph,
  WORKFLOW_STATES,
  VALID_TRANSITIONS,
  type WorkflowGraph,
  type WorkflowNode,
  type NodeExecutionRecord,
  type AndroidDeviceAdapter,
  type TunnelAdapter,
  type TunnelHandle,
  type TunnelSpec,
  type ApkArtifact,
  type StagingError,
} from "./contracts.js";
import { redact } from "./redaction.js";

// ---------------------------------------------------------------------------
// Profile node — extends WorkflowNode with the state a node is eligible to
// run from.  This lets a profile declare an offline/recovery branch without
// the coordinator branching on application identity: recovery nodes simply
// declare a `fromState` that only matches after an interruption.
// ---------------------------------------------------------------------------

export interface ProfileNode extends WorkflowNode {
  /** Workflow state that must be current for this node to execute. */
  readonly fromState: string;
}

export interface ProfileGraph extends WorkflowGraph {
  readonly nodes: ReadonlyArray<ProfileNode>;
}

// ---------------------------------------------------------------------------
// Execution context — the capabilities a node may use.  Adapters are injected;
// nodes never receive raw process handles or environment access.
// ---------------------------------------------------------------------------

export interface NodeExecutionContext {
  readonly runId: string;
  readonly device: AndroidDeviceAdapter;
  readonly tunnel: TunnelAdapter;
  tunnelHandle: TunnelHandle | null;
  readonly tunnelSpec: TunnelSpec;
  readonly apk: ApkArtifact;
  readonly packageName: string;
  readonly activity?: string;
  readonly signal: AbortSignal;
  redact(value: string): string;
}

// ---------------------------------------------------------------------------
// TopologyEngine — validates a graph and exposes transition helpers.
// ---------------------------------------------------------------------------

export class TopologyEngine {
  private readonly graph: WorkflowGraph;

  constructor(graph: WorkflowGraph) {
    validateGraph(graph);
    this.graph = graph;
  }

  get entryState(): string {
    return this.graph.entryState;
  }

  get nodes(): ReadonlyArray<WorkflowNode> {
    return this.graph.nodes;
  }

  /** Validate a single transition, throwing on illegal jumps. */
  transition(from: string, to: string): void {
    validateTransition(from, to);
  }

  /** True when a state has no outgoing transitions (terminal). */
  isTerminal(state: string): boolean {
    const next = VALID_TRANSITIONS[state];
    return !next || next.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Classify an error thrown by an adapter into the contract StagingError.
 * Only connectivity / timeout failures are retryable; everything else
 * terminates the run.
 */
export function toStagingError(nodeId: string, err: unknown): StagingError {
  const raw = err instanceof Error ? err.message : String(err);
  const retryable = /tunnel|connect|probe|timeout|econnreset|etimedout|reset by peer/i.test(raw);
  return {
    code: retryable ? "TUNNEL_ERROR" : "NODE_FAILED",
    nodeId,
    retryable,
    redactedMessage: redact(raw),
    cleanupState: "pending",
  };
}

export function cancelledError(nodeId: string): StagingError {
  return {
    code: "CANCELLED",
    nodeId,
    retryable: false,
    redactedMessage: "run cancelled by abort signal",
    cleanupState: "pending",
  };
}

// ---------------------------------------------------------------------------
// Node execution
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute a single workflow node through the injected adapter context.
 *
 * Returns a NodeExecutionRecord on success.  Throws a StagingError on
 * failure so the coordinator can decide whether to follow the node's
 * onFailure branch or terminate.
 */
export async function executeNode(
  node: WorkflowNode,
  ctx: NodeExecutionContext,
): Promise<NodeExecutionRecord> {
  const start = Date.now();

  if (ctx.signal.aborted) {
    throw cancelledError(node.id);
  }

  try {
    switch (node.type) {
      case "install_apk":
        await ctx.device.install(ctx.apk);
        break;
      case "launch_app":
        await ctx.device.launch(ctx.packageName, ctx.activity);
        break;
      case "tap":
        if (!node.target) throw new Error("tap node requires a target");
        await ctx.device.tap(node.target);
        break;
      case "input":
        if (node.inputValue === undefined) throw new Error("input node requires inputValue");
        await ctx.device.input(node.inputValue);
        break;
      case "wait":
        await sleep(node.waitMs ?? 0, ctx.signal);
        break;
      case "assert_text":
        if (!node.assertion) throw new Error("assert_text node requires an assertion");
        await ctx.device.assert({
          kind: "text_present",
          value: node.assertion.value,
          timeoutMs: node.assertion.timeoutMs,
        });
        break;
      case "assert_http":
        if (!node.assertion) throw new Error("assert_http node requires an assertion");
        await ctx.device.assert({
          kind: "http_body_contains",
          value: node.assertion.value,
          timeoutMs: node.assertion.timeoutMs,
        });
        break;
      case "disconnect_tunnel":
        if (ctx.tunnelHandle) {
          await ctx.tunnel.disconnect(ctx.tunnelHandle);
          ctx.tunnelHandle = null;
        }
        break;
      case "reconnect_tunnel": {
        const handle = await ctx.tunnel.connect(ctx.tunnelSpec);
        ctx.tunnelHandle = handle;
        break;
      }
      case "write_evidence":
        // Evidence is assembled by the coordinator; this node is a marker.
        break;
      default:
        throw new Error(`unhandled node type: ${node.type}`);
    }
  } catch (err) {
    if (ctx.signal.aborted) {
      throw cancelledError(node.id);
    }
    throw toStagingError(node.id, err);
  }

  return {
    nodeId: node.id,
    state: node.onSuccess,
    status: "passed",
    durationMs: Date.now() - start,
    redactedMessage: "",
  };
}

/**
 * Execute a node with at most one retry when the error is retryable.
 * Cancellation aborts immediately without retry.
 */
export async function executeNodeWithRetry(
  node: WorkflowNode,
  ctx: NodeExecutionContext,
): Promise<NodeExecutionRecord> {
  try {
    return await executeNode(node, ctx);
  } catch (err) {
    const stagingError = err as StagingError;
    if (ctx.signal.aborted || !stagingError.retryable) {
      throw stagingError;
    }
    // Single retry for recoverable connectivity failures.
    return await executeNode(node, ctx);
  }
}
