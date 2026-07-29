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
import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
} from "../config.js";
import {
  inspectPathBoundary,
  inspectPathBoundaryWithAdditionalRoots,
  validatePath,
} from "../security/pathGuard.js";
import { checkFileAccess } from "../security/fileGuard.js";
import {
  getRequestToken,
  getRequestUserId,
  rememberRequestDirectoryRoots,
} from "../security/requestContext.js";
import { logOperation, type OperationType } from "../security/logger.js";
import {
  authorizeFilePath,
  authorizeToolCall,
} from "../security/toolAccess.js";
import {
  directoryGrantStore,
  type DirectoryGrantStore,
  type EffectiveRootSource,
} from "../security/directoryGrantStore.js";
import {
  canonicalizeDirectoryScope,
  deduplicateRoots,
  digestDirectoryRoots,
  type CanonicalDirectoryRoot,
  type DirectoryScopeKind,
} from "../security/directoryRoots.js";
import {
  requestDirectoryAuthorization,
  type DirectoryAuthorizationAllowed,
  type DirectoryAuthorizationOutcome,
  type DirectoryAuthorizationRequest,
} from "../security/directoryAuthorization.js";
import { digestArguments } from "../security/approval.js";
import type { SignedRequestStatePayload } from "../security/approvalState.js";
import { toolError } from "./results.js";
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
  error?: string;
  result?: CallToolResult | InputRequiredResult;
}

export interface PathAccessRequest {
  argName: string;
  inputPath: string;
  operation: "read" | "write";
  scope: DirectoryScopeKind;
  access?: DirectoryAuthorizationRequest["access"];
}

export interface AuthorizedPath {
  argName: string;
  inputPath: string;
  resolvedPath: string;
  boundarySource: EffectiveRootSource | "allow_once";
}

export interface DirectoryAuthorizationProof {
  rootsDigest: string;
  source: "owner_default" | "session" | "permanent" | "allow_once";
}

export interface ResolvePathsDependencies {
  authorize?: (
    request: DirectoryAuthorizationRequest,
    ctx: ServerContext,
    store: DirectoryGrantStore,
  ) => Promise<DirectoryAuthorizationOutcome>;
  store?: DirectoryGrantStore;
}

function requestedAccess(requests: PathAccessRequest[]): DirectoryAuthorizationRequest["access"] {
  for (const access of ["patch", "command", "git", "write", "search"] as const) {
    if (requests.some((request) => request.access === access)) return access;
  }
  return "read";
}

function operationStateCarriesDirectoryProof(
  ctx: ServerContext,
  toolName: string,
  argsDigest: string,
  rootsDigest: string,
): boolean {
  const state = ctx.mcpReq.requestState<SignedRequestStatePayload>();
  return Boolean(state && !("kind" in state) &&
    state.tool === toolName && state.userId === getRequestUserId() &&
    state.argsDigest === argsDigest &&
    state.authorizedDirectoryRootsDigest === rootsDigest);
}

function isDirectoryAllowed(
  outcome: DirectoryAuthorizationOutcome,
): outcome is DirectoryAuthorizationAllowed {
  return "allowed" in outcome && outcome.allowed === true;
}

export async function resolvePathsGuardAndAuthorize(
  toolName: string,
  requests: PathAccessRequest[],
  args: unknown,
  ctx: ServerContext,
  deps: ResolvePathsDependencies = {},
): Promise<
  | { ok: true; paths: AuthorizedPath[]; directoryProof?: DirectoryAuthorizationProof }
  | { ok: false; error?: string; result?: CallToolResult | InputRequiredResult }
> {
  const store = deps.store ?? directoryGrantStore;
  const userId = getRequestUserId();
  const initial = requests.map((request) =>
    inspectPathBoundary(request.inputPath, userId, store));
  const hardDenial = initial.find((item) => item.status === "denied");
  if (hardDenial?.status === "denied") {
    return { ok: false, result: toolError(hardDenial.code, hardDenial.message) };
  }

  const outsideRoots = deduplicateRoots(initial.flatMap((item, index) =>
    item.status === "outside"
      ? [canonicalizeDirectoryScope(item.logicalPath, requests[index].scope)]
      : []));
  const argsDigest = digestArguments(args);
  const rootsDigest = digestDirectoryRoots(outsideRoots);
  let ephemeralRoots: CanonicalDirectoryRoot[] = [];
  let directoryProof: DirectoryAuthorizationProof | undefined;

  if (outsideRoots.length > 0) {
    if (operationStateCarriesDirectoryProof(ctx, toolName, argsDigest, rootsDigest)) {
      ephemeralRoots = outsideRoots;
      directoryProof = { rootsDigest, source: "allow_once" };
    } else {
      const request: DirectoryAuthorizationRequest = {
        tool: toolName,
        userId,
        argsDigest,
        access: requestedAccess(requests),
        roots: outsideRoots,
      };
      const authorize = deps.authorize ?? ((value, serverContext, grantStore) =>
        requestDirectoryAuthorization(serverContext, value, grantStore));
      const outcome = await authorize(request, ctx, store);
      if (!isDirectoryAllowed(outcome)) return { ok: false, result: outcome };
      if (outcome.decision === "allow_once") {
        ephemeralRoots = outcome.roots;
        directoryProof = { rootsDigest: outcome.rootsDigest, source: "allow_once" };
      }
    }
  }

  if (ephemeralRoots.length > 0) rememberRequestDirectoryRoots(ephemeralRoots);

  const verified = requests.map((request) =>
    inspectPathBoundaryWithAdditionalRoots(
      request.inputPath,
      ephemeralRoots,
      userId,
      store,
    ));
  if (!verified.every((item) => item.status === "allowed")) {
    return { ok: false, error: "Directory authorization did not cover every physical target." };
  }

  const paths: AuthorizedPath[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const item = verified[index];
    if (item.status !== "allowed") continue;
    const guardError = checkFileAccess(item.physicalPath, requests[index].operation);
    if (guardError) return { ok: false, error: guardError };
    paths.push({
      argName: requests[index].argName,
      inputPath: requests[index].inputPath,
      resolvedPath: item.physicalPath,
      boundarySource: item.matchedRoot.source,
    });
  }
  return { ok: true, paths, ...(directoryProof ? { directoryProof } : {}) };
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

/**
 * Keep directory and symlink validation ahead of consent. A consent decision
 * is never requested for a path outside the configured filesystem boundary.
 */
export async function resolveGuardAndAuthorize(
  toolName: string,
  argName: string,
  inputPath: string,
  operation: "read" | "write",
  args: unknown,
  ctx: ServerContext,
  options: {
    scope?: DirectoryScopeKind;
    access?: DirectoryAuthorizationRequest["access"];
  } = {},
): Promise<ResolvedAndGuarded | GuardFailed> {
  const guarded = await resolvePathsGuardAndAuthorize(
    toolName,
    [{
      argName,
      inputPath,
      operation,
      scope: options.scope ?? "file",
      access: options.access,
    }],
    args,
    ctx,
  );
  if (!guarded.ok) {
    logOperation(
      toolName as OperationType,
      inputPath,
      getRequestToken(),
      "denied",
      guarded.error
    );
    return guarded;
  }
  const pathResult = guarded.paths[0];
  const approval = await authorizeFilePath(
    toolName,
    argName,
    inputPath,
    pathResult.resolvedPath,
    args,
    ctx,
    {
      directoryAuthorized: pathResult.boundarySource !== "static",
      authorizedDirectoryRootsDigest: guarded.directoryProof?.rootsDigest,
    },
  );
  if (approval !== true) {
    if ("isError" in approval && approval.isError) {
      logOperation(
        toolName as OperationType,
        pathResult.resolvedPath,
        getRequestToken(),
        "denied",
        "approval denied"
      );
    }
    return { ok: false, result: approval };
  }
  return { ok: true, resolvedPath: pathResult.resolvedPath };
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
