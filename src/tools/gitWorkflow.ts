import path from "node:path";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GIT_TIMEOUT_MS, COMMAND_MAX_OUTPUT_BYTES } from "../config.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { isInsideDirectory, resolveThroughExistingAncestor } from "../security/directoryRoots.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const inputSchema = z.object({
  action: z.literal("worktree_add"),
  path: z.string().min(1),
  directory: z.string().min(1),
  ref: z.string().min(1).max(256).regex(/^[A-Za-z0-9._\/-]+$/),
}).strict();

export async function gitWorkflow(args: z.infer<typeof inputSchema>, ctx: ServerContext) {
  const guard = await resolveGuardAndAuthorize("git_workflow", "path", args.path, "read", args, ctx, { scope: "directory", access: "git" });
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid repository path");
  const root = guard.resolvedPath;
  const target = path.resolve(root, args.directory);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return toolError("OUTSIDE_ALLOWED_DIRS", "Worktree directory must be inside the repository.");
  try { if (resolveThroughExistingAncestor(target) !== target) return toolError("INVALID_ARGUMENT", "Worktree directory already exists."); } catch { /* target may be new */ }
  return runTool({ name: "git_workflow", concurrency: "command", subject: { kind: "path", key: root, display: root } }, async () => {
    const result = await runProcess("git", ["-c", "core.fsmonitor=false", "-c", "credential.interactive=false", "worktree", "add", "--", relative, args.ref], { cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES, env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" }, signal: ctx.mcpReq.signal });
    if (result.exitCode !== 0) return toolError("GIT_FAILED", result.stderr.trim() || `git exited ${result.exitCode}`);
    return toolJson({ ok: true, action: args.action, directory: relative, ref: args.ref, stdout: result.stdout, durationMs: result.durationMs });
  });
}

export function registerGitWorkflowTool(server: McpServer): void {
  server.registerTool("git_workflow", { description: "Run the fixed Git worktree_add operation inside an authorized repository.", inputSchema }, async (args, ctx) => authorizeToolCall("git_workflow", args) ?? gitWorkflow(args, ctx));
}
