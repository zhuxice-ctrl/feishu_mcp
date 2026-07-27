/**
 * Operation audit logger — records every write operation to a persistent log file.
 *
 * Each log entry contains:
 *   timestamp, operation type, path, token identifier (truncated hash), result.
 *
 * This provides a full audit trail for all filesystem modifications.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import {
  LOG_DIR,
  LOG_FILE,
  LOG_FORMAT,
  LOG_LEVEL,
  type LogLevel,
} from "../config.js";

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

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function isSecretField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    [
      "authorization",
      "cookie",
      "credential",
      "credentials",
      "password",
      "passwd",
      "pin",
      "secret",
      "token",
      "apikey",
    ].includes(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSecretField(key)
      ? "[REDACTED]"
      : redactValue(nestedValue, seen);
  }
  return redacted;
}

export function redactSecrets(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, new WeakSet()) as Record<string, unknown>;
}

function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[LOG_LEVEL]) return;
  try {
    const redactedFields = redactSecrets(fields);
    const entry = {
      ...redactedFields,
      timestamp: new Date().toISOString(),
      level,
      event,
    };
    const line =
      LOG_FORMAT === "json"
        ? JSON.stringify(entry)
        : `${entry.timestamp} ${level.toUpperCase()} ${event}${
            Object.keys(redactedFields).length ? ` ${JSON.stringify(redactedFields)}` : ""
          }`;
    process.stderr.write(`${line}\n`);
  } catch {
    // Event logging is best-effort and must never interrupt request handling.
  }
}

export const logger = {
  error: (event: string, fields?: Record<string, unknown>) => logEvent("error", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => logEvent("warn", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => logEvent("info", event, fields),
  debug: (event: string, fields?: Record<string, unknown>) => logEvent("debug", event, fields),
  trace: (event: string, fields?: Record<string, unknown>) => logEvent("trace", event, fields),
};

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
