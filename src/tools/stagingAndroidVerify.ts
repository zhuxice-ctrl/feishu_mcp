/**
 * staging_android_verify MCP tool — thin adapter that validates a versioned
 * RunRequest and delegates to the generic StagingCoordinator.
 *
 * The handler contains NO application-specific branches: it validates the
 * request contract, resolves the Profile from the registry, and delegates to
 * the coordinator.  Owner authorization is required; the tool is restricted
 * to the configured owner.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { parseRunRequest, type ApkArtifact } from "../android-workflow/contracts.js";
import { ProfileRegistry } from "../android-workflow/profileRegistry.js";
import { StateStore } from "../android-workflow/stateStore.js";
import { StagingCoordinator } from "../android-workflow/coordinator.js";
import { OpenSshTunnelAdapter } from "../android-workflow/tunnelAdapter.js";
import { AdbDeviceAdapter } from "../android-workflow/androidDeviceAdapter.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export interface StagingAndroidVerifyOptions {
  readonly registry: ProfileRegistry;
  readonly stateStoreDir: string;
  readonly evidenceDir: string;
}

async function computeSha256(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export function registerStagingAndroidVerifyTool(
  server: McpServer,
  options: StagingAndroidVerifyOptions,
): void {
  const { registry, stateStoreDir, evidenceDir } = options;
  const tunnelAdapter = new OpenSshTunnelAdapter();
  const deviceAdapter = new AdbDeviceAdapter();
  const stateStore = new StateStore(stateStoreDir);
  const coordinator = new StagingCoordinator({
    tunnel: tunnelAdapter,
    device: deviceAdapter,
    registry,
    stateStore,
    evidenceDir,
  });

  server.registerTool(
    "staging_android_verify",
    {
      description:
        "Run a reusable, contract-driven Android staging verification workflow on " +
        "emulator-5554. Validates APK install, SSH tunnel, UI/API assertions, offline " +
        "recovery, and writes redacted evidence. The application is selected by profileId; " +
        "no application-specific branches exist in the core coordinator. " +
        "Restricted to the configured owner.",
      inputSchema: {
        profileId: z.string().trim().min(1).max(64).describe("Registered Profile id, e.g. zeroxcore"),
        workdir: z.string().trim().min(1).max(1024).describe("Absolute path to the application working directory"),
        apkPath: z.string().trim().min(1).max(1024).describe("Absolute path to the debug APK to install"),
        sshHost: z.string().trim().min(1).max(64).describe("SSH config alias for the staging host"),
        deviceId: z.literal("emulator-5554").optional().describe("Fixed device id (defaults to emulator-5554)"),
        resumeRunId: z.string().trim().min(1).max(128).optional().describe("Existing runId to resume from the last checkpoint"),
      },
    },
    async (args) => {
      const authError = authorizeOwnerToolCall("staging_android_verify", args);
      if (authError) return authError;

      return runTool(
        {
          name: "staging_android_verify",
          concurrency: "default",
          subject: { kind: "device", key: args.sshHost, display: args.sshHost },
        },
        async () => {
          let request;
          try {
            request = parseRunRequest(args);
          } catch (err) {
            return toolError("INVALID_ARGUMENT", err instanceof Error ? err.message : String(err));
          }

          if (!registry.has(request.profileId)) {
            return toolError("INVALID_ARGUMENT", `unknown profile: ${request.profileId}`);
          }

          const profile = registry.get(request.profileId);

          let apkDigest: string;
          try {
            apkDigest = await computeSha256(request.apkPath);
          } catch (err) {
            return toolError("INVALID_ARGUMENT", `cannot read APK: ${err instanceof Error ? err.message : String(err)}`);
          }

          const apk: ApkArtifact = {
            path: request.apkPath,
            packageName: profile.packageName,
            sha256: apkDigest,
          };

          const signal = AbortSignal.timeout(300_000);
          const result = await coordinator.run(request, apk, signal, args.resumeRunId);

          return toolJson({
            ok: result.status === "completed",
            runId: result.runId,
            profileId: result.profileId,
            profileVersion: result.profileVersion,
            status: result.status,
            apkDigest: result.apkDigest,
            nodeCount: result.nodes.length,
            evidencePath: result.evidencePath,
            error: result.error,
          });
        },
      );
    },
  );
}
