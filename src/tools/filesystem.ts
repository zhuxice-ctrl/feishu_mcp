/**
 * Filesystem tools — all 9 tools ported from the official MCP filesystem server.
 *
 * Each tool validates paths, checks file-type guards, enforces size limits,
 * and logs write operations. Security is built in from the start (Phase 2+3
 * merged per the development plan).
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { validatePath, getAllowedDirectories } from "../security/pathGuard.js";
import { checkFileAccess } from "../security/fileGuard.js";
import { logOperation } from "../security/logger.js";
import { moveToTrash } from "../security/trash.js";
import { MAX_READ_BYTES, MAX_WRITE_BYTES } from "../config.js";

// ---------------------------------------------------------------------------
// Helper: extract token from the MCP request context (best-effort)
// ---------------------------------------------------------------------------

function getTokenFromContext(extra: unknown): string {
  if (extra && typeof extra === "object" && "_meta" in extra) {
    const meta = (extra as Record<string, unknown>)._meta;
    if (meta && typeof meta === "object" && "authToken" in meta) {
      return String((meta as Record<string, unknown>).authToken || "");
    }
  }
  // Fallback: the auth middleware already validated the token;
  // for logging we use an empty string if we can't extract it.
  return "";
}

// ---------------------------------------------------------------------------
// Helper: build a text content block
// ---------------------------------------------------------------------------

function textContent(text: string) {
  return { type: "text" as const, text };
}

function errorResult(message: string) {
  return {
    content: [textContent(`Error: ${message}`)],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Helper: detect if a file is text or binary
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".py", ".rb",
  ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".css", ".html",
  ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".csv", ".tsv", ".log",
  ".svg", ".graphql", ".gql", ".proto", ".dart", ".kt", ".swift",
  ".scala", ".clj", ".ex", ".exs", ".erl", ".lua", ".vim", ".r",
  ".pl", ".pm", ".tcl", ".asm", ".s", ".v", ".vh", ".sv",
]);

function isLikelyTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (ext === "") {
    // No extension — check content for null bytes
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Register all filesystem tools
// ---------------------------------------------------------------------------

export function registerFilesystemTools(
  server: McpServer,
  getToken: () => string
): void {
  const token = getToken;

  // ========================================================================
  // 1. read_file
  // ========================================================================
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
    async (args, ctx) => {
      const filePath = args.path;
      const pathResult = validatePath(filePath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      // File-type / sensitive-file guard
      const guardError = checkFileAccess(resolved, "read");
      if (guardError) {
        logOperation("read_file", resolved, token(), "denied", guardError);
        return errorResult(guardError);
      }

      // Check existence
      if (!fs.existsSync(resolved)) {
        return errorResult(`File not found: ${filePath}`);
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return errorResult(`Path is a directory, not a file: ${filePath}`);
      }

      // Size limit
      if (stat.size > MAX_READ_BYTES) {
        const msg = `File too large (${stat.size} bytes, max ${MAX_READ_BYTES})`;
        logOperation("read_file", resolved, token(), "denied", msg);
        return errorResult(msg);
      }

      try {
        const buffer = fs.readFileSync(resolved);
        const checkBuffer = buffer.subarray(0, Math.min(8192, buffer.length));
        const useBase64 =
          args.encoding === "base64" ||
          (!isLikelyTextFile(resolved) && checkBuffer.includes(0));

        if (useBase64) {
          const base64Data = buffer.toString("base64");
          logOperation("read_file", resolved, token(), "success", `binary ${buffer.length}B`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  path: resolved,
                  size: stat.size,
                  encoding: "base64",
                  data: base64Data,
                }),
              },
            ],
          };
        }

        const text = buffer.toString("utf-8");
        logOperation("read_file", resolved, token(), "success", `text ${buffer.length}B`);
        return { content: [textContent(text)] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("read_file", resolved, token(), "error", msg);
        return errorResult(`Failed to read file: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 2. write_file
  // ========================================================================
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
    async (args, ctx) => {
      const filePath = args.path;
      const pathResult = validatePath(filePath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      // File-type / sensitive-file guard
      const guardError = checkFileAccess(resolved, "write");
      if (guardError) {
        logOperation("write_file", resolved, token(), "denied", guardError);
        return errorResult(guardError);
      }

      // Size limit
      const contentBytes = Buffer.byteLength(args.content, "utf-8");
      if (contentBytes > MAX_WRITE_BYTES) {
        const msg = `Content too large (${contentBytes} bytes, max ${MAX_WRITE_BYTES})`;
        logOperation("write_file", resolved, token(), "denied", msg);
        return errorResult(msg);
      }

      try {
        // If file exists, move to trash before overwriting
        if (fs.existsSync(resolved)) {
          moveToTrash(resolved);
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(resolved);
        fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(resolved, args.content, "utf-8");
        logOperation("write_file", resolved, token(), "success", `${contentBytes}B`);
        return {
          content: [textContent(`Successfully wrote ${contentBytes} bytes to ${resolved}`)],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("write_file", resolved, token(), "error", msg);
        return errorResult(`Failed to write file: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 3. edit_file
  // ========================================================================
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
    async (args, ctx) => {
      const filePath = args.path;
      const pathResult = validatePath(filePath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      const guardError = checkFileAccess(resolved, "write");
      if (guardError) {
        logOperation("edit_file", resolved, token(), "denied", guardError);
        return errorResult(guardError);
      }

      if (!fs.existsSync(resolved)) {
        return errorResult(`File not found: ${filePath}`);
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return errorResult(`Path is a directory: ${filePath}`);
      }

      try {
        const original = fs.readFileSync(resolved, "utf-8");

        // Count matches
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

        const updated = original.replace(args.oldText, args.newText);

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

        // Move original to trash, then write updated
        moveToTrash(resolved);
        fs.writeFileSync(resolved, updated, "utf-8");
        logOperation("edit_file", resolved, token(), "success");
        return {
          content: [textContent(`Successfully edited ${resolved} (1 replacement applied)`)],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("edit_file", resolved, token(), "error", msg);
        return errorResult(`Failed to edit file: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 4. create_directory
  // ========================================================================
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
    async (args, ctx) => {
      const dirPath = args.path;
      const pathResult = validatePath(dirPath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          return {
            content: [textContent(`Directory already exists: ${resolved}`)],
          };
        }
        fs.mkdirSync(resolved, { recursive: true });
        logOperation("create_directory", resolved, token(), "success");
        return {
          content: [textContent(`Successfully created directory: ${resolved}`)],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("create_directory", resolved, token(), "error", msg);
        return errorResult(`Failed to create directory: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 5. list_directory
  // ========================================================================
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
    async (args, ctx) => {
      const dirPath = args.path;
      const pathResult = validatePath(dirPath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      if (!fs.existsSync(resolved)) {
        return errorResult(`Directory not found: ${dirPath}`);
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return errorResult(`Path is a file, not a directory: ${dirPath}`);
      }

      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const formatted = entries
          .map((entry) => {
            const type = entry.isDirectory() ? "[DIR]" : "[FILE]";
            return `${type} ${entry.name}`;
          })
          .join("\n");
        logOperation("list_directory", resolved, token(), "success");
        return {
          content: [textContent(formatted || "(empty directory)")],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("list_directory", resolved, token(), "error", msg);
        return errorResult(`Failed to list directory: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 6. move_file (move / rename — soft-delete aware)
  // ========================================================================
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
    async (args, ctx) => {
      const srcResult = validatePath(args.source);
      const dstResult = validatePath(args.destination);
      if (!srcResult.ok || !srcResult.resolvedPath) {
        return errorResult(`Source: ${srcResult.error}`);
      }
      if (!dstResult.ok || !dstResult.resolvedPath) {
        return errorResult(`Destination: ${dstResult.error}`);
      }
      const src = srcResult.resolvedPath;
      const dst = dstResult.resolvedPath;

      // Guard both source and destination
      const srcGuard = checkFileAccess(src, "write");
      if (srcGuard) {
        logOperation("move_file", src, token(), "denied", srcGuard, dst);
        return errorResult(`Source: ${srcGuard}`);
      }
      const dstGuard = checkFileAccess(dst, "write");
      if (dstGuard) {
        logOperation("move_file", src, token(), "denied", dstGuard, dst);
        return errorResult(`Destination: ${dstGuard}`);
      }

      if (!fs.existsSync(src)) {
        return errorResult(`Source not found: ${args.source}`);
      }

      try {
        // If destination exists, move to trash
        if (fs.existsSync(dst)) {
          moveToTrash(dst);
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(dst);
        fs.mkdirSync(parentDir, { recursive: true });

        fs.renameSync(src, dst);
        logOperation("move_file", src, token(), "success", undefined, dst);
        return {
          content: [textContent(`Successfully moved ${src} → ${dst}`)],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cross-device rename fallback
        try {
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
          logOperation("move_file", src, token(), "success", "cross-device copy", dst);
          return {
            content: [textContent(`Successfully moved (cross-device) ${src} → ${dst}`)],
          };
        } catch {
          logOperation("move_file", src, token(), "error", msg, dst);
          return errorResult(`Failed to move: ${msg}`);
        }
      }
    }
  );

  // ========================================================================
  // 7. search_files
  // ========================================================================
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
    async (args, ctx) => {
      const rootPath = args.path;
      const pathResult = validatePath(rootPath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      if (!fs.existsSync(resolved)) {
        return errorResult(`Path not found: ${rootPath}`);
      }

      const excludes = args.excludePatterns || [];
      const results: string[] = [];
      const maxResults = 200;

      function globMatch(name: string, pattern: string): boolean {
        // Convert glob to regex
        const regex = new RegExp(
          "^" +
            pattern
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$"
        );
        return regex.test(name);
      }

      function walk(dir: string, depth: number): void {
        if (results.length >= maxResults || depth > 15) return;

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (results.length >= maxResults) break;

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(resolved, fullPath);

          // Check excludes
          const isExcluded = excludes.some(
            (ex) => globMatch(entry.name, ex) || relativePath.includes(ex)
          );
          if (isExcluded) continue;

          if (globMatch(entry.name, args.pattern)) {
            results.push(fullPath);
          }

          if (entry.isDirectory()) {
            walk(fullPath, depth + 1);
          }
        }
      }

      try {
        walk(resolved, 0);
        logOperation("search_files", resolved, token(), "success", `pattern=${args.pattern}, found=${results.length}`);
        const output =
          results.length === 0
            ? "No matching files found."
            : results.join("\n");
        return { content: [textContent(output)] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("search_files", resolved, token(), "error", msg);
        return errorResult(`Search failed: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 8. get_file_info
  // ========================================================================
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
    async (args, ctx) => {
      const filePath = args.path;
      const pathResult = validatePath(filePath);
      if (!pathResult.ok || !pathResult.resolvedPath) {
        return errorResult(pathResult.error || "Invalid path");
      }
      const resolved = pathResult.resolvedPath;

      if (!fs.existsSync(resolved)) {
        return errorResult(`Path not found: ${filePath}`);
      }

      try {
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
        logOperation("get_file_info", resolved, token(), "success");
        return {
          content: [textContent(JSON.stringify(info, null, 2))],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logOperation("get_file_info", resolved, token(), "error", msg);
        return errorResult(`Failed to get file info: ${msg}`);
      }
    }
  );

  // ========================================================================
  // 9. list_allowed_directories
  // ========================================================================
  server.registerTool(
    "list_allowed_directories",
    {
      description:
        "List the directories this MCP server is allowed to access. " +
        "All file operations are restricted to these roots.",
      inputSchema: {},
    },
    async (args, ctx) => {
      const dirs = getAllowedDirectories();
      if (dirs.length === 0) {
        return {
          content: [textContent("No allowed directories configured. Set ALLOWED_DIRS to enable file operations.")],
        };
      }
      return {
        content: [textContent(dirs.join("\n"))],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
