/**
 * feishu_mcp — Main entry point
 *
 * Streamable HTTP MCP server that exposes local filesystem to Feishu Aily.
 * Uses ngrok for public tunneling (replaces Cloudflare Tunnel).
 *
 * Refactor notes (2026-07):
 *   - Per-request token now flows through AsyncLocalStorage (security/requestContext)
 *     instead of a module-level `currentToken` variable, which previously raced
 *     across concurrent requests and stuck the last value forever.
 *   - Server identity (name / version) is sourced from config.ts — one place
 *     to change.
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  AUTH_ENABLED,
  HOST,
  MCP_ENDPOINT,
  PORT,
  SERVER_NAME,
  SERVER_VERSION,
} from "./config.js";
import { authMiddleware } from "./security/auth.js";
import { runWithToken } from "./security/requestContext.js";
import { cleanupTrash } from "./security/trash.js";
import { registerFilesystemTools } from "./tools/filesystem.js";

// ---------------------------------------------------------------------------
// MCP server factory — one fresh instance per request
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // --- Health verification tool ---
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
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: `pong${args.message ? `: ${args.message}` : ""}`,
        },
      ],
    })
  );

  // --- Filesystem tools (9 tools, token read from AsyncLocalStorage) ---
  registerFilesystemTools(server);

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
// The middleware stashes the validated token on the request object, and the
// route handler below wraps the MCP fetch call in runWithToken() so every
// tool handler sees the right token via AsyncLocalStorage.
app.all(MCP_ENDPOINT, authMiddleware);

// --- MCP route handler ---------------------------------------------------

app.all(MCP_ENDPOINT, async (req: Request, res: Response) => {
  const token = (req as Request & { authToken?: string }).authToken ?? "";

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

    // Propagate the validated token into the async context for the duration
    // of this request.  The MCP handler and every tool it calls will read
    // it via getRequestToken().
    const response = await runWithToken(token, () =>
      handler.fetch(request, {
        parsedBody: hasBody ? req.body : undefined,
      })
    );

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
    service: SERVER_NAME,
    version: SERVER_VERSION,
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
  console.log(`[${SERVER_NAME}] Server running on http://${HOST}:${PORT}`);
  console.log(`[${SERVER_NAME}] MCP endpoint: http://${HOST}:${PORT}${MCP_ENDPOINT}`);
  console.log(`[${SERVER_NAME}] Health check: http://${HOST}:${PORT}/health`);
  console.log(
    `[${SERVER_NAME}] Auth: ${AUTH_ENABLED ? "ENABLED (Bearer token required)" : "DISABLED (no token set)"}`
  );
  console.log(`[${SERVER_NAME}] 10 tools registered (ping + 9 filesystem tools)`);
  console.log(`[${SERVER_NAME}] Security: path guard, file guard, rate limit, audit log, soft-delete`);
});
