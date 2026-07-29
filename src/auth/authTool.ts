import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRequestUserId } from "../security/requestContext.js";
import { logger } from "../security/logger.js";
import { attemptAuth, getActiveUsers, getMode } from "./pinAuth.js";
import { submitLegacyDirectoryDecision } from "../security/legacyDirectoryApproval.js";

export function registerAuthTool(server: McpServer): void {
  server.registerTool(
    "auth",
    {
      description: "Authenticate the current request identity for access to MCP tools.",
      inputSchema: {
        pin: z.string().optional().describe("The server PIN when AUTH_MODE=pin"),
        directoryApproval: z.object({
          challenge: z.string().min(1),
          decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
        }).optional(),
      },
    },
    async (args, ctx) => {
      if (args.directoryApproval) {
        return submitLegacyDirectoryDecision(
          ctx,
          args.directoryApproval.challenge,
          args.directoryApproval.decision,
        );
      }
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
