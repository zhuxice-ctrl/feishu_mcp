import { isAuthenticated } from "../auth/pinAuth.js";
import type { NextFunction, Request, Response } from "express";
import { extractRequestContext, getRequestUserId } from "./requestContext.js";
import { consentGate, inspectPath, PATH_ARGS } from "./consent.js";
import { logger } from "./logger.js";

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
 * Enforce consent only after the caller has passed `validatePath`. The
 * resolved subject is used for decision memory, while the raw value retains
 * the distinction between absolute and relative caller input.
 */
export async function authorizeFilePath(
  toolName: string,
  argName: string,
  rawPath: string,
  resolvedPath: string
): Promise<ToolAccessError | null> {
  if (!PATH_ARGS[toolName]?.includes(argName)) return null;
  const kinds = inspectPath(toolName, rawPath, resolvedPath);
  if (kinds.length === 0) return null;
  const decision = await consentGate.request({
    kinds,
    tool: toolName,
    userId: getRequestUserId(),
    argName,
    raw: rawPath,
    resolved: resolvedPath,
  });
  if (decision.allowed) return null;
  return {
    content: [
      {
        type: "text",
        text: `Consent denied for ${argName}.`,
      },
    ],
    isError: true,
  };
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
