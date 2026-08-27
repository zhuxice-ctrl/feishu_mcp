import path from "node:path";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GIT_TIMEOUT_MS, COMMAND_MAX_OUTPUT_BYTES } from "../config.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const base = { path: z.string().min(1) };
export const gitWorkflowInputSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("status") }).strict(), z.object({ ...base, action: z.literal("diff") }).strict(), z.object({ ...base, action: z.literal("branch_list") }).strict(),
  z.object({ ...base, action: z.literal("add_files"), files: z.array(z.string().min(1).max(512)).max(64) }).strict(),
  z.object({ ...base, action: z.literal("commit"), message: z.string().min(1).max(4096) }).strict(),
  z.object({ ...base, action: z.literal("push"), remote: z.string().regex(/^[A-Za-z0-9._-]+$/), branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/) }).strict(),
  z.object({ ...base, action: z.literal("fetch"), remote: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict(), z.object({ ...base, action: z.literal("pull"), remote: z.string().regex(/^[A-Za-z0-9._-]+$/), branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/) }).strict(), z.object({ ...base, action: z.literal("checkout_branch"), branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/) }).strict(), z.object({ ...base, action: z.literal("worktree_add"), directory: z.string().min(1), ref: z.string().regex(/^[A-Za-z0-9._\/-]+$/) }).strict(),
]);

export async function gitWorkflow(args: z.infer<typeof gitWorkflowInputSchema>, ctx: ServerContext) {
  const guard = await resolveGuardAndAuthorize("git_workflow", "path", args.path, "read", args, ctx, { scope: "directory", access: "git" });
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid repository path");
  const cwd = guard.resolvedPath; let command: string[];
  switch (args.action) {
    case "status": command=["status","--short","--branch"]; break; case "diff": command=["diff","--no-ext-diff","--no-textconv"]; break; case "branch_list": command=["branch","--list"]; break;
    case "add_files": command=["add","--",...args.files.map(f=>{const rel=path.relative(cwd,path.resolve(cwd,f));if(!rel||rel.startsWith("..")||path.isAbsolute(rel))throw new Error("file must be inside repository");return rel;})]; break;
    case "commit": command=["commit","-m",args.message]; break; case "push": command=["push",args.remote,args.branch]; break; case "fetch": command=["fetch",args.remote]; break; case "pull": command=["pull",args.remote,args.branch]; break; case "checkout_branch": command=["checkout",args.branch]; break;
    case "worktree_add": { const rel=path.relative(cwd,path.resolve(cwd,args.directory)); if(!rel||rel.startsWith("..")||path.isAbsolute(rel))return toolError("OUTSIDE_ALLOWED_DIRS","worktree directory must be inside repository"); command=["worktree","add","--",rel,args.ref]; break; }
  }
  return runTool({name:"git_workflow",concurrency:"command",subject:{kind:"path",key:cwd,display:cwd}},async()=>{const result=await runProcess("git",["-c","core.fsmonitor=false","-c","credential.interactive=false",...command],{cwd,timeoutMs:GIT_TIMEOUT_MS,maxOutputBytes:COMMAND_MAX_OUTPUT_BYTES,env:{...process.env,GIT_PAGER:"cat",PAGER:"cat"},signal:ctx.mcpReq.signal});if(result.exitCode!==0)return toolError("GIT_FAILED",result.stderr.trim()||`git exited ${result.exitCode}`);return toolJson({ok:true,action:args.action,stdout:result.stdout,stderr:result.stderr,durationMs:result.durationMs});});
}
export function registerGitWorkflowTool(server:McpServer):void{server.registerTool("git_workflow",{description:"Run fixed Git workflow actions including worktree_add in an authorized repository.",inputSchema:gitWorkflowInputSchema},async(args,ctx)=>authorizeToolCall("git_workflow",args)??gitWorkflow(args,ctx));}
