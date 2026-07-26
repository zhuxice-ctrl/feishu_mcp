/**
 * aily-local-file-mcp — Phase 1: HTTP MCP Server skeleton
 *
 * Provides a Streamable HTTP MCP server with a health-check tool,
 * ready for Phase 2 (file system tools) and Phase 3 (security layer).
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Express, Request, Response } from "express";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || "/mcp";

// ---------------------------------------------------------------------------
// MCP server factory
//
// createMcpHandler calls this factory once per HTTP request, producing a fresh
// McpServer instance. Define tools / resources / prompts here — they will be
// available on every request.
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "aily-local-file-mcp",
    version: "0.1.0",
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

  return server;
}

// ---------------------------------------------------------------------------
// Create MCP HTTP handler (web-standard fetch shape)
// ---------------------------------------------------------------------------

const handler = createMcpHandler(createMcpServer);

// ---------------------------------------------------------------------------
// Express app with security middleware (DNS rebinding / origin validation)
// ---------------------------------------------------------------------------

const app: Express = createMcpExpressApp({ host: HOST });

// ---------------------------------------------------------------------------
// MCP route — bridges Express ↔ Web Standard Request/Response
// ---------------------------------------------------------------------------

app.all(MCP_ENDPOINT, async (req: Request, res: Response) => {
  try {
    // Build a Web Standard Request from the Express request
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

    // Forward to the MCP handler
    const response = await handler.fetch(request, {
      parsedBody: hasBody ? req.body : undefined,
    });

    // Write status + headers back to Express
    res.status(response.status);
    response.headers.forEach((value, key) => {
      // Express manages transfer-encoding itself
      if (key.toLowerCase() !== "transfer-encoding") {
        res.setHeader(key, value);
      }
    });

    // Stream the body (handles both JSON and SSE responses)
    if (response.body) {
      // Flush headers immediately for SSE
      if (
        response.headers
          .get("content-type")
          ?.includes("text/event-stream")
      ) {
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
        // Stream interrupted — client likely disconnected
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
// Health check endpoint (non-MCP)
// ---------------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "aily-local-file-mcp",
    version: "0.1.0",
    mcpEndpoint: MCP_ENDPOINT,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  console.log(`[aily-local-file-mcp] Server running on http://${HOST}:${PORT}`);
  console.log(`[aily-local-file-mcp] MCP endpoint: http://${HOST}:${PORT}${MCP_ENDPOINT}`);
  console.log(`[aily-local-file-mcp] Health check: http://${HOST}:${PORT}/health`);
  console.log(`[aily-local-file-mcp] Phase 1 skeleton ready — ping tool registered`);
});
