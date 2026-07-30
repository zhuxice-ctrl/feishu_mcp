/**
 * Central configuration — all environment-driven settings live here.
 * Phases 2-5 read from this module so there is a single source of truth.
 *
 * Identity (name / version) is exported from here so the MCP server
 * registration and the HTTP health endpoint always report the same values.
 */

import path from "node:path";
import os from "node:os";

function envEnum<const T extends readonly string[]>(
  name: string,
  allowed: T,
  defaultValue: T[number]
): T[number] {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function envBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function envPositiveInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function envBoundedPositiveInt(name: string, defaultValue: number, maxValue: number): number {
  const value = envPositiveInt(name, defaultValue);
  if (value > maxValue) {
    throw new Error(`${name} must be at most ${maxValue}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Server identity — single source of truth (was duplicated across index.ts,
// /health endpoint, and the e2e test prior to the refactor).
// ---------------------------------------------------------------------------

/** Name advertised via MCP `initialize` (serverInfo.name) and /health. */
export const SERVER_NAME = "feishu-mcp";

/** Version advertised via MCP `initialize` and /health. Mirrors package.json. */
export const SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = envPositiveInt("PORT", 3000);
if (PORT > 65_535) throw new Error("PORT must be between 1 and 65535");
export const HOST = process.env.HOST || "0.0.0.0";
export const MCP_ENDPOINT = process.env.MCP_ENDPOINT || "/mcp";

// ---------------------------------------------------------------------------
// Local development tool execution limits
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY_LIMIT = 64;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

export const MAX_CONCURRENT_TOOLS = envBoundedPositiveInt(
  "MAX_CONCURRENT_TOOLS", 8, MAX_CONCURRENCY_LIMIT
);
export const MAX_CONCURRENT_COMMANDS = envBoundedPositiveInt(
  "MAX_CONCURRENT_COMMANDS", 2, MAX_CONCURRENCY_LIMIT
);
export const MAX_CONCURRENT_SEARCHES = envBoundedPositiveInt(
  "MAX_CONCURRENT_SEARCHES", 2, MAX_CONCURRENCY_LIMIT
);
export const MAX_CONCURRENT_FETCHES = envBoundedPositiveInt(
  "MAX_CONCURRENT_FETCHES", 4, MAX_CONCURRENCY_LIMIT
);
export const TOOL_QUEUE_TIMEOUT_MS = envBoundedPositiveInt(
  "TOOL_QUEUE_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS
);
export const COMMAND_TIMEOUT_MS = envBoundedPositiveInt(
  "COMMAND_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS
);
export const COMMAND_MAX_TIMEOUT_MS = envBoundedPositiveInt(
  "COMMAND_MAX_TIMEOUT_MS", 300_000, MAX_TIMEOUT_MS
);
export const COMMAND_MAX_OUTPUT_BYTES = envBoundedPositiveInt(
  "COMMAND_MAX_OUTPUT_BYTES", 1_048_576, MAX_RESPONSE_BYTES
);
export const SEARCH_TIMEOUT_MS = envBoundedPositiveInt(
  "SEARCH_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS
);
export const SEARCH_MAX_FILES = envBoundedPositiveInt(
  "SEARCH_MAX_FILES", 10_000, MAX_RESPONSE_BYTES
);
export const SEARCH_MAX_RESULTS = envBoundedPositiveInt(
  "SEARCH_MAX_RESULTS", 1_000, MAX_RESPONSE_BYTES
);
export const GIT_TIMEOUT_MS = envBoundedPositiveInt(
  "GIT_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS
);
export const FETCH_TIMEOUT_MS = envBoundedPositiveInt(
  "FETCH_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS
);
export const FETCH_MAX_TIMEOUT_MS = envBoundedPositiveInt(
  "FETCH_MAX_TIMEOUT_MS", 120_000, MAX_TIMEOUT_MS
);
export const FETCH_MAX_BYTES = envBoundedPositiveInt(
  "FETCH_MAX_BYTES", 5_242_880, MAX_RESPONSE_BYTES
);
export const FETCH_MAX_REDIRECTS = envBoundedPositiveInt(
  "FETCH_MAX_REDIRECTS", 5, MAX_RESPONSE_BYTES
);
export const APPROVAL_TIMEOUT_MS = envBoundedPositiveInt(
  "APPROVAL_TIMEOUT_MS", 600_000, MAX_TIMEOUT_MS
);
export const APPROVAL_STATE_SECRET = process.env.APPROVAL_STATE_SECRET || "";
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
export const APPROVAL_DATA_DIR = process.env.APPROVAL_DATA_DIR || path.join(localAppData, "feishu-mcp");

// ---------------------------------------------------------------------------
// Development task execution limits (Phase 1 — owner-only background tasks)
// ---------------------------------------------------------------------------

export const DEV_MAX_TASKS = envBoundedPositiveInt("DEV_MAX_TASKS", 4, 16);
export const DEV_MAX_BUILDS = envBoundedPositiveInt("DEV_MAX_BUILDS", 2, 8);
export const DEV_TASK_QUEUE_TIMEOUT_MS = envBoundedPositiveInt(
  "DEV_TASK_QUEUE_TIMEOUT_MS", 15 * 60_000, MAX_TIMEOUT_MS,
);
export const DEV_TASK_RETENTION_DAYS = envBoundedPositiveInt("DEV_TASK_RETENTION_DAYS", 14, 365);
export const DEV_TASK_MAX_TOTAL_BYTES = envBoundedPositiveInt(
  "DEV_TASK_MAX_TOTAL_BYTES", 1_073_741_824, 10 * 1_073_741_824,
);
export const DEV_TASK_LOG_MAX_BYTES = envBoundedPositiveInt(
  "DEV_TASK_LOG_MAX_BYTES", 52_428_800, 536_870_912,
);
export const DEV_TASK_HEARTBEAT_MS = envBoundedPositiveInt("DEV_TASK_HEARTBEAT_MS", 2_000, 60_000);
export const DEV_TASK_CANCEL_GRACE_MS = envBoundedPositiveInt("DEV_TASK_CANCEL_GRACE_MS", 5_000, 60_000);
export const DEV_TASK_MAX_RUNTIME_MS = envBoundedPositiveInt(
  "DEV_TASK_MAX_RUNTIME_MS", 2 * 60 * 60_000, 24 * 60 * 60_000,
);
export const DEV_TASK_DATA_DIR = path.resolve(
  process.env.DEV_TASK_DATA_DIR || path.join(APPROVAL_DATA_DIR, "tasks"),
);
const taskDataRelative = path.relative(path.resolve(APPROVAL_DATA_DIR), DEV_TASK_DATA_DIR);
if (taskDataRelative.startsWith("..") || path.isAbsolute(taskDataRelative)) {
  throw new Error("DEV_TASK_DATA_DIR must be inside APPROVAL_DATA_DIR");
}

// ---------------------------------------------------------------------------
// Development environment subsystem (Phase 2 — trusted toolchain provisioning)
// ---------------------------------------------------------------------------

/**
 * Reviewed catalog of trusted toolchain components. The same JSON is embedded
 * into the C# administrator broker at build time; both sides validate against
 * the same Zod schema. An MCP caller can never supply a component, URL, or
 * argument — only exact catalog component IDs.
 */
export const DEV_ENV_CATALOG_PATH = path.resolve(
  process.env.DEV_ENV_CATALOG_PATH ||
    path.join(process.cwd(), "config", "development-package-catalog.json"),
);

/**
 * Single-use signed environment plans live here as 0600 metadata files. Must
 * remain inside {@link APPROVAL_DATA_DIR} so plan secrets share the same
 * ACL-protected boundary as approval state.
 */
export const DEV_ENV_PLAN_DIR = path.resolve(
  process.env.DEV_ENV_PLAN_DIR || path.join(APPROVAL_DATA_DIR, "environment-plans"),
);
const envPlanRelative = path.relative(path.resolve(APPROVAL_DATA_DIR), DEV_ENV_PLAN_DIR);
if (envPlanRelative.startsWith("..") || path.isAbsolute(envPlanRelative)) {
  throw new Error("DEV_ENV_PLAN_DIR must be inside APPROVAL_DATA_DIR");
}

/**
 * Owner Windows SID used to derive the administrator-broker named-pipe path.
 * Empty on non-Windows or when the broker is not installed; privileged
 * operations then fail with BROKER_UNAVAILABLE instead of attempting a
 * connection.
 */
export const DEV_ENV_OWNER_SID = process.env.DEV_ENV_OWNER_SID?.trim() ?? "";

/**
 * Path to the 32-byte broker shared key (ACL-protected). When empty the
 * broker client is not constructed and privileged installs are unavailable.
 */
export const DEV_ENV_BROKER_KEY_PATH = process.env.DEV_ENV_BROKER_KEY_PATH?.trim() ?? "";

/**
 * Filesystem roots that resolved executable candidates must remain within.
 * Candidates whose real path escapes every root are marked untrusted.
 */
export const DEV_ENV_ALLOWED_ROOTS = envPathList("DEV_ENV_ALLOWED_ROOTS");

// ---------------------------------------------------------------------------
// Allowed directories (Phase 2 — directory whitelist)
// ---------------------------------------------------------------------------

function envPathList(name: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of (process.env[name] ?? "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(resolved);
  }
  return values;
}

/**
 * Resolved absolute paths of directories the server is allowed to operate in.
 * Empty array when ALLOWED_DIRS is unset — all file tools will refuse to run
 * until the operator configures at least one root.
 */
export const ALLOWED_DIRS = envPathList("ALLOWED_DIRS");
export const OWNER_USER_ID = process.env.OWNER_USER_ID?.trim() ?? "";
export const OWNER_DEFAULT_DIRS = envPathList("OWNER_DEFAULT_DIRS");
export type DirectoryApprovalFallback = "deny" | "owner";
export const DIRECTORY_APPROVAL_FALLBACK: DirectoryApprovalFallback = envEnum(
  "DIRECTORY_APPROVAL_FALLBACK",
  ["deny", "owner"] as const,
  "deny",
);

if (OWNER_DEFAULT_DIRS.length > 0 && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when OWNER_DEFAULT_DIRS is configured");
}
if (DIRECTORY_APPROVAL_FALLBACK === "owner" && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when directory approval fallback is owner");
}

// ---------------------------------------------------------------------------
// Authentication (Phase 3 — Bearer Token)
// ---------------------------------------------------------------------------

export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

/**
 * When true the server requires every MCP request to carry a valid Bearer
 * token.  Set MCP_AUTH_TOKEN to enable.
 */
export const AUTH_ENABLED = MCP_AUTH_TOKEN.length > 0;

export type AuthMode = "pin" | "header" | "none";

export const AUTH_MODE: AuthMode = envEnum(
  "AUTH_MODE",
  ["pin", "header", "none"] as const,
  "pin"
);
export const AUTH_PIN = process.env.AUTH_PIN || "";
export const AUTH_USER_HEADER = process.env.AUTH_USER_HEADER?.trim() || "x-aily-user";
export const AUTH_EMAIL_HEADER = process.env.AUTH_EMAIL_HEADER?.trim() || "x-aily-email";
export const AUTH_USER_QUERY_PARAM = process.env.AUTH_USER_QUERY_PARAM?.trim() || "";
export const AUTH_MULTI_USER = envBoolean("AUTH_MULTI_USER", false);
export const AUTH_MAX_USERS = envPositiveInt("AUTH_MAX_USERS", 8);

if (AUTH_MODE === "pin" && !AUTH_PIN) {
  throw new Error("AUTH_PIN is required when AUTH_MODE=pin");
}
if (AUTH_PIN && AUTH_PIN.length < 8) {
  throw new Error("AUTH_PIN must be at least 8 characters when configured");
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

export type ConsentPolicy = "confirm" | "allow" | "deny";
export type NonInteractivePolicy = "deny" | "allow";

export const CONSENT_ABSOLUTE_PATH: ConsentPolicy = envEnum(
  "CONSENT_ABSOLUTE_PATH",
  ["confirm", "allow", "deny"] as const,
  "confirm"
);
export const CONSENT_SENSITIVE_FILE: ConsentPolicy = envEnum(
  "CONSENT_SENSITIVE_FILE",
  ["confirm", "allow", "deny"] as const,
  "confirm"
);
export const CONSENT_TIMEOUT_MS = envPositiveInt("CONSENT_TIMEOUT_MS", 60_000);
export const NON_INTERACTIVE: NonInteractivePolicy = envEnum(
  "NON_INTERACTIVE",
  ["deny", "allow"] as const,
  "deny"
);

// ---------------------------------------------------------------------------
// File size limits (Phase 3)
// ---------------------------------------------------------------------------

export const MAX_READ_BYTES = envPositiveInt("MAX_READ_BYTES", 10 * 1024 * 1024);
export const MAX_WRITE_BYTES = envPositiveInt("MAX_WRITE_BYTES", 5 * 1024 * 1024);

// ---------------------------------------------------------------------------
// Rate limiting (Phase 3)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PER_MIN = envPositiveInt("RATE_LIMIT_PER_MIN", 60);

// ---------------------------------------------------------------------------
// Soft-delete / recycle bin (Phase 3)
// ---------------------------------------------------------------------------

export const TRASH_DIR_NAME = ".trash";
export const TRASH_RETENTION_DAYS = envPositiveInt("TRASH_RETENTION_DAYS", 7);

// ---------------------------------------------------------------------------
// Operation log (Phase 3)
// ---------------------------------------------------------------------------

export const LOG_DIR = process.env.LOG_DIR || "logs";
export const LOG_FILE = path.join(LOG_DIR, "mcp-operations.log");

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type LogFormat = "pretty" | "json";

export const LOG_LEVEL: LogLevel = envEnum(
  "LOG_LEVEL",
  ["error", "warn", "info", "debug", "trace"] as const,
  "info"
);
export const LOG_FORMAT: LogFormat = envEnum(
  "LOG_FORMAT",
  ["pretty", "json"] as const,
  "pretty"
);

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
