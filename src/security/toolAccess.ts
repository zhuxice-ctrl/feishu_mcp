import { isAuthenticated } from "../auth/pinAuth.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { NextFunction, Request, Response } from "express";
import {
  CONSENT_ABSOLUTE_PATH,
  CONSENT_SENSITIVE_FILE,
  OWNER_USER_ID,
} from "../config.js";
import { extractRequestContext, getRequestUserId } from "./requestContext.js";
import { inspectPath, PATH_ARGS } from "./consent.js";
import {
  digestArguments,
  requestApproval,
  type ApprovalOutcome,
} from "./approval.js";
import { logger } from "./logger.js";
import { toolError } from "../tools/results.js";

export interface ToolAccessError {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface ToolCallDescriptor {
  id: string | number | null;
  toolName: string;
}

function findProtectedToolCalls(body: unknown): ToolCallDescriptor[] {
  const messages = Array.isArray(body) ? body : [body];
  const calls: ToolCallDescriptor[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call") continue;
    const params =
      record.params && typeof record.params === "object"
        ? (record.params as Record<string, unknown>)
        : {};
    if (params.name === "auth") continue;
    calls.push({
      id:
        typeof record.id === "string" || typeof record.id === "number" || record.id === null
          ? record.id
          : null,
      toolName: typeof params.name === "string" ? params.name : "unknown",
    });
  }
  return calls;
}

function authorizeToolForUser(toolName: string, userId: string | null): ToolAccessError | null {
  if (isAuthenticated(userId)) return null;
  logger.warn("tool_authorization_denied", { toolName, userId });
  return {
    content: [
      {
        type: "text",
        text: "Authentication required. Call the auth tool before using this tool.",
      },
    ],
    isError: true,
  };
}

export function authorizeToolCall(
  toolName: string,
  _args: unknown
): ToolAccessError | null {
  return authorizeToolForUser(toolName, getRequestUserId());
}

/**
 * Owner-only authorization for development tools. Runs the standard
 * authenticated-identity check first, then requires a configured owner and a
 * matching request identity. `authorizeToolCall` behavior is unchanged.
 */
export function authorizeOwnerToolCall(
  toolName: string,
  _args: unknown,
): ToolAccessError | null {
  const authenticated = authorizeToolCall(toolName, _args);
  if (authenticated) return authenticated;
  if (!OWNER_USER_ID) {
    return toolError("OWNER_NOT_CONFIGURED", "Development tools require OWNER_USER_ID.");
  }
  if (getRequestUserId() !== OWNER_USER_ID) {
    logger.warn("owner_tool_authorization_denied", {
      toolName,
      identityPresent: getRequestUserId() !== null,
    });
    return toolError("OWNER_REQUIRED", "This development tool is restricted to the configured owner.");
  }
  return null;
}

/**
 * Enforce consent only after the caller has passed `validatePath`. The
 * resolved subject is used for decision memory, while the raw value retains
 * the distinction between absolute and relative caller input.
 */
export async function authorizeFilePath(
  toolName: string,
  argName: string,
  rawPath: string,
  resolvedPath: string,
  args: unknown,
  ctx: ServerContext,
  options: {
    directoryAuthorized?: boolean;
    authorizedDirectoryRootsDigest?: string;
    priorSubjectKeys?: string[];
  } = {},
): Promise<ApprovalOutcome> {
  if (!PATH_ARGS[toolName]?.includes(argName)) return true;
  const kinds = inspectPath(toolName, rawPath, resolvedPath)
    .filter((kind) => !(options.directoryAuthorized && kind === "absolute_path"));
  if (kinds.length === 0) return true;
  if (
    (kinds.includes("absolute_path") && CONSENT_ABSOLUTE_PATH === "deny") ||
    (kinds.includes("sensitive_file") && CONSENT_SENSITIVE_FILE === "deny")
  ) {
    return toolError("APPROVAL_DENIED", `Consent policy denied ${argName}.`);
  }
  if (
    (!kinds.includes("absolute_path") || CONSENT_ABSOLUTE_PATH === "allow") &&
    (!kinds.includes("sensitive_file") || CONSENT_SENSITIVE_FILE === "allow")
  ) {
    return true;
  }
  return requestApproval(ctx, {
    tool: toolName,
    userId: getRequestUserId(),
    subject: {
      kind: "path",
      key: `${[...kinds].sort().join("+")}|${resolvedPath}`,
      display: resolvedPath,
    },
    argsDigest: digestArguments(args),
    reasons: kinds.map((kind) =>
      kind === "absolute_path"
        ? "The caller supplied an absolute path."
        : "The target is classified as a sensitive file."
    ),
    authorizedDirectoryRootsDigest: options.authorizedDirectoryRootsDigest,
    priorSubjectKeys: options.priorSubjectKeys,
  });
}

export function fileApprovalSubjectKey(
  toolName: string,
  rawPath: string,
  resolvedPath: string,
  directoryAuthorized = false,
): string | null {
  const kinds = inspectPath(toolName, rawPath, resolvedPath)
    .filter((kind) => !(directoryAuthorized && kind === "absolute_path"));
  return kinds.length > 0 ? `${[...kinds].sort().join("+")}|${resolvedPath}` : null;
}

export function toolAuthorizationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const protectedCalls = findProtectedToolCalls(req.body);
  if (protectedCalls.length === 0) {
    next();
    return;
  }

  const { userId } = extractRequestContext(req);
  const denials = protectedCalls.flatMap(({ id, toolName }) => {
    const result = authorizeToolForUser(toolName, userId);
    return result ? [{ jsonrpc: "2.0", id, result }] : [];
  });
  if (denials.length === 0) {
    next();
    return;
  }

  res.status(200).json(Array.isArray(req.body) ? denials : denials[0]);
}
