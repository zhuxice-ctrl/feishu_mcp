/** Owner-only API for safe, catalog-declared local development servers. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { LOCAL_WORKSPACE_CATALOG_PATH, OWNER_USER_ID } from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import type { DevelopmentTaskCoordinator } from "../development/tasks/coordinator.js";
import { loadLocalWorkspaceCatalog, findWorkspace } from "../development/workspaces/catalog.js";
import { findDevServer } from "../development/servers/catalog.js";
import { buildServerLaunchPlan } from "../development/servers/adapters.js";
import { assertPermittedPort, assertPortAvailable, publicServerUrls } from "../development/servers/network.js";
import { getDevelopmentTask, listDevelopmentTasks, readDevelopmentTaskLogs } from "./developmentTasks.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), workspaceId: z.string().regex(/^[a-z0-9_-]{1,64}$/), serviceId: z.string().regex(/^[a-z0-9_-]{1,64}$/), port: z.number().int().min(1).max(65_535), scope: z.enum(["local", "lan"]) }).strict(),
  z.object({ action: z.literal("status"), taskId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("logs"), taskId: z.string().uuid(), stream: z.enum(["stdout", "stderr", "both"]).optional(), cursorStdout: z.number().int().min(0).optional(), cursorStderr: z.number().int().min(0).optional() }).strict(),
  z.object({ action: z.literal("stop"), taskId: z.string().uuid() }).strict(),
]);
export type LocalDevServerArgs = z.infer<typeof actionSchema>;
export interface LocalDevServerDeps { coordinator: DevelopmentTaskCoordinator; catalogPath?: string; userId?: () => string | null; }
const currentUser = (deps: LocalDevServerDeps) => deps.userId?.() ?? getRequestUserId();

export async function localDevServer(args: LocalDevServerArgs, deps: LocalDevServerDeps) {
  const userId = currentUser(deps);
  if (!userId || userId !== OWNER_USER_ID) return toolError("OWNER_REQUIRED", "This tool is restricted to the configured owner.");
  if (args.action === "status") return getDevelopmentTask({ taskId: args.taskId }, { coordinator: deps.coordinator, userId: () => userId });
  if (args.action === "list") return listDevelopmentTasks({ state: undefined }, { coordinator: deps.coordinator, userId: () => userId });
  if (args.action === "logs") return readDevelopmentTaskLogs(args, { coordinator: deps.coordinator, userId: () => userId });
  if (args.action === "stop") {
    try { const result = deps.coordinator.cancel(args.taskId, developmentOwnerKey(userId)); return toolJson({ ok: true, taskId: args.taskId, ...result }); }
    catch { return toolError("TASK_NOT_FOUND", "Development task not found."); }
  }
  let loaded;
  try { loaded = loadLocalWorkspaceCatalog(deps.catalogPath ?? LOCAL_WORKSPACE_CATALOG_PATH); } catch { return toolError("INVALID_ARGUMENT", "Local workspace catalog is not available."); }
  const workspace = findWorkspace(loaded.catalog, args.workspaceId);
  const service = workspace && findDevServer(workspace, args.serviceId);
  if (!workspace || !service) return toolError("INVALID_ARGUMENT", "Unknown workspace or local server service.");
  if (!directoryGrantStore.hasAccess(userId, workspace.root)) return toolError("OUTSIDE_ALLOWED_DIRS", "The selected workspace is not currently authorized.");
  if (!service.scopes.includes(args.scope)) return toolError("INVALID_ARGUMENT", "The selected service does not permit that network scope.");
  try {
    assertPermittedPort(args.port, service.portRange, { min: 1024, max: 9_999 });
    await assertPortAvailable(args.port);
    const plan = buildServerLaunchPlan(service, { port: args.port, scope: args.scope });
    const urls = publicServerUrls(args.port, args.scope);
    const record = deps.coordinator.enqueueServer({
      ownerKey: developmentOwnerKey(userId), tool: "local_dev_server", action: "start", class: "default",
      resources: [`workspace:${workspace.id}`, `port:${args.port}`],
      server: { ...plan, timeoutMs: 8 * 60 * 60_000, successExitCodes: [0], startupTimeoutMs: 60_000,
        server: { serviceId: service.id, runtime: service.runtime, scope: args.scope, port: args.port, localUrl: urls.localUrl, ...(plan.healthPath === undefined ? {} : { healthPath: plan.healthPath }) } },
      lanUrls: urls.lanUrls,
    });
    return toolJson({ ok: true, taskId: record.id, state: record.state, serviceId: service.id, scope: args.scope, localUrl: urls.localUrl, lanUrls: urls.lanUrls });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Local server could not be started.";
    return toolError("INVALID_ARGUMENT", text);
  }
}

export function registerLocalDevServerTool(server: McpServer, coordinator: DevelopmentTaskCoordinator): void {
  server.registerTool("local_dev_server", { description: "Start, observe, read logs for, or stop an owner-approved catalog-declared local or LAN development server. It never accepts commands and never publishes a development server through Cloudflare.", inputSchema: actionSchema }, async (args) =>
    authorizeOwnerToolCall("local_dev_server", args) ?? runTool({ name: "local_dev_server", concurrency: "command", subject: { kind: "development", key: "local-server", display: "local development server" } }, () => localDevServer(args, { coordinator })));
}
