import path from "node:path";
import { z } from "zod";

const branch = z.string().regex(/^[A-Za-z0-9._\/-]+$/).refine((v) => !v.startsWith("-"));
export const gitWorkflowSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), workspaceId: z.string(), contextId: z.string(), workdir: z.string() }).strict(),
  z.object({ action: z.literal("diff"), workspaceId: z.string(), contextId: z.string(), workdir: z.string() }).strict(),
  z.object({ action: z.literal("branch_list"), workspaceId: z.string(), contextId: z.string(), workdir: z.string() }).strict(),
  z.object({ action: z.literal("add_files"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), files: z.array(z.string().min(1)).max(64) }).strict(),
  z.object({ action: z.literal("commit"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), message: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("push"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), remote: branch, branch }).strict(),
  z.object({ action: z.literal("fetch"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), remote: branch }).strict(),
  z.object({ action: z.literal("pull"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), remote: branch, branch }).strict(),
  z.object({ action: z.literal("checkout_branch"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), branch }).strict(),
  z.object({ action: z.literal("worktree_add"), workspaceId: z.string(), contextId: z.string(), workdir: z.string(), directory: z.string(), ref: branch }).strict(),
]);
export type GitWorkflowInput = z.infer<typeof gitWorkflowSchema>;
export const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "credential.interactive=false"] as const;
function relative(root: string, value: string): string {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.startsWith("-")) throw new Error("path must be project-relative");
  const resolved = path.resolve(root, value); const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path must be inside repository");
  return rel;
}
export function parseGitWorkflow(value: unknown): GitWorkflowInput { return gitWorkflowSchema.parse(value); }
export function buildGitPlan(input: GitWorkflowInput, root: string): { executable: string; args: string[] } {
  let args: string[];
  switch (input.action) {
    case "status": args = ["status", "--short", "--branch"]; break;
    case "diff": args = ["diff", "--no-ext-diff", "--no-textconv"]; break;
    case "branch_list": args = ["branch", "--list"]; break;
    case "add_files": args = ["add", "--", ...input.files.map((f) => relative(root, f))]; break;
    case "commit": args = ["commit", "-F", "<message-file>"]; break;
    case "push": args = ["push", input.remote, input.branch]; break;
    case "fetch": args = ["fetch", input.remote]; break;
    case "pull": args = ["pull", input.remote, input.branch]; break;
    case "checkout_branch": args = ["checkout", input.branch]; break;
    case "worktree_add": args = ["worktree", "add", relative(root, input.directory), input.ref]; break;
  }
  return { executable: "git", args: [...GIT_PREFIX, ...args] };
}
export function buildGitCommitMessage(message: string, messagePath = "commit-message.txt") { return { message, messagePath }; }
