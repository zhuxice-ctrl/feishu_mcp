import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  ALLOWED_DIRS,
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { validatePath } from "../security/pathGuard.js";
import {
  containsInternalApprovalPath,
  isInternalApprovalPath,
} from "../security/approvalStore.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { classifyCommand } from "./commandPolicy.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export interface ExecuteCommandArgs {
  command: string;
  workdir?: string;
  timeout?: number;
}

function commandSubject(command: string, workdir: string): string {
  return createHash("sha256").update(`${workdir}\u0000${command}`).digest("hex");
}

export async function executeCommand(
  args: ExecuteCommandArgs,
  ctx: ServerContext,
) {
  const risk = classifyCommand(args.command);
  const requestedWorkdir = args.workdir ?? ALLOWED_DIRS[0];
  if (!requestedWorkdir) return toolError("OUTSIDE_ALLOWED_DIRS", "No allowed working directory is configured.");
  const checked = validatePath(requestedWorkdir);
  if (!checked.ok || !checked.resolvedPath) {
    return toolError("OUTSIDE_ALLOWED_DIRS", checked.error ?? "Invalid working directory.");
  }
  const workdir = checked.resolvedPath;
  if (isInternalApprovalPath(workdir) || containsInternalApprovalPath(workdir)) {
    return toolError("OUTSIDE_ALLOWED_DIRS", "The internal approval directory cannot be used as a working directory.");
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    return toolError("INVALID_ARGUMENT", "The working directory does not exist or is not a directory.");
  }
  if (risk.level === "approval_required") {
    const approval = await requestApproval(ctx, {
      tool: "execute_command",
      userId: getRequestUserId(),
      subject: {
        kind: "command",
        key: commandSubject(risk.normalized, workdir),
        display: `${risk.normalized}\nWorking directory: ${workdir}`,
      },
      argsDigest: digestArguments(args),
      reasons: risk.reasons,
    });
    if (approval !== true) return approval;
  }
  const timeoutMs = Math.min(args.timeout ?? COMMAND_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS);
  return runTool(
    {
      name: "execute_command",
      concurrency: "command",
      subject: { kind: "command", key: commandSubject(risk.normalized, workdir), display: risk.normalized },
    },
    async () => {
      const executable = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
      const shellArgs = process.platform === "win32"
        ? ["/d", "/s", "/c", risk.normalized]
        : ["-c", risk.normalized];
      const result = await runProcess(executable, shellArgs, {
        cwd: workdir,
        timeoutMs,
        maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
        signal: ctx.mcpReq.signal,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          PAGER: "cat",
          GIT_EXTERNAL_DIFF: "",
        },
      });
      return toolJson({ ok: true, risk: risk.level, ...result });
    },
  );
}

export function registerCommandTool(server: McpServer): void {
  server.registerTool(
    "execute_command",
    {
      description: "Execute a local command inside an allowed working directory. Risky commands require Feishu approval.",
      inputSchema: {
        command: z.string().min(1).max(32_768),
        workdir: z.string().optional(),
        timeout: z.number().int().positive().optional(),
      },
    },
    async (args, ctx) => {
      const accessError = authorizeToolCall("execute_command", args);
      if (accessError) return accessError;
      return executeCommand(args, ctx);
    },
  );
}
