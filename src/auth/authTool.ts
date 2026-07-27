import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRequestUserId } from "../security/requestContext.js";
import { logger } from "../security/logger.js";
import { attemptAuth, getActiveUsers, getMode } from "./pinAuth.js";

export function registerAuthTool(server: McpServer): void {
  server.registerTool(
    "auth",
    {
      description: "Authenticate the current request identity for access to MCP tools.",
      inputSchema: {
        pin: z.string().optional().describe("The server PIN when AUTH_MODE=pin"),
      },
    },
    async (args) => {
      const mode = getMode();
      const userId = getRequestUserId();
      const result = attemptAuth(args.pin, userId);
      if (!result.ok) {
        logger.warn("tool_authentication_failed", { mode, userId });
        return {
          content: [{ type: "text" as const, text: result.error || "Authentication failed" }],
          isError: true,
        };
      }

      logger.info("tool_authentication_succeeded", {
        mode,
        userId,
        evictedUsers: result.evictedUsers,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              mode,
              userId,
              evictedUsers: result.evictedUsers || [],
              activeUsers: getActiveUsers().length,
            }),
          },
        ],
      };
    }
  );
}
