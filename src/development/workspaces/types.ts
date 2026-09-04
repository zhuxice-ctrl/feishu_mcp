/**
 * Zod schemas for the trusted local workspace catalog.
 *
 * The catalog is a protected JSON file that maps stable workspace and recipe
 * IDs to a closed set of PNPM verification steps. An MCP caller can never
 * supply an executable, argument, workdir, or environment — only the IDs and
 * a bounded list of test file paths published by the operator.
 */

import { z } from "zod";
import path from "node:path";
import { devServerSchema, type CanonicalDevServer, type DevServer } from "../servers/contracts.js";

/** Terminal-safe step kinds for first-phase workflows. */
export const WORKFLOW_STEP_KINDS = [
  "typecheck",
  "lint",
  "test_selected",
  "build",
] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Only pnpm is permitted as the package manager. */
export const PACKAGE_MANAGERS = ["pnpm"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Declarative capabilities that map to implemented server routes. */
export const WORKSPACE_CAPABILITIES = [
  "file_read",
  "content_search",
  "git_read",
  "node_workflow",
  "android_development",
  "development_tasks",
  "local_dev_server",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/** Relative catalog-declared instruction files reject absolute paths and traversal. */
const relativeInstructionFile = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."));

export const workspaceHintsSchema = z
  .object({
    ecosystems: z
      .array(z.enum(["node", "android", "dotnet", "native", "electron"]))
      .max(5)
      .default([]),
    instructionFiles: z.array(relativeInstructionFile).max(16).default([]),
    capabilities: z.array(z.enum(WORKSPACE_CAPABILITIES)).max(6).default([]),
  })
  .strict()
  .default({ ecosystems: [], instructionFiles: [], capabilities: [] });

export const testSelectionSchema = z.strictObject({
  /** Relative paths to test files, restricted to safe path tokens. */
  files: z.array(z.string().min(1).max(512)).min(0).max(128),
});

export const workflowStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  kind: z.enum(WORKFLOW_STEP_KINDS),
  /** Whether this step is enabled in the recipe. */
  enabled: z.boolean(),
});

export const recipeSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(128),
  packageManager: z.enum(PACKAGE_MANAGERS),
  steps: z.array(workflowStepSchema).min(1).max(8),
});

export const workspaceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(128),
  /** Absolute root of the project; canonicalized through realpath on load. */
  root: z.string().min(1).max(4096),
  /** Package manager script prefix used by the adapter. */
  packageManager: z.enum(PACKAGE_MANAGERS),
  /** Canonical output directories for artifact summaries. */
  artifactDirs: z.array(z.string().min(1).max(4096)).min(0).max(16),
  recipes: z.array(recipeSchema).min(1).max(8),
  /** Operator-declared server templates; optional for existing catalogs. */
  services: z.array(devServerSchema).max(16).default([]),
  /** Declarative routing hints; optional for old catalog entries. */
  hints: workspaceHintsSchema,
});

export const workspaceCatalogSchema = z.strictObject({
  version: z.literal(1),
  workspaces: z.array(workspaceSchema).min(0).max(16),
});

export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type TestSelection = z.infer<typeof testSelectionSchema>;
export type WorkspaceHints = z.infer<typeof workspaceHintsSchema>;
export type { DevServer, CanonicalDevServer };

/** Public view of a workspace — no absolute root is exposed. */
export interface PublicWorkspace {
  id: string;
  label: string;
  hints: WorkspaceHints;
  recipes: Array<{
    id: string;
    label: string;
    steps: Array<{ id: string; kind: WorkflowStepKind; enabled: boolean }>;
  }>;
  services: import("../servers/contracts.js").PublicDevServer[];
}

/** Public view of the entire catalog — IDs and labels only, no roots. */
export interface PublicCatalog {
  workspaces: PublicWorkspace[];
}
