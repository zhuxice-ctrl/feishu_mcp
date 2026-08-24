/**
 * Owner-only workspace context MCP tool.
 *
 * `workspace_context` composes the trusted catalog, the owner-scoped context
 * store, and the pure route planner into one strict, root-free contract. It
 * never accepts a path, command, URL, environment, or task identifier and
 * never returns an absolute root, a raw user ID, or another owner's context.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { LOCAL_WORKSPACE_CATALOG_PATH, OWNER_USER_ID } from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import {
  loadLocalWorkspaceCatalog,
  findWorkspace,
  publicCatalog,
} from "../development/workspaces/catalog.js";
import type { WorkspaceCatalog } from "../development/workspaces/types.js";
import {
  WorkspaceContextStore,
  WorkspaceContextError,
} from "../development/workspaces/context.js";
import type { WorkspaceContext } from "../development/workspaces/contextTypes.js";
import type { WorkspaceHints } from "../development/workspaces/types.js";
import {
  planWorkspaceRoute,
  boundedCandidates,
} from "../development/workspaces/routing.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export const workspaceContextInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("bootstrap"),
      workspaceId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      workspaceId: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      action: z.literal("get"),
      contextId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark_instructions_read"),
      contextId: z.string().uuid(),
      files: z.array(z.string().min(1).max(512)).max(16),
    })
    .strict(),
  z
    .object({ action: z.literal("clear"), contextId: z.string().uuid() })
    .strict(),
]);

export type WorkspaceContextInput = z.infer<typeof workspaceContextInputSchema>;

export interface WorkspaceContextToolDeps {
  catalogPath?: string;
  store: WorkspaceContextStore;
  ownerKey: (userId: string) => string;
  hasAccess: (userId: string, workspaceRoot: string) => boolean;
  userId?: () => string | null;
}

function currentUserId(deps: WorkspaceContextToolDeps): string | null {
  return deps.userId?.() ?? getRequestUserId();
}

function respondOk(
  ctx: WorkspaceContext,
  hints: WorkspaceHints,
  label: string,
) {
  return toolJson({
    ok: true,
    contextId: ctx.contextId,
    workspaceId: ctx.workspaceId,
    label,
    phase: ctx.phase,
    instructionFilesRead: ctx.instructionFilesRead,
    route: planWorkspaceRoute(hints, ctx.phase, ctx.workspaceId),
    workspace: {
      ecosystems: hints.ecosystems,
      instructionFiles: hints.instructionFiles,
      capabilities: hints.capabilities,
    },
  });
}

function selectionRequired(catalog: WorkspaceCatalog) {
  return toolError(
    "WORKSPACE_SELECTION_REQUIRED",
    "Select a workspace before continuing.",
    false,
    {},
    {
      tool: "workspace_context",
      action: "bootstrap",
      reason: "No unexpired unambiguous workspace context exists.",
    },
    boundedCandidates(publicCatalog(catalog).workspaces),
  );
}

function contextNotFound() {
  return toolError(
    "WORKSPACE_CONTEXT_NOT_FOUND",
    "No active context for this owner.",
    false,
    {},
    {
      tool: "workspace_context",
      action: "bootstrap",
      reason: "Create a context first.",
    },
  );
}

function contextStale() {
  return toolError(
    "WORKSPACE_CONTEXT_STALE",
    "The workspace catalog changed.",
    false,
    {},
    {
      tool: "workspace_context",
      action: "bootstrap",
      reason: "Reselect the workspace to refresh the context.",
    },
  );
}

function resolveForContext(
  userId: string,
  ownerKey: string,
  deps: WorkspaceContextToolDeps,
  catalog: WorkspaceCatalog,
  digest: string,
  workspaceId: string,
) {
  const workspace = findWorkspace(catalog, workspaceId);
  if (!workspace) {
    return toolError(
      "WORKSPACE_CONTEXT_NOT_FOUND",
      `Unknown workspace: ${workspaceId}.`,
      false,
      {},
      {
        tool: "workspace_context",
        action: "bootstrap",
        reason: "The workspace ID is not in the trusted catalog.",
      },
    );
  }
  if (!deps.hasAccess(userId, workspace.root)) {
    return toolError(
      "WORKSPACE_NOT_AUTHORIZED",
      "The selected workspace is not currently authorized.",
      false,
      {},
      {
        tool: "auth",
        action: "directoryApproval",
        reason: "Authorize the workspace root through the directory approval route.",
      },
    );
  }
  const ctx = deps.store.upsert(ownerKey, workspaceId, digest);
  return respondOk(ctx, workspace.hints, workspace.label);
}

function bootstrapAction(
  userId: string,
  ownerKey: string,
  deps: WorkspaceContextToolDeps,
  catalog: WorkspaceCatalog,
  digest: string,
  workspaceId?: string,
) {
  if (workspaceId !== undefined) {
    return resolveForContext(userId, ownerKey, deps, catalog, digest, workspaceId);
  }
  const result = deps.store.findUnambiguous(ownerKey);
  if (result === "none" || result === "ambiguous") {
    return selectionRequired(catalog);
  }
  const workspace = findWorkspace(catalog, result.workspaceId);
  if (!workspace || result.catalogDigest !== digest) {
    return contextStale();
  }
  return respondOk(result, workspace.hints, workspace.label);
}

function getAction(
  ownerKey: string,
  deps: WorkspaceContextToolDeps,
  catalog: WorkspaceCatalog,
  digest: string,
  contextId?: string,
) {
  let ctx: WorkspaceContext | undefined;
  if (contextId !== undefined) {
    ctx = deps.store.get(ownerKey, contextId);
    if (!ctx) return contextNotFound();
  } else {
    const result = deps.store.findUnambiguous(ownerKey);
    if (result === "none" || result === "ambiguous") {
      return selectionRequired(catalog);
    }
    ctx = result;
  }
  if (ctx.catalogDigest !== digest) return contextStale();
  const workspace = findWorkspace(catalog, ctx.workspaceId);
  if (!workspace) return contextStale();
  return respondOk(ctx, workspace.hints, workspace.label);
}

function markInstructionsReadAction(
  ownerKey: string,
  deps: WorkspaceContextToolDeps,
  catalog: WorkspaceCatalog,
  digest: string,
  contextId: string,
  files: string[],
) {
  const ctx = deps.store.get(ownerKey, contextId);
  if (!ctx) return contextNotFound();
  if (ctx.catalogDigest !== digest) return contextStale();
  const workspace = findWorkspace(catalog, ctx.workspaceId);
  if (!workspace) return contextStale();
  try {
    const updated = deps.store.markInstructionsRead(
      ownerKey,
      contextId,
      workspace.hints.instructionFiles,
      files,
    );
    return respondOk(updated, workspace.hints, workspace.label);
  } catch (error) {
    if (error instanceof WorkspaceContextError) {
      return toolError(
        "INSTRUCTION_FILE_INVALID",
        error.message,
        false,
        {},
        { tool: "read_file", reason: "Read only declared instruction files." },
      );
    }
    throw error;
  }
}

function clearAction(
  ownerKey: string,
  deps: WorkspaceContextToolDeps,
  contextId: string,
) {
  deps.store.clear(ownerKey, contextId);
  return toolJson({ ok: true, contextId, cleared: true });
}

export async function workspaceContext(
  args: WorkspaceContextInput,
  deps: WorkspaceContextToolDeps,
) {
  const userId = currentUserId(deps);
  if (!userId || userId !== OWNER_USER_ID) {
    return toolError(
      "OWNER_REQUIRED",
      "This tool is restricted to the configured owner.",
    );
  }
  const catalogPath = deps.catalogPath ?? LOCAL_WORKSPACE_CATALOG_PATH;
  let catalog: WorkspaceCatalog;
  let digest: string;
  try {
    const loaded = loadLocalWorkspaceCatalog(catalogPath);
    catalog = loaded.catalog;
    digest = loaded.digest;
  } catch {
    return toolError("INVALID_ARGUMENT", "Local workspace catalog is not available.");
  }
  const ownerKey = deps.ownerKey(userId);

  switch (args.action) {
    case "bootstrap":
      return bootstrapAction(userId, ownerKey, deps, catalog, digest, args.workspaceId);
    case "select":
      return bootstrapAction(userId, ownerKey, deps, catalog, digest, args.workspaceId);
    case "get":
      return getAction(ownerKey, deps, catalog, digest, args.contextId);
    case "mark_instructions_read":
      return markInstructionsReadAction(
        ownerKey,
        deps,
        catalog,
        digest,
        args.contextId,
        args.files,
      );
    case "clear":
      return clearAction(ownerKey, deps, args.contextId);
  }
}

export function registerWorkspaceContextTool(
  server: McpServer,
  deps: WorkspaceContextToolDeps,
): void {
  server.registerTool(
    "workspace_context",
    {
      description:
        "Select and resume an owner-scoped trusted workspace. `bootstrap` " +
        "resolves a workspace ID or, without one, returns the single active " +
        "context or bounded root-free candidates. `select` explicitly selects. " +
        "`get` returns the caller's context and deterministic route. " +
        "`mark_instructions_read` acknowledges declared instruction files and " +
        "advances the phase. `clear` removes the caller's context. The tool " +
        "returns root-free route plans: Android work routes to " +
        "android_development, fixed Node verification to run_local_workflow, " +
        "never generic shell execution.",
      inputSchema: workspaceContextInputSchema,
    },
    async (args) =>
      authorizeOwnerToolCall("workspace_context", args) ??
      runTool(
        {
          name: "workspace_context",
          concurrency: "default",
          subject: {
            kind: "development",
            key: "workspace_context",
            display: "workspace context",
          },
        },
        async () => workspaceContext(args, deps),
      ),
  );
}