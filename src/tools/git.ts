import path from "node:path";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GIT_TIMEOUT_MS, COMMAND_MAX_OUTPUT_BYTES } from "../config.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { containsInternalApprovalPath } from "../security/approvalStore.js";
import { validatePath } from "../security/pathGuard.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

interface GitBaseArgs { path?: string }
interface GitDiffArgs extends GitBaseArgs { staged?: boolean; file?: string }

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EXTERNAL_DIFF: "",
  GIT_OPTIONAL_LOCKS: "0",
};

async function gitRoot(tool: string, args: GitBaseArgs, ctx: ServerContext) {
  const raw = args.path ?? ".";
  return resolveGuardAndAuthorize(tool, "path", raw, "read", args, ctx);
}

async function runGit(cwd: string, args: string[], signal: AbortSignal) {
  return runProcess("git", args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    env: gitEnv,
    signal,
  });
}

export async function gitStatus(args: GitBaseArgs, ctx: ServerContext) {
  const guard = await gitRoot("git_status", args, ctx);
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid path");
  const cwd = guard.resolvedPath;
  if (containsInternalApprovalPath(cwd)) {
    return toolError("SENSITIVE_PATH", "The selected Git directory contains internal approval data.");
  }
  return runTool(
    { name: "git_status", concurrency: "default", subject: { kind: "path", key: cwd, display: cwd } },
    async () => {
      const result = await runGit(cwd, [
        "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
        "status", "--porcelain=v1", "-b", "--ignore-submodules=all",
      ], ctx.mcpReq.signal);
      if (result.exitCode !== 0) return toolError("GIT_FAILED", result.stderr.trim() || `git exited ${result.exitCode}`);
      const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
      const branch = (lines.shift() ?? "").replace(/^##\s*/, "").split("...")[0];
      const files = lines.map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));
      return toolJson({ ok: true, branch, files, dirty: files.length, durationMs: result.durationMs });
    },
  );
}

export async function gitDiff(args: GitDiffArgs, ctx: ServerContext) {
  const guard = await gitRoot("git_diff", args, ctx);
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid path");
  const cwd = guard.resolvedPath;
  if (containsInternalApprovalPath(cwd)) {
    return toolError("SENSITIVE_PATH", "The selected Git directory contains internal approval data.");
  }
  const command = ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"];
  if (args.staged) command.push("--cached");
  if (args.file) {
    const target = validatePath(path.resolve(cwd, args.file));
    if (!target.ok || !target.resolvedPath) return toolError("OUTSIDE_ALLOWED_DIRS", target.error ?? "Invalid file path");
    const relative = path.relative(cwd, target.resolvedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return toolError("OUTSIDE_ALLOWED_DIRS", "The diff file must be inside the selected repository.");
    }
    command.push("--", relative);
  }
  return runTool(
    { name: "git_diff", concurrency: "default", subject: { kind: "path", key: cwd, display: cwd } },
    async () => {
      const result = await runGit(cwd, command, ctx.mcpReq.signal);
      if (result.exitCode !== 0) return toolError("GIT_FAILED", result.stderr.trim() || `git exited ${result.exitCode}`);
      return toolJson({ ok: true, diff: result.stdout, stderr: result.stderr, truncated: result.truncated, durationMs: result.durationMs });
    },
  );
}

export function registerGitTools(server: McpServer): void {
  server.registerTool("git_status", {
    description: "Read Git branch and working-tree status without invoking a shell.",
    inputSchema: { path: z.string().optional() },
  }, async (args, ctx) => authorizeToolCall("git_status", args) ?? gitStatus(args, ctx));
  server.registerTool("git_diff", {
    description: "Read staged or unstaged Git differences without external diff helpers.",
    inputSchema: {
      path: z.string().optional(),
      staged: z.boolean().optional(),
      file: z.string().optional(),
    },
  }, async (args, ctx) => authorizeToolCall("git_diff", args) ?? gitDiff(args, ctx));
}
