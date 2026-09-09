/**
 * restart_service — controlled one-click rebuild + self-restart.
 *
 * Dual-channel plan (docs/dual-channel-plan-20260908.md): process-level
 * file-watch hot reload is intentionally NOT used. Changes are applied
 * through this explicit, agent-callable tool instead:
 *
 *   1. Rebuild first (`npm run build`). If the build fails, the running
 *      service is left untouched and the error is returned — broken code
 *      never takes a healthy service down.
 *   2. On build success, spawn the detached restart orchestrator
 *      (scripts/restart-orchestrator.mjs), which terminates this process
 *      and relaunches it through the isolation launcher
 *      (scripts/start-test-mcp.mjs), so every isolation invariant (clean
 *      env, ALLOWED_DIRS, fixed port) is re-applied exactly as on the
 *      first start.
 *   3. The cloudflared tunnel is a separate process and is NOT touched;
 *      it reconnects to the fresh origin on its own.
 *
 * Gates:
 *   - transport Bearer auth (applies to every tool on this server)
 *   - FEISHU_MCP_MANAGED_LAUNCH=1 marker, injected only by the isolation
 *     launcher. An instance started any other way refuses self-restart.
 *
 * Note: OWNER_USER_ID is deliberately stripped from the isolation launcher
 * env, so owner-scoped gating is unavailable on the managed test channel;
 * the Bearer token holder is the effective owner of that channel.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authorizeToolCall } from "../security/toolAccess.js";
import { logger } from "../security/logger.js";
import { toolError } from "./results.js";
import { runTool } from "./registry.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Reason the self-restart gate refuses, or null when allowed. Exported for tests. */
export function restartBlockedReason(
  env: Record<string, string | undefined>,
): string | null {
  if (env["FEISHU_MCP_MANAGED_LAUNCH"] !== "1") {
    return (
      "RESTART_NOT_MANAGED: this instance was not started by the isolation launcher " +
      "(FEISHU_MCP_MANAGED_LAUNCH != 1); self-restart is refused. Start the service " +
      "via scripts/start-test-mcp.mjs to enable controlled restarts."
    );
  }
  return null;
}

/** Last n non-empty lines of a log. Exported for tests. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-maxLines).join("\n");
}

export function registerRestartTool(server: McpServer): void {
  server.registerTool(
    "restart_service",
    {
      description:
        "Controlled one-click rebuild + self-restart for this MCP service. Runs " +
        "`npm run build` first; if the build fails, the running service is left " +
        "untouched. On build success, spawns a detached orchestrator that stops this " +
        "process and relaunches it through the isolation launcher (clean env " +
        "re-applied); the cloudflared tunnel is not touched and reconnects " +
        "automatically. Refuses unless the instance was started by the isolation " +
        "launcher (FEISHU_MCP_MANAGED_LAUNCH=1). After calling, expect the connection " +
        "to drop for a few seconds; verify /health before continuing.",
      inputSchema: {
        reason: z
          .string()
          .optional()
          .describe("Optional human-readable reason recorded in the restart log"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("restart_service", args);
      if (accessError) return accessError;

      const blocked = restartBlockedReason(process.env);
      if (blocked) {
        logger.warn("restart_service_refused", { detail: blocked });
        return toolError("INVALID_ARGUMENT", blocked);
      }

      return runTool(
        {
          name: "restart_service",
          concurrency: "default",
          subject: { kind: "origin", key: "service", display: "service" },
        },
        async () => {
          const started = Date.now();
          const build = spawnSync("npm", ["run", "build"], {
            cwd: PROJECT_ROOT,
            encoding: "utf8",
            shell: true,
            timeout: 240_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const buildSeconds = ((Date.now() - started) / 1000).toFixed(1);
          const output = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
          if (build.error || build.status !== 0) {
            logger.error("restart_service_build_failed", {
              status: build.status,
              reason: args.reason ?? null,
            });
            return toolError(
              "PROCESS_FAILED",
              `Build failed after ${buildSeconds}s (exit=${build.status ?? "null"}); ` +
                `the running service was NOT restarted. Tail:\n${tailLines(output, 30)}`,
            );
          }

          const orchestrator = join(PROJECT_ROOT, "scripts", "restart-orchestrator.mjs");
          if (!existsSync(orchestrator)) {
            return toolError("INTERNAL_ERROR", `Missing ${orchestrator}; cannot self-restart.`);
          }

          const logDir = process.env["LOG_DIR"] || join(PROJECT_ROOT, "logs");
          mkdirSync(logDir, { recursive: true });
          const out = openSync(join(logDir, "restart-service.log"), "a");
          const child = spawn(
            process.execPath,
            [orchestrator, "--pid", String(process.pid), "--reason", args.reason ?? "unspecified"],
            { cwd: PROJECT_ROOT, detached: true, stdio: ["ignore", out, out] },
          );
          child.unref();
          logger.info("restart_service_initiated", {
            orchestratorPid: child.pid ?? null,
            buildSeconds,
            reason: args.reason ?? null,
          });

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Build succeeded in ${buildSeconds}s; restart initiated ` +
                  `(orchestrator pid=${child.pid ?? "unknown"}). This process will ` +
                  "terminate in ~2s and the isolation launcher will bring it back on " +
                  "the same port with the clean isolation env. Wait a few seconds, " +
                  "then verify /health before continuing.",
              },
            ],
          };
        },
      );
    },
  );
}
