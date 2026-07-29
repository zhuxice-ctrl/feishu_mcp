import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  SEARCH_MAX_FILES,
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
} from "../config.js";
import { isSensitiveFile } from "../security/fileGuard.js";
import { isInternalApprovalPath } from "../security/approvalStore.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { compileGlob, normalizeGlobPath } from "./globPattern.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface SearchContentArgs {
  pattern: string;
  path?: string;
  include?: string;
  maxResults?: number;
}

export async function searchContent(args: SearchContentArgs, ctx: ServerContext) {
  const rawRoot = args.path ?? ".";
  const guard = await resolveGuardAndAuthorize(
    "search_content", "path", rawRoot, "read", args, ctx,
    { scope: "directory", access: "search" },
  );
  if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid path");
  let expression: RegExp;
  try { expression = new RegExp(args.pattern); }
  catch (error) { return toolError("INVALID_PATTERN", `Invalid regular expression: ${(error as Error).message}`); }
  let include: ReturnType<typeof compileGlob>;
  try { include = compileGlob(args.include ?? "*"); }
  catch (error) { return toolError("INVALID_PATTERN", (error as Error).message); }
  const maxResults = Math.min(args.maxResults ?? 100, SEARCH_MAX_RESULTS);
  const root = guard.resolvedPath;
  return runTool(
    { name: "search_content", concurrency: "search", subject: { kind: "path", key: root, display: root } },
    async () => {
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      const stack = [root];
      const files: string[] = [];
      let skippedSensitive = 0;
      let timedOut = false;
      while (stack.length && files.length < SEARCH_MAX_FILES) {
        if (Date.now() > deadline) { timedOut = true; break; }
        const dir = stack.pop()!;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (isInternalApprovalPath(full)) continue;
          if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          const relative = normalizeGlobPath(path.relative(root, full));
          if (!include(relative, entry.name)) continue;
          if (isSensitiveFile(full)) { skippedSensitive += 1; continue; }
          files.push(full);
          if (files.length >= SEARCH_MAX_FILES) break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const matches: Array<{ file: string; line: number; content: string }> = [];
      for (const file of files) {
        if (Date.now() > deadline) { timedOut = true; break; }
        let stat;
        try { stat = await fs.stat(file); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let content;
        try { content = await fs.readFile(file, "utf8"); } catch { continue; }
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          expression.lastIndex = 0;
          if (expression.test(line)) matches.push({ file, line: index + 1, content: line });
          if (matches.length >= maxResults) break;
        }
        if (matches.length >= maxResults) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return toolJson({
        ok: true,
        results: matches,
        matchCount: matches.length,
        filesScanned: files.length,
        skippedSensitive,
        timedOut,
        truncated: matches.length >= maxResults || files.length >= SEARCH_MAX_FILES,
      });
    },
  );
}

export function registerContentSearchTool(server: McpServer): void {
  server.registerTool(
    "search_content",
    {
      description: "Search file contents with a regular expression inside allowed directories.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().optional(),
        include: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async (args, ctx) => {
      const accessError = authorizeToolCall("search_content", args);
      if (accessError) return accessError;
      return searchContent(args, ctx);
    },
  );
}
