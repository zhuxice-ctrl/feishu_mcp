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
  ALLOWED_DIRS,
  APPROVAL_TIMEOUT_MS,
  AUTH_ENABLED,
  AUTH_MODE,
  HOST,
  MCP_ENDPOINT,
  NGROK_DOMAIN,
  PORT,
  SERVER_NAME,
  SERVER_VERSION,
} from "./config.js";
import { registerAuthTool } from "./auth/authTool.js";
import { summary as authSummary } from "./auth/pinAuth.js";
import { authMiddleware, corsPreflight } from "./security/auth.js";
import { logger } from "./security/logger.js";
import {
  extractRequestContext,
  runWithRequestContext,
} from "./security/requestContext.js";
import {
  authorizeToolCall,
  toolAuthorizationMiddleware,
} from "./security/toolAccess.js";
import { consentGate } from "./security/consent.js";
import { approvalStateCodec } from "./security/approvalState.js";
import { cleanupTrash } from "./security/trash.js";
import { registerFilesystemTools } from "./tools/filesystem.js";

// ---------------------------------------------------------------------------
// MCP server factory — one fresh instance per request
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      inputRequired: {
        maxRounds: 4,
        roundTimeoutMs: APPROVAL_TIMEOUT_MS,
        legacyShim: true,
      },
      requestState: { verify: approvalStateCodec.verify },
    },
  );

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
    async (args) => {
      const accessError = authorizeToolCall("ping", args);
      if (accessError) return accessError;
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

  // --- Filesystem tools (9 tools, token read from AsyncLocalStorage) ---
  registerFilesystemTools(server);
  registerAuthTool(server);

  return server;
}

// ---------------------------------------------------------------------------
// Create MCP HTTP handler
// ---------------------------------------------------------------------------

const handler = createMcpHandler(createMcpServer);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const allowedRequestHosts = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  HOST,
  NGROK_DOMAIN,
].filter((value, index, values) => value && values.indexOf(value) === index);

const app: Express = createMcpExpressApp({
  host: HOST,
  allowedHosts: allowedRequestHosts,
  allowedOrigins: allowedRequestHosts,
});

app.all(MCP_ENDPOINT, corsPreflight);

// --- Auth + rate-limit middleware (Phase 3) ------------------------------
// Applied only to the MCP endpoint; /health remains open for monitoring.
// The middleware stashes the validated token on the request object, and the
// route handler below wraps the MCP fetch call in runWithRequestContext() so
// every tool handler sees the right transport credential and identity.
app.all(MCP_ENDPOINT, authMiddleware);
app.all(MCP_ENDPOINT, toolAuthorizationMiddleware);

// --- MCP route handler ---------------------------------------------------

app.all(MCP_ENDPOINT, async (req: Request, res: Response) => {
  const context = extractRequestContext(req);

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

    // Keep transport credentials and identity scoped to this handler call.
    const response = await runWithRequestContext(context, () =>
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
    logger.error("mcp_handler_error", {
      error,
      userId: context.userId,
      email: context.email,
    });
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
    authMode: AUTH_MODE,
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
      "auth",
    ],
    auth: authSummary(),
    consent: consentGate.summary(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Trash cleanup — runs every hour
// ---------------------------------------------------------------------------

setInterval(() => {
  const purged = cleanupTrash();
  if (purged > 0) {
    logger.info("trash_cleanup_completed", { purged });
  }
}, 60 * 60 * 1000); // 1 hour

// Initial cleanup on startup
setTimeout(() => cleanupTrash(), 5000);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  const lines = [
    `${SERVER_NAME} v${SERVER_VERSION}`,
    `Server: http://${HOST}:${PORT}`,
    `MCP endpoint: http://${HOST}:${PORT}${MCP_ENDPOINT}`,
    `Health check: http://${HOST}:${PORT}/health`,
    `Allowed directories: ${ALLOWED_DIRS.join(", ") || "none"}`,
    `Bearer transport auth: ${AUTH_ENABLED ? "enabled" : "disabled"}`,
    `Tool auth mode: ${AUTH_MODE}`,
    `Consent: ${JSON.stringify(consentGate.summary())}`,
    `Terminal interactive: ${consentGate.isInteractive() ? "yes" : "no"}`,
    "Tools: 11 (ping, 9 filesystem tools, auth)",
  ];
  if (AUTH_MODE === "pin") lines.push("PIN: configured via AUTH_PIN (value hidden)");
  process.stderr.write(`${lines.join("\n")}\n`);
});
