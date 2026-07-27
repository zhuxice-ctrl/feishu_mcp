/**
 * Filesystem tools — 9 tools ported from the official MCP filesystem server.
 *
 * Each tool follows the same flow:
 *   1. resolveGuardAndAuthorize() — whitelist, file type, then consent
 *   2. existence / type check
 *   3. actual work
 *   4. audit log (handled by withToolHandler)
 *
 * The boilerplate lives in ./helpers and ./atomicWrite so the bodies here
 * focus on what each tool actually does.  All tool handlers are async and
 * read the request token from AsyncLocalStorage (see security/requestContext).
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getRequestToken } from "../security/requestContext.js";
import { logOperation } from "../security/logger.js";
import { getAllowedDirectories } from "../security/pathGuard.js";
import { moveToTrash } from "../security/trash.js";
import { atomicWriteFile } from "./atomicWrite.js";
import {
  checkReadSize,
  checkWriteSize,
  authorizeToolCall,
  errorResult,
  formatBytes,
  isLikelyTextFile,
  resolveGuardAndAuthorize,
  textContent,
  withToolHandler,
} from "./helpers.js";

/**
 * Register all 9 filesystem tools + ping (ping stays in index.ts) on `server`.
 */
export function registerFilesystemTools(server: McpServer): void {
  registerReadFile(server);
  registerWriteFile(server);
  registerEditFile(server);
  registerCreateDirectory(server);
  registerListDirectory(server);
  registerMoveFile(server);
  registerSearchFiles(server);
  registerGetFileInfo(server);
  registerListAllowedDirectories(server);
}

// ---------------------------------------------------------------------------
// 1. read_file
// ---------------------------------------------------------------------------

function registerReadFile(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      description:
        "Read the contents of a file. Returns text content for text files " +
        "and base64 for binary files. Files larger than 10MB are rejected.",
      inputSchema: {
        path: z.string().describe("Absolute or relative path to the file to read"),
        encoding: z
          .string()
          .optional()
          .describe("Output encoding: 'text' (default) or 'base64'. For binary files, base64 is auto-selected."),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("read_file", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "read_file",
        "path",
        args.path,
        "read"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      const token = getRequestToken();

      if (!fs.existsSync(resolved)) {
        return errorResult(`File not found: ${args.path}`);
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return errorResult(`Path is a directory, not a file: ${args.path}`);
      }
      const sizeError = checkReadSize(stat.size);
      if (sizeError) {
        logOperation("read_file", resolved, token, "denied", sizeError);
        return errorResult(sizeError);
      }

      return withToolHandler("read_file", resolved, async () => {
        const buffer = fs.readFileSync(resolved);
        const sample = buffer.subarray(0, Math.min(8192, buffer.length));
        const useBase64 =
          args.encoding === "base64" ||
          (!isLikelyTextFile(resolved) && sample.includes(0));

        if (useBase64) {
          return {
            content: [
              textContent(
                JSON.stringify({
                  path: resolved,
                  size: stat.size,
                  encoding: "base64",
                  data: buffer.toString("base64"),
                })
              ),
            ],
          };
        }

        return { content: [textContent(buffer.toString("utf-8"))] };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 2. write_file
// ---------------------------------------------------------------------------

function registerWriteFile(server: McpServer): void {
  server.registerTool(
    "write_file",
    {
      description:
        "Write content to a file. Creates the file if it doesn't exist, " +
        "overwrites if it does (original moved to .trash). Max write size 5MB.",
      inputSchema: {
        path: z.string().describe("Path to the file to write"),
        content: z.string().describe("Content to write to the file"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("write_file", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "write_file",
        "path",
        args.path,
        "write"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      const token = getRequestToken();

      const contentBytes = Buffer.byteLength(args.content, "utf-8");
      const sizeError = checkWriteSize(contentBytes);
      if (sizeError) {
        logOperation("write_file", resolved, token, "denied", sizeError);
        return errorResult(sizeError);
      }

      return withToolHandler("write_file", resolved, async () => {
        const { bytes } = atomicWriteFile(resolved, args.content, {
          trashOriginal: true,
        });
        return {
          content: [
            textContent(`Successfully wrote ${bytes} bytes to ${resolved}`),
          ],
        };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 3. edit_file
// ---------------------------------------------------------------------------

function registerEditFile(server: McpServer): void {
  server.registerTool(
    "edit_file",
    {
      description:
        "Perform precise text replacements in a file. Finds exact matches of " +
        "oldText and replaces them with newText. Use dryRun=true to preview " +
        "changes without applying them.",
      inputSchema: {
        path: z.string().describe("Path to the file to edit"),
        oldText: z.string().describe("Exact text to find (must be unique in the file)"),
        newText: z.string().describe("Text to replace the match with"),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, preview the diff without writing changes"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("edit_file", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "edit_file",
        "path",
        args.path,
        "write"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;

      if (!fs.existsSync(resolved)) {
        return errorResult(`File not found: ${args.path}`);
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return errorResult(`Path is a directory: ${args.path}`);
      }

      const original = fs.readFileSync(resolved, "utf-8");
      const matchCount = original.split(args.oldText).length - 1;
      if (matchCount === 0) {
        return errorResult(`No matches found for the given oldText in ${resolved}`);
      }
      if (matchCount > 1) {
        return errorResult(
          `Found ${matchCount} matches for oldText — must be unique. ` +
          `Provide a longer/more specific oldText.`
        );
      }

      if (args.dryRun) {
        return {
          content: [
            textContent(
              `Dry run — would replace 1 match in ${resolved}.\n\n` +
              `--- old (lines around match) ---\n${args.oldText}\n` +
              `--- new ---\n${args.newText}`
            ),
          ],
        };
      }

      const updated = original.replace(args.oldText, args.newText);
      return withToolHandler("edit_file", resolved, async () => {
        atomicWriteFile(resolved, updated, { trashOriginal: true });
        return {
          content: [textContent(`Successfully edited ${resolved} (1 replacement applied)`)],
        };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 4. create_directory
// ---------------------------------------------------------------------------

function registerCreateDirectory(server: McpServer): void {
  server.registerTool(
    "create_directory",
    {
      description:
        "Create a directory, including all parent directories. " +
        "No-op if the directory already exists.",
      inputSchema: {
        path: z.string().describe("Path to the directory to create"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("create_directory", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "create_directory",
        "path",
        args.path,
        "write"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      return withToolHandler("create_directory", resolved, async () => {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          return { content: [textContent(`Directory already exists: ${resolved}`)] };
        }
        fs.mkdirSync(resolved, { recursive: true });
        return { content: [textContent(`Successfully created directory: ${resolved}`)] };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 5. list_directory
// ---------------------------------------------------------------------------

function registerListDirectory(server: McpServer): void {
  server.registerTool(
    "list_directory",
    {
      description:
        "List the contents of a directory. Returns file and directory names " +
        "with type indicators ([FILE] / [DIR]).",
      inputSchema: {
        path: z.string().describe("Path to the directory to list"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("list_directory", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "list_directory",
        "path",
        args.path,
        "read"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      if (!fs.existsSync(resolved)) {
        return errorResult(`Directory not found: ${args.path}`);
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return errorResult(`Path is a file, not a directory: ${args.path}`);
      }

      return withToolHandler("list_directory", resolved, async () => {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return { content: [textContent(formatted || "(empty directory)")] };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 6. move_file — soft-delete aware
// ---------------------------------------------------------------------------

function registerMoveFile(server: McpServer): void {
  server.registerTool(
    "move_file",
    {
      description:
        "Move or rename a file or directory. If the destination exists, it " +
        "is moved to .trash first. Both source and destination must be " +
        "inside allowed directories.",
      inputSchema: {
        source: z.string().describe("Path to the file/directory to move"),
        destination: z.string().describe("Target path"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("move_file", args);
      if (accessError) return accessError;
      const srcGuard = await resolveGuardAndAuthorize(
        "move_file",
        "source",
        args.source,
        "write"
      );
      if (!srcGuard.ok) return errorResult(`Source: ${srcGuard.error}`);
      const dstGuard = await resolveGuardAndAuthorize(
        "move_file",
        "destination",
        args.destination,
        "write"
      );
      if (!dstGuard.ok) return errorResult(`Destination: ${dstGuard.error}`);

      const src = srcGuard.resolvedPath;
      const dst = dstGuard.resolvedPath;
      const token = getRequestToken();

      if (!fs.existsSync(src)) {
        return errorResult(`Source not found: ${args.source}`);
      }

      // If destination exists, soft-delete it first
      let trashedDestination: string | null = null;
      if (fs.existsSync(dst)) {
        trashedDestination = moveToTrash(dst);
        if (!trashedDestination) {
          logOperation("move_file", src, token, "error", "trash failed", dst);
          return errorResult(`Failed to trash existing destination: ${dst}`);
        }
      }

      // Track which path succeeded so the audit log can record the detail.
      let movedViaCopy = false;

      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try {
          fs.renameSync(src, dst);
        } catch {
          // Cross-device rename fallback (copy + remove)
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
          movedViaCopy = true;
        }
      } catch (error) {
        try {
          fs.rmSync(dst, { recursive: true, force: true });
        } catch {
          // Continue to destination restoration and preserve the primary error.
        }
        let restoreError: unknown;
        if (trashedDestination) {
          try {
            fs.renameSync(trashedDestination, dst);
          } catch (caught) {
            restoreError = caught;
          }
        }
        const primaryMessage = error instanceof Error ? error.message : String(error);
        const detail = restoreError
          ? `${primaryMessage}; destination restore failed: ${
              restoreError instanceof Error ? restoreError.message : String(restoreError)
            }`
          : `${primaryMessage}${trashedDestination ? "; destination restored" : ""}`;
        logOperation("move_file", src, token, "error", detail, dst);
        return errorResult(`Failed to move: ${detail}`);
      }

      logOperation(
        "move_file",
        src,
        token,
        "success",
        movedViaCopy ? "cross-device copy" : undefined,
        dst
      );
      return {
        content: [
          textContent(
            movedViaCopy
              ? `Successfully moved (cross-device) ${src} → ${dst}`
              : `Successfully moved ${src} → ${dst}`
          ),
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// 7. search_files
// ---------------------------------------------------------------------------

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_DEPTH = 15;

/**
 * Pre-compile a glob pattern to a RegExp once per request, then test names
 * against it.  Patterns: `*` → any chars, `?` → single char, everything else
 * escaped.
 */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function registerSearchFiles(server: McpServer): void {
  server.registerTool(
    "search_files",
    {
      description:
        "Recursively search for files and directories matching a pattern. " +
        "The pattern supports glob-style matching (*.ts, test*, etc.). " +
        "Searches within the allowed directories only.",
      inputSchema: {
        path: z.string().describe("Root directory to start the search from"),
        pattern: z.string().describe("Glob pattern to match (e.g. '*.ts', 'test*')"),
        excludePatterns: z
          .array(z.string())
          .optional()
          .describe("Patterns to exclude from results (e.g. ['node_modules', '.git'])"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("search_files", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "search_files",
        "path",
        args.path,
        "read"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      if (!fs.existsSync(resolved)) {
        return errorResult(`Path not found: ${args.path}`);
      }

      const token = getRequestToken();
      const excludes = args.excludePatterns || [];
      const excludeRegexes = excludes.map(compileGlob);
      const matchRegex = compileGlob(args.pattern);

      const results: string[] = [];

      const walk = (dir: string, depth: number): void => {
        if (results.length >= MAX_SEARCH_RESULTS || depth > MAX_SEARCH_DEPTH) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(resolved, fullPath);
          const isExcluded =
            excludeRegexes.some((re) => re.test(entry.name)) ||
            excludes.some((ex) => relativePath.includes(ex));
          if (isExcluded) continue;
          if (matchRegex.test(entry.name)) results.push(fullPath);
          if (entry.isDirectory()) walk(fullPath, depth + 1);
        }
      };

      try {
        walk(resolved, 0);
        logOperation(
          "search_files",
          resolved,
          token,
          "success",
          `pattern=${args.pattern}, found=${results.length}`
        );
        const output =
          results.length === 0 ? "No matching files found." : results.join("\n");
        return { content: [textContent(output)] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("search_files", resolved, token, "error", msg);
        return errorResult(`Search failed: ${msg}`);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// 8. get_file_info
// ---------------------------------------------------------------------------

function registerGetFileInfo(server: McpServer): void {
  server.registerTool(
    "get_file_info",
    {
      description:
        "Get detailed metadata about a file or directory: size, timestamps, " +
        "permissions, and type.",
      inputSchema: {
        path: z.string().describe("Path to the file or directory"),
      },
    },
    async (args) => {
      const accessError = authorizeToolCall("get_file_info", args);
      if (accessError) return accessError;
      const guard = await resolveGuardAndAuthorize(
        "get_file_info",
        "path",
        args.path,
        "read"
      );
      if (!guard.ok) return errorResult(guard.error);

      const { resolvedPath: resolved } = guard;
      if (!fs.existsSync(resolved)) {
        return errorResult(`Path not found: ${args.path}`);
      }

      return withToolHandler("get_file_info", resolved, async () => {
        const stat = fs.statSync(resolved);
        const info = {
          path: resolved,
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
          permissions: stat.mode.toString(8).slice(-3),
          isSymbolicLink: stat.isSymbolicLink(),
        };
        return { content: [textContent(JSON.stringify(info, null, 2))] };
      });
    }
  );
}

// ---------------------------------------------------------------------------
// 9. list_allowed_directories
// ---------------------------------------------------------------------------

function registerListAllowedDirectories(server: McpServer): void {
  server.registerTool(
    "list_allowed_directories",
    {
      description:
        "List the directories this MCP server is allowed to access. " +
        "All file operations are restricted to these roots.",
      inputSchema: {},
    },
    async (args) => {
      const accessError = authorizeToolCall("list_allowed_directories", args);
      if (accessError) return accessError;
      const dirs = getAllowedDirectories();
      if (dirs.length === 0) {
        return {
          content: [
            textContent(
              "No allowed directories configured. Set ALLOWED_DIRS to enable file operations."
            ),
          ],
        };
      }
      return { content: [textContent(dirs.join("\n"))] };
    }
  );
}
