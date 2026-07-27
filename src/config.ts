/**
 * Central configuration — all environment-driven settings live here.
 * Phases 2-5 read from this module so there is a single source of truth.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const HOST = process.env.HOST || "0.0.0.0";
export const MCP_ENDPOINT = process.env.MCP_ENDPOINT || "/mcp";

// ---------------------------------------------------------------------------
// Allowed directories (Phase 2 — directory whitelist)
// ---------------------------------------------------------------------------

const rawDirs = process.env.ALLOWED_DIRS || "";

/**
 * Resolved absolute paths of directories the server is allowed to operate in.
 * Empty array when ALLOWED_DIRS is unset — all file tools will refuse to run
 * until the operator configures at least one root.
 */
export const ALLOWED_DIRS: string[] = rawDirs
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(d));

// ---------------------------------------------------------------------------
// Authentication (Phase 3 — Bearer Token)
// ---------------------------------------------------------------------------

export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

/**
 * When true the server requires every MCP request to carry a valid Bearer
 * token.  Set MCP_AUTH_TOKEN to enable.
 */
export const AUTH_ENABLED = MCP_AUTH_TOKEN.length > 0;

// ---------------------------------------------------------------------------
// File size limits (Phase 3)
// ---------------------------------------------------------------------------

export const MAX_READ_BYTES = parseInt(
  process.env.MAX_READ_BYTES || String(10 * 1024 * 1024), // 10 MB
  10
);
export const MAX_WRITE_BYTES = parseInt(
  process.env.MAX_WRITE_BYTES || String(5 * 1024 * 1024), // 5 MB
  10
);

// ---------------------------------------------------------------------------
// Rate limiting (Phase 3)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PER_MIN = parseInt(
  process.env.RATE_LIMIT_PER_MIN || "60",
  10
);

// ---------------------------------------------------------------------------
// Soft-delete / recycle bin (Phase 3)
// ---------------------------------------------------------------------------

export const TRASH_DIR_NAME = ".trash";
export const TRASH_RETENTION_DAYS = parseInt(
  process.env.TRASH_RETENTION_DAYS || "7",
  10
);

// ---------------------------------------------------------------------------
// Operation log (Phase 3)
// ---------------------------------------------------------------------------

export const LOG_DIR = process.env.LOG_DIR || "logs";
export const LOG_FILE = path.join(LOG_DIR, "mcp-operations.log");

// ---------------------------------------------------------------------------
// ngrok tunnel (optional — used by start scripts, not by the server itself)
// ---------------------------------------------------------------------------

export const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || "";
export const NGROK_DOMAIN = process.env.NGROK_DOMAIN || "";

// ---------------------------------------------------------------------------
// File-type blacklist (Phase 3)
// ---------------------------------------------------------------------------

export const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".dll",
  ".so",
  ".dylib",
  ".app",
  ".msi",
  ".sh",
  ".com",
  ".scr",
  ".jar",
]);

// Sensitive file / directory patterns that must never be served or written
export const SENSITIVE_PATTERNS: RegExp[] = [
  /\.env$/i,
  /\.env\./i,
  /\.ssh$/i,
  /\.aws\/credentials$/i,
  /\.npmrc$/i,
  /\.gitconfig$/i,
  /\.htpasswd$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /id_dsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /Cookies/i,
  /Login Data/i,
  /Local State/i,
  /Web Data/i,
];
