import fs from "node:fs";
import path from "node:path";
import { loadLocalWorkspaceCatalog, findWorkspace } from "./catalog.js";
import type { Workspace, WorkspaceCatalog } from "./types.js";
import type { WorkspaceContext } from "./contextTypes.js";
import { WorkspaceContextStore } from "./context.js";
import { LOCAL_WORKSPACE_CATALOG_PATH } from "../../config.js";
import { developmentOwnerKey } from "../tasks/ownerKey.js";
import { toolError } from "../../tools/results.js";

export interface WorkspaceExecutionDeps {
  catalogPath?: string;
  store: WorkspaceContextStore;
  ownerKey?: (userId: string) => string;
  userId?: string;
  hasAccess?: (userId: string, root: string) => boolean;
  loadCatalog?: (catalogPath: string) => { catalog: WorkspaceCatalog; digest: string };
}

export type WorkspaceExecutionResult =
  | { ok: true; workspace: Workspace; context: WorkspaceContext; workdir: string }
  | { ok: false; result: ReturnType<typeof toolError> };

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate the selected, owner-scoped context before any development action. */
export function requireWorkspaceExecutionContext(
  deps: WorkspaceExecutionDeps,
  input: { workspaceId: string; contextId: string; workdir: string },
): WorkspaceExecutionResult {
  const userId = deps.userId ?? "";
  const ownerKey = (deps.ownerKey ?? developmentOwnerKey)(userId);
  let loaded: { catalog: WorkspaceCatalog; digest: string };
  try {
    loaded = (deps.loadCatalog ?? loadLocalWorkspaceCatalog)(deps.catalogPath ?? LOCAL_WORKSPACE_CATALOG_PATH);
  } catch {
    return { ok: false, result: toolError("WORKSPACE_CONTEXT_NOT_FOUND", "Local workspace catalog is not available.", false, {}, { tool: "workspace_context", action: "bootstrap", reason: "Create a workspace context first." }) };
  }
  const context = deps.store.get(ownerKey, input.contextId);
  if (!context) {
    return { ok: false, result: toolError("WORKSPACE_CONTEXT_NOT_FOUND", "Workspace context was not found or has expired.", false, {}, { tool: "workspace_context", action: "bootstrap", reason: "Select the workspace again." }) };
  }
  if (context.catalogDigest !== loaded.digest) {
    return { ok: false, result: toolError("WORKSPACE_CONTEXT_STALE", "Workspace catalog changed; refresh the context.", false, {}, { tool: "workspace_context", action: "bootstrap", reason: "Reselect the workspace." }) };
  }
  if (context.workspaceId !== input.workspaceId) {
    return { ok: false, result: toolError("WORKSPACE_MISMATCH", "The request workspace does not match the selected context.", false, {}, { tool: "workspace_context", action: "select", reason: "Select the requested workspace." }) };
  }
  if (context.phase === "selected") {
    return { ok: false, result: toolError("WORKSPACE_INSTRUCTIONS_REQUIRED", "Read the declared instruction files before execution.", false, {}, { tool: "workspace_context", action: "mark_instructions_read", reason: "Acknowledge all declared instruction files." }) };
  }
  const workspace = findWorkspace(loaded.catalog, input.workspaceId);
  if (!workspace) {
    return { ok: false, result: toolError("WORKSPACE_MISMATCH", "Workspace is not present in the trusted catalog.") };
  }
  if (deps.hasAccess && !deps.hasAccess(userId, workspace.root)) {
    return { ok: false, result: toolError("WORKSPACE_NOT_AUTHORIZED", "The selected workspace is not authorized.", false, {}, { tool: "auth", action: "directoryApproval", reason: "Authorize the workspace root." }) };
  }
  const requested = path.resolve(input.workdir);
  let canonicalRoot = workspace.root;
  let canonicalWorkdir = requested;
  try {
    canonicalRoot = fs.realpathSync.native(workspace.root);
    canonicalWorkdir = fs.existsSync(requested) ? fs.realpathSync.native(requested) : requested;
  } catch {
    return { ok: false, result: toolError("WORKSPACE_NOT_AUTHORIZED", "The working directory cannot be resolved.") };
  }
  if (!inside(canonicalRoot, canonicalWorkdir)) {
    return { ok: false, result: toolError("WORKSPACE_NOT_AUTHORIZED", "workdir must be inside the selected workspace.", false, {}, { tool: "workspace_context", action: "select", reason: "Use a directory within the selected workspace." }) };
  }
  return { ok: true, workspace, context, workdir: canonicalWorkdir };
}
