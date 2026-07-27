import { isAuthenticated } from "../auth/pinAuth.js";
import { getRequestUserId } from "./requestContext.js";
import { logger } from "./logger.js";

export interface ToolAccessError {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export function authorizeToolCall(
  toolName: string,
  _args: unknown
): ToolAccessError | null {
  const userId = getRequestUserId();
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
