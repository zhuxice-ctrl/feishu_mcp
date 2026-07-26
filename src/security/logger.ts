/**
 * Operation audit logger — records every write operation to a persistent log file.
 *
 * Each log entry contains:
 *   timestamp, operation type, path, token identifier (truncated hash), result.
 *
 * This provides a full audit trail for all filesystem modifications.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LOG_DIR, LOG_FILE } from "../config.js";

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // May fail in read-only environments — logger will be best-effort
}

export type OperationType =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "create_directory"
  | "move_file"
  | "delete_file"
  | "list_directory"
  | "search_files"
  | "get_file_info";

export interface LogEntry {
  timestamp: string;
  operation: OperationType;
  path: string;
  targetPath?: string;
  tokenHash: string;
  result: "success" | "denied" | "error";
  detail?: string;
}

/**
 * Hash a token for logging — never log the raw token.
 */
function hashToken(token: string): string {
  if (!token) return "anonymous";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Append a log entry to the operation log file.
 * Best-effort: failures are silently swallowed to avoid crashing the server.
 */
export function logOperation(
  operation: OperationType,
  filePath: string,
  token: string,
  result: "success" | "denied" | "error",
  detail?: string,
  targetPath?: string
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    operation,
    path: filePath,
    targetPath,
    tokenHash: hashToken(token),
    result,
    detail,
  };

  const line = JSON.stringify(entry) + "\n";
  try {
    fs.appendFileSync(LOG_FILE, line, { encoding: "utf-8" });
  } catch {
    // Best-effort logging — don't crash on log write failure
  }
}

/**
 * Read recent log entries (for debugging / monitoring).
 */
export function readLog(limit: number = 100): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}
