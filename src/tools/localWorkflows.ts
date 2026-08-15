/**
 * Owner-only local workflow MCP tools.
 *
 * `list_local_workspaces` returns the public (root-free) catalog view.
 * `run_local_workflow` requires the owner, validates the catalog and test
 * files, requests a single-use approval whose digest includes the recipe
 * digest and normalized tests, then enqueues one `kind: "workflow"` task.
 *
 * No caller-supplied command, argument, environment, workdir, or timeout is
 * accepted — only stable workspace/recipe IDs and a bounded list of test
 * file paths.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  LOCAL_WORKSPACE_CATALOG_PATH,
  OWNER_USER_ID,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import type { DevelopmentTaskCoordinator } from "../development/tasks/coordinator.js";
import {
  loadLocalWorkspaceCatalog,
  publicCatalog,
  findWorkspace,
  findRecipe,
  recipeDigest,
} from "../development/workspaces/catalog.js";
import { buildWorkflowLaunchSpec } from "../development/web/commands.js";
import { validateTestFiles, relativeTestPaths, TestFileError } from "../development/web/testFiles.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const WORKFLOW_TOTAL_TIMEOUT_MS = 30 * 60_000; // 30 minutes total

export interface LocalWorkflowToolDeps {
  coordinator: DevelopmentTaskCoordinator;
  catalogPath?: string;
  userId?: () => string | null;
}

function currentUserId(deps: LocalWorkflowToolDeps): string | null {
  return deps.userId?.() ?? getRequestUserId();
}

// ------------------------------------------------------- list workspaces ---

export async function listLocalWorkspaces(
  _args: Record<string, never>,
  deps: LocalWorkflowToolDeps,
) {
  const userId = currentUserId(deps);
  if (!userId || userId !== OWNER_USER_ID) {
    return toolError("OWNER_REQUIRED", "This tool is restricted to the configured owner.");
  }
  const catalogPath = deps.catalogPath ?? LOCAL_WORKSPACE_CATALOG_PATH;
  let catalog;
  try {
    const result = loadLocalWorkspaceCatalog(catalogPath);
    catalog = result.catalog;
  } catch {
    return toolError("INVALID_ARGUMENT", "Local workspace catalog is not available.");
  }
  return toolJson({ ok: true, ...publicCatalog(catalog) });
}

// -------------------------------------------------------- run workflow ---

export interface RunLocalWorkflowArgs {
  workspaceId: string;
  recipeId: string;
  testFiles?: string[];
}

export async function runLocalWorkflow(
  args: RunLocalWorkflowArgs,
  ctx: ServerContext,
  deps: LocalWorkflowToolDeps,
) {
  const userId = currentUserId(deps);
  if (!userId || userId !== OWNER_USER_ID) {
    return toolError("OWNER_REQUIRED", "This tool is restricted to the configured owner.");
  }

  // Load and validate the catalog.
  const catalogPath = deps.catalogPath ?? LOCAL_WORKSPACE_CATALOG_PATH;
  let loaded: ReturnType<typeof loadLocalWorkspaceCatalog>;
  try {
    loaded = loadLocalWorkspaceCatalog(catalogPath);
  } catch {
    return toolError("INVALID_ARGUMENT", "Local workspace catalog is not available.");
  }

  const workspace = findWorkspace(loaded.catalog, args.workspaceId);
  if (!workspace) {
    return toolError("INVALID_ARGUMENT", `Unknown workspace: ${args.workspaceId}`);
  }
  const recipe = findRecipe(workspace, args.recipeId);
  if (!recipe) {
    return toolError("INVALID_ARGUMENT", `Unknown recipe: ${args.recipeId}`);
  }
  if (!directoryGrantStore.hasAccess(userId, workspace.root)) {
    return toolError("OUTSIDE_ALLOWED_DIRS", "The selected workspace is not currently authorized.");
  }

  // Validate test files if the recipe includes a test_selected step.
  const hasTestStep = recipe.steps.some(
    (s) => s.kind === "test_selected" && s.enabled,
  );
  let testFiles: string[] = [];
  if (hasTestStep) {
    try {
      const validated = validateTestFiles(args.testFiles ?? [], workspace.root);
      testFiles = relativeTestPaths(validated, workspace.root);
    } catch (error) {
      if (error instanceof TestFileError) {
        return toolError("INVALID_ARGUMENT", error.message);
      }
      return toolError("INVALID_ARGUMENT", "Invalid test files.");
    }
  }

  // Build the workflow launch spec.
  const rDigest = recipeDigest(workspace, recipe);
  const launchSpec = buildWorkflowLaunchSpec(
    workspace.id,
    recipe.id,
    rDigest,
    workspace.root,
    recipe.steps,
    testFiles,
    WORKFLOW_TOTAL_TIMEOUT_MS,
    workspace.artifactDirs,
  );

  // Request single-use approval bound to the recipe digest and normalized tests.
  const ownerKey = developmentOwnerKey(userId);
  const subjectKey = createHash("sha256")
    .update(`${workspace.id}\u0000${recipe.id}\u0000${rDigest}\u0000${JSON.stringify(testFiles)}`)
    .digest("hex");
  const argsDigest = digestArguments(args);
  const approval = await requestApproval(ctx, {
    tool: "run_local_workflow",
    userId,
    subject: {
      kind: "development",
      key: subjectKey,
      display: `Verify ${workspace.label} / ${recipe.label}\nWorkspace: ${workspace.id}\nRecipe: ${recipe.id}`,
    },
    argsDigest,
    reasons: [`Run ${recipe.label} on ${workspace.label}.`],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  // Enqueue the workflow task.
  try {
    const record = deps.coordinator.enqueueWorkflow({
      ownerKey,
      tool: "run_local_workflow",
      action: recipe.id,
      class: "build",
      resources: [`workspace:${workspace.id}`],
      workflow: launchSpec,
    });
    return toolJson({
      ok: true,
      taskId: record.id,
      state: record.state,
      workspaceId: workspace.id,
      recipeId: recipe.id,
    });
  } catch {
    return toolError("TASK_QUEUE_FULL", "Development task queue is full.");
  }
}

// ----------------------------------------------------------- registration ---

export function registerLocalWorkflowTools(
  server: McpServer,
  coordinator: DevelopmentTaskCoordinator,
): void {
  server.registerTool(
    "list_local_workspaces",
    {
      description:
        "List the owner-configured local development workspaces and their " +
        "verification recipes. Returns workspace IDs, labels, and recipe step " +
        "configurations — never workspace roots, paths, or credentials.",
      inputSchema: {},
    },
    async (args) =>
      authorizeOwnerToolCall("list_local_workspaces", args) ??
      runTool(
        {
          name: "list_local_workspaces",
          concurrency: "default",
          subject: { kind: "development", key: "workspace", display: "local workspace catalog" },
        },
        async () => listLocalWorkspaces(args ?? {}, { coordinator }),
      ),
  );

  server.registerTool(
    "run_local_workflow",
    {
      description:
        "Run a fixed PNPM verification workflow (typecheck, lint, selected " +
        "tests, build) on a trusted local workspace. Requires owner approval. " +
        "No command, argument, environment, workdir, or timeout is accepted " +
        "from the caller — only stable workspace/recipe IDs and test file paths.",
      inputSchema: {
        workspaceId: z.string().min(1).max(64),
        recipeId: z.string().min(1).max(64),
        testFiles: z.array(z.string().min(1).max(512)).min(0).max(128).optional(),
      },
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("run_local_workflow", args) ??
      runTool(
        {
          name: "run_local_workflow",
          concurrency: "command",
          subject: { kind: "development", key: "workflow", display: "local workflow" },
        },
        async () => runLocalWorkflow(args, ctx, { coordinator }),
      ),
  );
}
