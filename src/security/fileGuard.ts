/**
 * File-type and sensitive-file protection.
 *
 * Blocks dangerous executable file types and sensitive system files
 * (credentials, SSH keys, browser data, etc.) from being read or written.
 */

import path from "node:path";
import { BLOCKED_EXTENSIONS, SENSITIVE_PATTERNS } from "../config.js";

/**
 * Returns true if the file path has a blocked extension.
 */
export function isBlockedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}

/**
 * Returns true if the file path matches a sensitive file pattern.
 */
export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Combined check — returns an error message if the path is blocked, or null if safe.
 */
export function checkFileAccess(
  filePath: string,
  operation: "read" | "write"
): string | null {
  if (isSensitiveFile(filePath)) {
    return `Access to sensitive file "${filePath}" is blocked (${operation}).`;
  }

  if (isBlockedExtension(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    return `File type "${ext}" is blocked for ${operation} operations.`;
  }

  return null;
}
