/**
 * File-type and sensitive-file protection.
 *
 * Blocks dangerous executable file types. Sensitive files are classified here
 * and gated by configurable consent in `consent.ts`.
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
  const normalizedPath = filePath.replace(/\\/g, "/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Returns an error message for unconditionally blocked executable types.
 */
export function checkFileAccess(
  filePath: string,
  operation: "read" | "write"
): string | null {
  if (isBlockedExtension(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    return `File type "${ext}" is blocked for ${operation} operations.`;
  }

  return null;
}
