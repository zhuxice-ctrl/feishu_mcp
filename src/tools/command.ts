import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  GIT_COMMAND_POLICY,
  OWNER_COMMAND_POLICY,
  OWNER_USER_ID,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { logger } from "../security/logger.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import {
  containsInternalApprovalPath,
  isInternalApprovalPath,
} from "../security/approvalStore.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import {
  consumeGitConfirmation,
  createGitConfirmation,
} from "../security/gitSoftApproval.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { classifyCommand } from "./commandPolicy.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";

export interface ExecuteCommandArgs {
  command: string;
  workdir?: string;
  timeout?: number;
  confirmationToken?: string;
}

function commandSubject(command: string, workdir: string): string {
  return createHash("sha256").update(`${workdir}\u0000${command}`).digest("hex");
}

export async function executeCommand(
  args: ExecuteCommandArgs,
  ctx: ServerContext,
) {
  const risk = classifyCommand(args.command);
  const requestedWorkdir = args.workdir ??
    directoryGrantStore.effectiveRoots(getRequestUserId())[0]?.logicalRoot;
  if (!requestedWorkdir) return toolError("OUTSIDE_ALLOWED_DIRS", "No allowed working directory is configured.");
  const workdirGuard = await resolvePathsGuardAndAuthorize(
    "execute_command",
    [{ argName: "workdir", inputPath: requestedWorkdir, operation: "read", scope: "directory", access: "command" }],
    args,
    ctx,
  );
  if (!workdirGuard.ok) {
    return workdirGuard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", workdirGuard.error ?? "Invalid working directory.");
  }
  const workdir = workdirGuard.paths[0].resolvedPath;
  if (isInternalApprovalPath(workdir) || containsInternalApprovalPath(workdir)) {
    return toolError("OUTSIDE_ALLOWED_DIRS", "The internal approval directory cannot be used as a working directory.");
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    return toolError("INVALID_ARGUMENT", "The working directory does not exist or is not a directory.");
  }
  const timeoutMs = Math.min(args.timeout ?? COMMAND_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS);
  const userId = getRequestUserId();
  const { confirmationToken: _confirmationToken, ...approvalArgs } = args;
  const softGit = GIT_COMMAND_POLICY === "soft_owner" &&
    userId === OWNER_USER_ID && risk.gitCategory !== undefined;
  const ownerDirect = OWNER_COMMAND_POLICY === "direct" &&
    OWNER_USER_ID.length > 0 && userId === OWNER_USER_ID;
  if (softGit && risk.gitCategory === "confirmation_required") {
    const confirmationRequest = {
      userId: OWNER_USER_ID,
      command: risk.normalized,
      workdir,
      timeoutMs,
    };
    if (!args.confirmationToken) return createGitConfirmation(ctx, confirmationRequest);
    if (!(await consumeGitConfirmation(ctx, args.confirmationToken, confirmationRequest))) {
      logger.info("git_soft_confirmation", {
        outcome: "confirmation_rejected",
        digest: commandSubject(risk.normalized, workdir),
      });
      return toolError(
        "APPROVAL_DENIED",
        "Git confirmation token is invalid, expired, changed, or already used.",
      );
    }
  } else if (softGit) {
    logger.info("git_soft_confirmation", {
      outcome: "authorized",
      digest: commandSubject(risk.normalized, workdir),
    });
  } else if (!softGit && risk.level === "approval_required" && !ownerDirect) {
    const approval = await requestApproval(ctx, {
      tool: "execute_command",
      userId,
      subject: {
        kind: "command",
        key: commandSubject(risk.normalized, workdir),
        display: `${risk.normalized}\nWorking directory: ${workdir}`,
      },
      argsDigest: digestArguments(approvalArgs),
      reasons: risk.reasons,
      authorizedDirectoryRootsDigest: workdirGuard.directoryProof?.rootsDigest,
    });
    if (approval !== true) return approval;
  }
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
      description: "Execute a local command inside an allowed working directory. Risky commands require Feishu approval. " +
        "When OWNER_COMMAND_POLICY=direct, the configured owner may run build verification commands " +
        "(npm install, npm run build, npx tsc --noEmit, and tests) without a second approval; " +
        "directory confinement, timeouts, output limits, cancellation, and Git confirmation remain active.",
      inputSchema: {
        command: z.string().min(1).max(32_768),
        workdir: z.string().optional(),
        timeout: z.number().int().positive().optional(),
        confirmationToken: z.string().min(1).max(16_384).optional(),
      },
    },
    async (args, ctx) => {
      const accessError = authorizeToolCall("execute_command", args);
      if (accessError) return accessError;
      return executeCommand(args, ctx);
    },
  );
}
