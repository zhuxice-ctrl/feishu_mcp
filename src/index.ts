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
  APPROVAL_DATA_DIR,
  APPROVAL_TIMEOUT_MS,
  AUTH_ENABLED,
  AUTH_MODE,
  DEV_MAX_BUILDS,
  DEV_MAX_TASKS,
  DEV_TASK_DATA_DIR,
  DEV_TASK_QUEUE_TIMEOUT_MS,
  DIRECTORY_APPROVAL_FALLBACK,
  HOST,
  MCP_ENDPOINT,
  NGROK_DOMAIN,
  OWNER_DEFAULT_DIRS,
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
import { approvalStore } from "./security/approvalStore.js";
import { approvalStateCodec } from "./security/approvalState.js";
import { cleanupTrash } from "./security/trash.js";
import { directoryGrantStore } from "./security/directoryGrantStore.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DevelopmentTaskCoordinator } from "./development/tasks/coordinator.js";
import { DevelopmentTaskScheduler } from "./development/tasks/scheduler.js";
import { DevelopmentTaskStore } from "./development/tasks/store.js";
import { registerAskUserTool } from "./tools/askUser.js";
import { registerCommandTool } from "./tools/command.js";
import { concurrencySummary } from "./tools/concurrency.js";
import { registerContentSearchTool } from "./tools/contentSearch.js";
import { registerDevelopmentTaskTools } from "./tools/developmentTasks.js";
import {
  createDevelopmentEnvironmentSubsystem,
  registerDevelopmentEnvironmentTools,
} from "./tools/developmentEnvironment.js";
import { registerAndroidDevelopmentTool } from "./tools/androidDevelopment.js";
import { registerWindowsDevelopmentTool } from "./tools/windowsDevelopment.js";
import { registerDevelopmentProjectTool } from "./tools/developmentProjects.js";
import { AndroidProjectProvider } from "./development/android/projectProvider.js";
import { installReviewedGradleWrapper } from "./development/android/wrapperAssets.js";
import { DotnetProjectProvider } from "./development/windows/dotnetProjectProvider.js";
import { NativeProjectProvider } from "./development/windows/nativeProjectProvider.js";
import { ElectronProjectProvider } from "./development/windows/electronProjectProvider.js";
import { ProjectRegistry } from "./development/projects/registry.js";
import { LocalCredentialStore } from "./development/credentials/dpapiStore.js";
import { registerDiffTool } from "./tools/diff.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerGitTools } from "./tools/git.js";
import { registerPatchTool } from "./tools/patch.js";
import { runTool } from "./tools/registry.js";
import { registerTodoTools } from "./tools/todo.js";
import { registerWebFetchTool } from "./tools/webFetch.js";

const TOOL_NAMES = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
  "get_development_task", "read_development_task_logs", "cancel_development_task",
  "inspect_development_environment", "plan_environment_changes", "apply_environment_plan",
  "android_development",
  "windows_development",
  "manage_development_project",
] as const;

const SERVER_INSTRUCTIONS =
  "Complete local development MCP for Feishu. When a tool returns " +
  "DIRECTORY_APPROVAL_REQUIRED, show its directories and four decisions to the owner, " +
  "wait for an explicit choice, submit the signed challenge through auth.directoryApproval, " +
  "then immediately retry the original tool with identical arguments. Never suggest editing " +
  "ALLOWED_DIRS or restarting the service for this error.";

// ---------------------------------------------------------------------------
// Development task subsystem — one coordinator per process
// ---------------------------------------------------------------------------

const developmentTaskCoordinator = new DevelopmentTaskCoordinator(
  new DevelopmentTaskStore(DEV_TASK_DATA_DIR),
  new DevelopmentTaskScheduler({
    total: DEV_MAX_TASKS,
    builds: DEV_MAX_BUILDS,
    queueTimeoutMs: DEV_TASK_QUEUE_TIMEOUT_MS,
  }),
  { approvalDataDir: APPROVAL_DATA_DIR },
);

// ---------------------------------------------------------------------------
// Development environment subsystem — trusted toolchain provisioning
// ---------------------------------------------------------------------------

const developmentEnvironment = createDevelopmentEnvironmentSubsystem();

// ---------------------------------------------------------------------------
// Android development subsystem — project provider + credential store
// ---------------------------------------------------------------------------

const projectRegistry = new ProjectRegistry();
const generateReviewedGradleWrapper = (stagingDir: string, gradleVersion: string) =>
  installReviewedGradleWrapper(stagingDir, gradleVersion, developmentEnvironment.catalog);
projectRegistry.register(
  new AndroidProjectProvider({
    generateWrapper: generateReviewedGradleWrapper,
  }),
);
const androidCredentialStore = new LocalCredentialStore(APPROVAL_DATA_DIR);

// ---------------------------------------------------------------------------
// Windows development subsystem — project providers + shared credential store
// ---------------------------------------------------------------------------

projectRegistry.register(new DotnetProjectProvider({
  runDotnet: (args) => {
    const r = spawnSync("dotnet", args, { encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: r.stdout ?? "", exitCode: r.status };
  },
}));
projectRegistry.register(new NativeProjectProvider({}));
projectRegistry.register(new ElectronProjectProvider({}));
const windowsCredentialStore = new LocalCredentialStore(APPROVAL_DATA_DIR);

// ---------------------------------------------------------------------------
// MCP server factory — one fresh instance per request
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
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
      return runTool(
        {
          name: "ping",
          concurrency: "default",
          subject: { kind: "path", key: "service", display: "service" },
        },
        async () => ({
          content: [
            {
              type: "text" as const,
              text: `pong${args.message ? `: ${args.message}` : ""}`,
            },
          ],
        }),
      );
    }
  );

  // --- Filesystem tools (9 tools, token read from AsyncLocalStorage) ---
  registerFilesystemTools(server);
  registerAuthTool(server);
  registerCommandTool(server);
  registerContentSearchTool(server);
  registerGitTools(server);
  registerDiffTool(server);
  registerPatchTool(server);
  registerWebFetchTool(server);
  registerTodoTools(server);
  registerAskUserTool(server);
  registerDevelopmentTaskTools(server, developmentTaskCoordinator);
  registerDevelopmentEnvironmentTools(server, developmentEnvironment);
  registerAndroidDevelopmentTool(server, {
    coordinator: developmentTaskCoordinator,
    inspector: developmentEnvironment.inspector,
    projectProvider: projectRegistry.get("android"),
    credentialStore: androidCredentialStore,
    generateWrapper: generateReviewedGradleWrapper,
  });
  registerWindowsDevelopmentTool(server, {
    coordinator: developmentTaskCoordinator,
    inspector: developmentEnvironment.inspector,
    dotnetProvider: projectRegistry.get("dotnet"),
    nativeProvider: projectRegistry.get("native"),
    electronProvider: projectRegistry.get("electron"),
    credentialStore: windowsCredentialStore,
  });
  registerDevelopmentProjectTool(server, { registry: projectRegistry });

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
    toolCount: TOOL_NAMES.length,
    tools: TOOL_NAMES,
    auth: authSummary(),
    approval: {
      mode: "feishu_input_required",
      choices: ["allow_once", "allow_session", "allow_permanent", "deny"],
      stored: approvalStore.summary(),
      unsupportedClientPolicy: "deny",
    },
    directoryAuthorization: {
      enabled: true,
      ownerDefaults: OWNER_DEFAULT_DIRS.length,
      ...directoryGrantStore.summary(),
      unsupportedClientPolicy: "deny",
      fallback: DIRECTORY_APPROVAL_FALLBACK,
    },
    concurrency: concurrencySummary(),
    developmentTasks: developmentTaskCoordinator.healthSummary(),
    developmentEnvironment: {
      catalogVersion: developmentEnvironment.catalog.version,
      brokerState: developmentEnvironment.brokerState,
      plans: developmentEnvironment.planStore.summary(),
    },
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
// Development task retention — initial pass after recovery, then hourly
// ---------------------------------------------------------------------------

const purgeDevelopmentTasks = (): void => {
  const result = developmentTaskCoordinator.cleanup();
  if (result.removed > 0) {
    logger.info("development_task_cleanup_completed", { ...result });
  }
};

purgeDevelopmentTasks();
setInterval(purgeDevelopmentTasks, 60 * 60 * 1000); // 1 hour

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  const lines = [
    `${SERVER_NAME} v${SERVER_VERSION}`,
    `Server: http://${HOST}:${PORT}`,
    `MCP endpoint: http://${HOST}:${PORT}${MCP_ENDPOINT}`,
    `Health check: http://${HOST}:${PORT}/health`,
    `Configured static directory roots: ${ALLOWED_DIRS.length}`,
    `Bearer transport auth: ${AUTH_ENABLED ? "enabled" : "disabled"}`,
    `Tool auth mode: ${AUTH_MODE}`,
    "Approval: Feishu input_required (unsupported clients denied)",
    `Permanent approvals: ${approvalStore.summary().permanent}`,
    `Directory authorization: Feishu input_required (owner defaults ${OWNER_DEFAULT_DIRS.length}, permanent ${directoryGrantStore.summary().permanent})`,
    `Directory fallback: ${DIRECTORY_APPROVAL_FALLBACK}`,
    `Concurrency: ${JSON.stringify(concurrencySummary())}`,
    `Tools: ${TOOL_NAMES.length}`,
  ];
  if (AUTH_MODE === "pin") lines.push("PIN: configured via AUTH_PIN (value hidden)");
  process.stderr.write(`${lines.join("\n")}\n`);
});
