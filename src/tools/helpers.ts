/**
 * Shared helpers for the filesystem tools.
 *
 * Centralizes the patterns every tool repeats:
 *   - path validation + file-type/sensitive-file guard
 *   - error / text content builders
 *   - the text vs binary detection heuristic
 *   - byte-size formatting
 *   - a uniform try/catch + audit-log wrapper for tool handlers
 *
 * Tool bodies in `./filesystem.ts` therefore focus on the actual operation
 * instead of repeating the same 8-line preamble.
 */

import path from "node:path";
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
} from "../config.js";
import { validatePath } from "../security/pathGuard.js";
import { checkFileAccess } from "../security/fileGuard.js";
import { getRequestToken } from "../security/requestContext.js";
import { logOperation, type OperationType } from "../security/logger.js";
export { authorizeToolCall } from "../security/toolAccess.js";

// ---------------------------------------------------------------------------
// MCP content builders
// ---------------------------------------------------------------------------

/** Wrap a string in a standard MCP text content block. */
export function textContent(text: string) {
  return { type: "text" as const, text };
}

/** Build the canonical error response for a tool. */
export function errorResult(message: string) {
  return {
    content: [textContent(`Error: ${message}`)],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Path resolution + guard
// ---------------------------------------------------------------------------

export interface ResolvedAndGuarded {
  ok: true;
  resolvedPath: string;
}
export interface GuardFailed {
  ok: false;
  error: string;
}

/**
 * Validate the requested path against the allowed-directories whitelist AND
 * the file-type / sensitive-file blacklist for the given operation.
 *
 * Returns a discriminated result; callers should bail with `errorResult()`
 * when `ok` is false.  This is the only function a tool needs for its
 * first-line "is this request even legal" check.
 */
export function resolveAndGuard(
  inputPath: string,
  operation: "read" | "write"
): ResolvedAndGuarded | GuardFailed {
  const pathResult = validatePath(inputPath);
  if (!pathResult.ok || !pathResult.resolvedPath) {
    return { ok: false, error: pathResult.error || "Invalid path" };
  }
  const resolved = pathResult.resolvedPath;
  const guardError = checkFileAccess(resolved, operation);
  if (guardError) {
    return { ok: false, error: guardError };
  }
  return { ok: true, resolvedPath: resolved };
}

// ---------------------------------------------------------------------------
// Text vs binary detection
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

/**
 * Cheap heuristic — known text extension or no extension at all.  For any
 * other extension we conservatively say "not text" and let the caller fall
 * through to the null-byte sniff in `read_file` to make the final
 * text-vs-binary decision.
 */
export function isLikelyTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Byte formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Size guards
// ---------------------------------------------------------------------------

export function checkReadSize(sizeBytes: number): string | null {
  if (sizeBytes > MAX_READ_BYTES) {
    return `File too large (${sizeBytes} bytes, max ${MAX_READ_BYTES})`;
  }
  return null;
}

export function checkWriteSize(sizeBytes: number): string | null {
  if (sizeBytes > MAX_WRITE_BYTES) {
    return `Content too large (${sizeBytes} bytes, max ${MAX_WRITE_BYTES})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Uniform tool-handler envelope — try / catch / audit-log
// ---------------------------------------------------------------------------

/**
 * Run a tool's body with uniform error handling and audit logging.
 *
 * `operation` is the MCP tool name (used for the log entry).  `body` is the
 * actual work; thrown errors are converted to `errorResult()` AND recorded
 * in the audit log with result="error" so a single failure leaves a trail.
 *
 * The audit token is read from the AsyncLocalStorage-managed request
 * context, so concurrent requests log against their own token instead of
 * racing on a module-level variable.
 */
export async function withToolHandler(
  operation: OperationType,
  resolvedPath: string,
  body: () => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const token = getRequestToken();
  try {
    const result = await body();
    if (!result.isError) {
      logOperation(operation, resolvedPath, token, "success");
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logOperation(operation, resolvedPath, token, "error", msg);
    return errorResult(`Failed: ${msg}`);
  }
}
