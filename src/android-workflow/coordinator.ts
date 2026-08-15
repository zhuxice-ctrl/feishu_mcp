/**
 * StagingCoordinator — profile-driven orchestration and evidence assembly.
 *
 * The coordinator resolves a Profile from the registry, runs preflight and
 * tunnel connection, executes the Profile's topology nodes through injected
 * adapters, checkpoints before and after side effects, writes redacted
 * evidence, and cleans up owned resources in `finally`.
 *
 * The coordinator never branches on application identity: every
 * application-specific value comes from the Profile.  Adapters, state store,
 * and evidence writer are injected, so the same coordinator drives any
 * registered Profile.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateTransition,
  type AndroidAppProfile,
  type ApkArtifact,
  type EvidenceRecord,
  type NodeExecutionRecord,
  type RunRequest,
  type RunResult,
  type StagingError,
  type TunnelAdapter,
  type TunnelSpec,
  type AndroidDeviceAdapter,
} from "./contracts.js";
import { StateStore, type Checkpoint } from "./stateStore.js";
import { ProfileRegistry } from "./profileRegistry.js";
import { redact } from "./redaction.js";
import {
  executeNodeWithRetry,
  cancelledError,
  toStagingError,
  type NodeExecutionContext,
  type ProfileNode,
} from "./topology.js";

// ---------------------------------------------------------------------------
// Coordinator dependencies — all injected, never imported concretely.
// ---------------------------------------------------------------------------

export interface CoordinatorDeps {
  readonly tunnel: TunnelAdapter;
  readonly device: AndroidDeviceAdapter;
  readonly registry: ProfileRegistry;
  readonly stateStore: StateStore;
  readonly evidenceDir: string;
}

// ---------------------------------------------------------------------------
// StagingCoordinator
// ---------------------------------------------------------------------------

export class StagingCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  async run(
    request: RunRequest,
    apk: ApkArtifact,
    signal: AbortSignal,
    resumeRunId?: string,
  ): Promise<RunResult> {
    const profile = this.deps.registry.get(request.profileId);
    profile.validate({
      workdir: request.workdir,
      apkPath: request.apkPath,
      sshHost: request.sshHost,
    });

    const runId = resumeRunId ?? randomUUID();
    const tunnelSpec: TunnelSpec = {
      alias: request.sshHost,
      localPort: profile.tunnel.localPort,
      remotePort: profile.tunnel.remotePort,
    };

    // Determine resume point.
    const existing = await this.deps.stateStore.load(runId);
    let state = existing?.state ?? "created";

    const records: NodeExecutionRecord[] = [];
    let error: StagingError | null = null;
    let tunnelHandle = null;
    const startedAt = new Date();

    try {
      // --- Preflight (only if starting fresh) ---
      if (state === "created") {
        await this.deps.device.preflight(request.deviceId);
        validateTransition(state, "preflight_passed");
        state = "preflight_passed";
        await this.checkpoint(runId, state, profile, undefined);
      }

      // --- Tunnel connect ---
      // On a fresh run we transition created→preflight_passed→tunnel_connected.
      // On resume we reconnect to obtain a live handle without changing state.
      if (state === "preflight_passed") {
        tunnelHandle = await this.deps.tunnel.connect(tunnelSpec);
        validateTransition(state, "tunnel_connected");
        state = "tunnel_connected";
        await this.checkpoint(runId, state, profile, undefined);
      } else {
        // Resume: reconnect to get a handle (the previous handle is gone).
        tunnelHandle = await this.deps.tunnel.connect(tunnelSpec);
      }

      // --- Node execution ---
      const ctx: NodeExecutionContext = {
        runId,
        device: this.deps.device,
        tunnel: this.deps.tunnel,
        tunnelHandle,
        tunnelSpec,
        apk,
        packageName: profile.packageName,
        activity: profile.activity,
        signal,
        redact,
      };

      for (const node of profile.graph.nodes as ReadonlyArray<ProfileNode>) {
        const fromState = (node as ProfileNode).fromState;
        // Skip nodes not eligible for the current path.
        if (fromState !== state) continue;

        if (signal.aborted) {
          error = cancelledError(node.id);
          break;
        }

        try {
          const record = await executeNodeWithRetry(node, ctx);
          validateTransition(state, record.state);
          state = record.state;
          records.push(record);
          await this.checkpoint(runId, state, profile, node.id);
        } catch (err) {
          const stagingError = err as StagingError;
          records.push({
            nodeId: node.id,
            state,
            status: "failed",
            durationMs: 0,
            redactedMessage: stagingError.redactedMessage,
          });

          if (signal.aborted) {
            error = cancelledError(node.id);
            break;
          }

          if (node.onFailure) {
            validateTransition(state, node.onFailure);
            state = node.onFailure;
            await this.checkpoint(runId, state, profile, node.id);
            continue;
          }

          error = stagingError;
          break;
        }
      }

      // --- Terminal transition ---
      if (!error && !signal.aborted) {
        // Happy path ends at scenario_passed; recovery branch at recovery_passed.
        // Both can transition to evidence_written.
        if (state === "scenario_passed" || state === "recovery_passed") {
          validateTransition(state, "evidence_written");
          state = "evidence_written";
          await this.checkpoint(runId, state, profile, undefined);
          validateTransition(state, "completed");
          state = "completed";
        } else if (!this.isTerminal(state)) {
          // Graph did not reach a terminal state — treat as failure.
          error = toStagingError("coordinator", new Error(`unexpected terminal state: ${state}`));
        }
      } else if (signal.aborted && !error) {
        error = cancelledError("coordinator");
      }
    } finally {
      // --- Cleanup owned resources ---
      if (tunnelHandle) {
        try {
          await this.deps.tunnel.disconnect(tunnelHandle);
        } catch {
          // Best-effort cleanup; swallow disconnect errors.
        }
      }
    }

    const status: RunResult["status"] = error
      ? (error.code === "CANCELLED" ? "cancelled" : "failed")
      : "completed";

    // --- Write evidence ---
    const evidencePath = await this.writeEvidence({
      runId,
      profileId: profile.id,
      profileVersion: profile.version,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status,
      nodes: records,
      apkDigest: apk.sha256,
      deviceInfo: null,
      errors: error ? [error] : [],
    });

    // --- Clean up checkpoint on terminal success ---
    if (status === "completed") {
      await this.deps.stateStore.finish(runId);
    }

    return {
      runId,
      profileId: profile.id,
      profileVersion: profile.version,
      status,
      apkDigest: apk.sha256,
      nodes: records,
      evidencePath,
      error,
    };
  }

  private isTerminal(state: string): boolean {
    return state === "completed" || state === "failed" || state === "cancelled" || state === "cleanup_failed";
  }

  private async checkpoint(
    runId: string,
    state: string,
    profile: AndroidAppProfile,
    nodeId: string | undefined,
  ): Promise<void> {
    const checkpoint: Checkpoint = {
      runId,
      state,
      profileVersion: profile.version,
      profileId: profile.id,
      nodeId,
      timestamp: new Date().toISOString(),
    };
    await this.deps.stateStore.save(checkpoint);
  }

  private async writeEvidence(record: EvidenceRecord): Promise<string> {
    await mkdir(this.deps.evidenceDir, { recursive: true });
    const jsonPath = path.join(this.deps.evidenceDir, `${record.runId}.evidence.json`);
    const mdPath = path.join(this.deps.evidenceDir, `${record.runId}.evidence.md`);

    await writeFile(jsonPath, JSON.stringify(record, null, 2), "utf-8");

    const lines = [
      `# Staging Verification Evidence`,
      ``,
      `- **Run ID:** ${record.runId}`,
      `- **Profile:** ${record.profileId} (v${record.profileVersion})`,
      `- **Status:** ${record.status}`,
      `- **Started:** ${record.startedAt}`,
      `- **Finished:** ${record.finishedAt}`,
      `- **APK SHA-256:** ${record.apkDigest}`,
      ``,
      `## Nodes`,
      ``,
      ...record.nodes.map(
        (n) => `- \`${n.nodeId}\` — ${n.status} (${n.durationMs}ms) ${n.redactedMessage ? `— ${n.redactedMessage}` : ""}`,
      ),
      ``,
    ];
    if (record.errors.length > 0) {
      lines.push(`## Errors`, ``);
      for (const e of record.errors) {
        lines.push(`- [${e.code}] ${e.nodeId}: ${e.redactedMessage} (retryable=${e.retryable})`);
      }
      lines.push(``);
    }
    await writeFile(mdPath, redact(lines.join("\n")), "utf-8");

    return mdPath;
  }
}
