import fs from "node:fs/promises";
import { createTwoFilesPatch, diffLines } from "diff";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { MAX_READ_BYTES } from "../config.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

interface CompareArgs { path_a: string; path_b: string }

export async function compareFiles(args: CompareArgs, ctx: ServerContext) {
  const first = await resolveGuardAndAuthorize("compare_files", "path_a", args.path_a, "read", args, ctx);
  if (!first.ok) return first.result ?? toolError("OUTSIDE_ALLOWED_DIRS", first.error ?? "Invalid first path");
  const second = await resolveGuardAndAuthorize("compare_files", "path_b", args.path_b, "read", args, ctx);
  if (!second.ok) return second.result ?? toolError("OUTSIDE_ALLOWED_DIRS", second.error ?? "Invalid second path");
  return runTool(
    {
      name: "compare_files",
      concurrency: "default",
      subject: { kind: "paths", key: `${first.resolvedPath}\u0000${second.resolvedPath}`, display: "two files" },
    },
    async () => {
      const [firstStat, secondStat] = await Promise.all([fs.stat(first.resolvedPath), fs.stat(second.resolvedPath)]);
      if (!firstStat.isFile() || !secondStat.isFile()) return toolError("INVALID_ARGUMENT", "Both paths must be files.");
      if (firstStat.size > MAX_READ_BYTES || secondStat.size > MAX_READ_BYTES) {
        return toolError("RESPONSE_TOO_LARGE", `Each file must be at most ${MAX_READ_BYTES} bytes.`);
      }
      const [a, b] = await Promise.all([fs.readFile(first.resolvedPath, "utf8"), fs.readFile(second.resolvedPath, "utf8")]);
      const changes = diffLines(a, b);
      const identical = changes.length === 1 && !changes[0].added && !changes[0].removed;
      const patch = identical ? "" : createTwoFilesPatch(first.resolvedPath, second.resolvedPath, a, b, "", "");
      return toolJson({ ok: true, identical, diff: patch, exitCode: identical ? 0 : 1 });
    },
  );
}

export function registerDiffTool(server: McpServer): void {
  server.registerTool("compare_files", {
    description: "Compare two allowed text files and return a unified diff.",
    inputSchema: { path_a: z.string(), path_b: z.string() },
  }, async (args, ctx) => authorizeToolCall("compare_files", args) ?? compareFiles(args, ctx));
}
