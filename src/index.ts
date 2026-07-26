/**
 * aily-local-file-mcp — Main entry point
 *
 * Streamable HTTP MCP server with:
 *   Phase 1: HTTP skeleton + ping tool
 *   Phase 2: 9 filesystem tools (read/write/edit/list/move/search/info/allowed_dirs)
 *   Phase 3: Security layer (Bearer auth, rate limit, path guard, file guard, audit log, soft-delete)
 *   Phase 4: Cloudflare Tunnel configuration support
 *   Phase 5: End-to-end test harness
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  PORT,
  HOST,
  MCP_ENDPOINT,
  AUTH_ENABLED,
  MCP_AUTH_TOKEN,
} from "./config.js";
import { authMiddleware } from "./security/auth.js";
import { cleanupTrash } from "./security/trash.js";
import { registerFilesystemTools } from "./tools/filesystem.js";

// ---------------------------------------------------------------------------
// Token extraction — passed to tool registrations for audit logging
// ---------------------------------------------------------------------------

let currentToken = "";

function getToken(): string {
  return currentToken;
}

// ---------------------------------------------------------------------------
// MCP server factory — one fresh instance per request
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "aily-local-file-mcp",
    version: "0.2.0",
  });

  // --- Phase 1: ping tool (health verification) ---------------------------
  server.registerTool(
    "ping",
    {
      description:
        "Health check tool — returns 'pong' and optionally echoes a message. " +
        "Use this to verify the MCP server is reachable and responding.",
      inputSchema: {
        message: z
          .string()
          .optional()
          .describe("Optional message to echo back in the response"),
      },
    },
    async (args) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `pong${args.message ? `: ${args.message}` : ""}`,
          },
        ],
      };
    }
  );

  // --- Phase 2+3: Filesystem tools (with built-in security) -------------
  registerFilesystemTools(server, getToken);

  return server;
}

// ---------------------------------------------------------------------------
// Create MCP HTTP handler
// ---------------------------------------------------------------------------

const handler = createMcpHandler(createMcpServer);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app: Express = createMcpExpressApp({ host: HOST });

// --- Auth + rate-limit middleware (Phase 3) ------------------------------
// Applied only to the MCP endpoint; /health remains open for monitoring.

app.all(MCP_ENDPOINT, (req: Request, _res: Response, next) => {
  // Extract token for audit logging (the authMiddleware validates it)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) currentToken = match[1].trim();
  }
  next();
});

app.all(MCP_ENDPOINT, authMiddleware);

// --- MCP route handler ---------------------------------------------------

app.all(MCP_ENDPOINT, async (req: Request, res: Response) => {
  try {
    const protocol = req.protocol;
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const hasBody = !["GET", "DELETE", "HEAD"].includes(req.method.toUpperCase());
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody && req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });

    const response = await handler.fetch(request, {
      parsedBody: hasBody ? req.body : undefined,
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") {
        res.setHeader(key, value);
      }
    });

    if (response.body) {
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        res.flushHeaders();
      }

      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {
        // client disconnected
      }
      res.end();
    } else {
      res.end();
    }
  } catch (error) {
    console.error("[MCP] Handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// Health check endpoint (non-MCP, always open)
// ---------------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "aily-local-file-mcp",
    version: "0.2.0",
    mcpEndpoint: MCP_ENDPOINT,
    authEnabled: AUTH_ENABLED,
    tools: [
      "ping",
      "read_file",
      "write_file",
      "edit_file",
      "create_directory",
      "list_directory",
      "move_file",
      "search_files",
      "get_file_info",
      "list_allowed_directories",
    ],
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Trash cleanup — runs every hour
// ---------------------------------------------------------------------------

setInterval(() => {
  const purged = cleanupTrash();
  if (purged > 0) {
    console.log(`[trash] Purged ${purged} expired entries`);
  }
}, 60 * 60 * 1000); // 1 hour

// Initial cleanup on startup
setTimeout(() => cleanupTrash(), 5000);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  console.log(`[aily-local-file-mcp] Server running on http://${HOST}:${PORT}`);
  console.log(`[aily-local-file-mcp] MCP endpoint: http://${HOST}:${PORT}${MCP_ENDPOINT}`);
  console.log(`[aily-local-file-mcp] Health check: http://${HOST}:${PORT}/health`);
  console.log(`[aily-local-file-mcp] Auth: ${AUTH_ENABLED ? "ENABLED (Bearer token required)" : "DISABLED (no token set)"}`);
  console.log(`[aily-local-file-mcp] Phase 1-3 ready — 10 tools registered (ping + 9 filesystem tools)`);
  console.log(`[aily-local-file-mcp] Security: path guard, file guard, rate limit, audit log, soft-delete`);
});
