import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
} from "../config.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import {
  containsInternalApprovalPath,
  isInternalApprovalPath,
} from "../security/approvalStore.js";
import { getRequestUserId } from "../security/requestContext.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export type NodeDevelopmentAction = "pnpm_version" | "test_run" | "build" | "typecheck" | "npm_ci" | "npm_test" | "npm_build" | "npm_lint" | "npm_typecheck";

export interface NodeDevelopmentArgs {
  action: NodeDevelopmentAction;
  workdir: string;
  timeout?: number;
}

export const NODE_ACTIONS: Readonly<Record<NodeDevelopmentAction, {
  executable: "pnpm" | "npm";
  args: readonly string[];
}>> = {
  pnpm_version: { executable: "pnpm", args: ["--version"] },
  test_run: { executable: "pnpm", args: ["test:run"] },
  build: { executable: "pnpm", args: ["build"] },
  typecheck: { executable: "pnpm", args: ["typecheck"] },
  npm_ci: { executable: "npm", args: ["ci"] },
  npm_test: { executable: "npm", args: ["test"] },
  npm_build: { executable: "npm", args: ["run", "build"] },
  npm_lint: { executable: "npm", args: ["run", "lint"] },
  npm_typecheck: { executable: "npm", args: ["run", "typecheck"] },
};

export function resolveNodeAction(action: NodeDevelopmentAction) {
  const resolved = NODE_ACTIONS[action];
  return { executable: resolved.executable, args: [...resolved.args] };
}

export function resolveNodeInvocation(action: NodeDevelopmentAction): {
  executable: string;
  args: string[];
} {
  const resolved = resolveNodeAction(action);
  if (process.platform !== "win32") return resolved;
  return {
    executable: process.env.ComSpec || "cmd.exe",
    // Windows cannot directly spawn the pnpm.cmd shim with shell disabled.
    // The complete command string is assembled from the closed action map.
    args: ["/d", "/s", "/c", `${resolved.executable}.cmd ${resolved.args.join(" ")}`],
  };
}

function actionSubject(action: NodeDevelopmentAction, workdir: string, timeoutMs: number): string {
  return createHash("sha256")
    .update(`${action}\u0000${workdir}\u0000${timeoutMs}`)
    .digest("hex");
}

export async function nodeDevelopment(
  args: NodeDevelopmentArgs,
  ctx: ServerContext,
) {
  if (!args.workdir?.trim()) {
    return toolError("INVALID_ARGUMENT", "workdir is required.");
  }
  if (!Object.hasOwn(NODE_ACTIONS, args.action)) {
    return toolError("INVALID_ARGUMENT", "action must be an approved PNPM action.");
  }
  const guard = await resolvePathsGuardAndAuthorize(
    "node_development",
    [{
      argName: "workdir",
      inputPath: args.workdir,
      operation: "read",
      scope: "directory",
      access: "command",
    }],
    args,
    ctx,
  );
  if (!guard.ok) {
    return guard.result ?? toolError(
      "OUTSIDE_ALLOWED_DIRS",
      guard.error ?? "Invalid working directory.",
    );
  }
  const workdir = guard.paths[0].resolvedPath;
  if (isInternalApprovalPath(workdir) || containsInternalApprovalPath(workdir)) {
    return toolError(
      "OUTSIDE_ALLOWED_DIRS",
      "The internal approval directory cannot be used as a working directory.",
    );
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    return toolError("INVALID_ARGUMENT", "The working directory does not exist or is not a directory.");
  }
  const timeoutMs = Math.min(args.timeout ?? COMMAND_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS);
  const subjectKey = actionSubject(args.action, workdir, timeoutMs);
  const approval = await requestApproval(ctx, {
    tool: "node_development",
    userId: getRequestUserId(),
    subject: {
      kind: "development",
      key: subjectKey,
      display: `${args.action}\nWorking directory: ${workdir}`,
    },
    argsDigest: digestArguments(args),
    reasons: [`Run approved PNPM action ${args.action}.`],
    authorizedDirectoryRootsDigest: guard.directoryProof?.rootsDigest,
  });
  if (approval !== true) return approval;

  const invocation = resolveNodeInvocation(args.action);
  return runTool(
    {
      name: "node_development",
      concurrency: "command",
      subject: {
        kind: "development",
        key: subjectKey,
        display: `${args.action}\nWorking directory: ${workdir}`,
      },
    },
    async () => {
      const result = await runProcess(invocation.executable, invocation.args, {
        cwd: workdir,
        timeoutMs,
        maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
        signal: ctx.mcpReq.signal,
        env: { ...process.env },
      });
      return toolJson({ ok: true, action: args.action, ...result });
    },
  );
}

export function registerNodeDevelopmentTool(server: McpServer): void {
  server.registerTool(
    "node_development",
    {
      description: "Run one approved PNPM development action in an authorized working directory. " +
        "Supported actions are pnpm_version, test_run, build, and typecheck; " +
        "arbitrary commands and arguments are not accepted.",
      inputSchema: {
        action: z.enum(["pnpm_version", "test_run", "build", "typecheck", "npm_ci", "npm_test", "npm_build", "npm_lint", "npm_typecheck"]),
        workdir: z.string().min(1),
        timeout: z.number().int().positive().optional(),
      },
    },
    async (args, ctx) =>
      authorizeToolCall("node_development", args) ?? nodeDevelopment(args, ctx),
  );
}
