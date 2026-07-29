import fs from "node:fs/promises";
import { createTwoFilesPatch, diffLines } from "diff";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { MAX_READ_BYTES } from "../config.js";
import {
  authorizeFilePath,
  authorizeToolCall,
  fileApprovalSubjectKey,
} from "../security/toolAccess.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

interface CompareArgs { path_a: string; path_b: string }

export async function compareFiles(args: CompareArgs, ctx: ServerContext) {
  const guarded = await resolvePathsGuardAndAuthorize(
    "compare_files",
    [
      { argName: "path_a", inputPath: args.path_a, operation: "read", scope: "file", access: "read" },
      { argName: "path_b", inputPath: args.path_b, operation: "read", scope: "file", access: "read" },
    ],
    args,
    ctx,
  );
  if (!guarded.ok) return guarded.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guarded.error ?? "Invalid paths");
  const priorSubjectKeys: string[] = [];
  for (const item of guarded.paths) {
    const directoryAuthorized = item.boundarySource !== "static";
    const approval = await authorizeFilePath(
      "compare_files", item.argName, item.inputPath, item.resolvedPath, args, ctx,
      {
        directoryAuthorized,
        authorizedDirectoryRootsDigest: guarded.directoryProof?.rootsDigest,
        priorSubjectKeys,
      },
    );
    if (approval !== true) return approval;
    const key = fileApprovalSubjectKey(
      "compare_files", item.inputPath, item.resolvedPath, directoryAuthorized,
    );
    if (key) priorSubjectKeys.push(key);
  }
  const first = guarded.paths.find((item) => item.argName === "path_a")!;
  const second = guarded.paths.find((item) => item.argName === "path_b")!;
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
