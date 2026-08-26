import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { COMMAND_MAX_OUTPUT_BYTES, COMMAND_TIMEOUT_MS } from "../config.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const javaDevelopmentInputSchema = z.object({
  action: z.enum(["maven_test", "maven_package", "maven_clean_test", "gradle_test", "gradle_build", "gradle_assemble_debug"]),
  workdir: z.string().min(1),
}).strict();

function invocation(action: z.infer<typeof javaDevelopmentInputSchema>["action"], workdir: string) {
  const gradle = action.startsWith("gradle_");
  const args = gradle
    ? [action === "gradle_test" ? "test" : action === "gradle_build" ? "build" : "assembleDebug"]
    : [action === "maven_test" ? "test" : action === "maven_package" ? "package" : "clean", ...(action === "maven_clean_test" ? ["test"] : [])];
  if (gradle) {
    const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    if (!fs.existsSync(path.join(workdir, wrapper))) throw new Error("Gradle wrapper not found.");
    return process.platform === "win32"
      ? { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `${wrapper} ${args.join(" ")}`] }
      : { executable: path.join(workdir, wrapper), args };
  }
  return process.platform === "win32"
    ? { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `mvn.cmd ${args.join(" ")}`] }
    : { executable: "mvn", args };
}

export async function javaDevelopment(args: z.infer<typeof javaDevelopmentInputSchema>, ctx: ServerContext) {
  const guard = await resolveGuardAndAuthorize("java_development", "workdir", args.workdir, "read", args, ctx, { scope: "directory", access: "command" });
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid working directory");
  let plan;
  try { plan = invocation(args.action, guard.resolvedPath); } catch (error) { return toolError("INVALID_ARGUMENT", (error as Error).message); }
  return runTool({ name: "java_development", concurrency: "command", subject: { kind: "path", key: guard.resolvedPath, display: guard.resolvedPath } }, async () => {
    const result = await runProcess(plan.executable, plan.args, { cwd: guard.resolvedPath, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES, env: process.env, signal: ctx.mcpReq.signal });
    if (result.exitCode !== 0) return toolError("INTERNAL_ERROR", result.stderr.trim() || `process exited ${result.exitCode}`);
    return toolJson({ ok: true, action: args.action, ...result });
  });
}

export function registerJavaDevelopmentTool(server: McpServer): void {
  server.registerTool("java_development", { description: "Run fixed Maven or Gradle validation actions in an authorized Java project.", inputSchema: javaDevelopmentInputSchema }, async (args, ctx) => authorizeOwnerToolCall("java_development", args) ?? javaDevelopment(args, ctx));
}
