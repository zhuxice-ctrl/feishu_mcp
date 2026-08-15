/**
 * Trusted local workspace catalog loader.
 *
 * Reads, validates, and canonicalizes the protected catalog file. The catalog
 * root and artifact directories are resolved through `realpathSync.native` so
 * that symlinks and `..` escapes are rejected. A SHA-256 digest is computed
 * over the canonical catalog JSON so that the approval digest can bind to a
 * specific recipe version.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  workspaceCatalogSchema,
  type PublicCatalog,
  type PublicWorkspace,
  type WorkspaceCatalog,
  type Workspace,
  type Recipe,
} from "./types.js";

export class WorkspaceCatalogError extends Error {}

const MAX_CATALOG_BYTES = 1_048_576;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reject a path that is a symbolic link or whose canonical real path escapes
 * `root`.
 */
function assertRealInside(label: string, candidate: string, root: string): string {
  const resolved = path.resolve(candidate);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new WorkspaceCatalogError(`${label} does not exist: ${resolved}`);
  }
  if (stat.isSymbolicLink()) {
    throw new WorkspaceCatalogError(`${label} must not be a symbolic link`);
  }
  const real = fs.realpathSync.native(resolved);
  const realRoot = fs.realpathSync.native(root);
  if (!isInside(realRoot, real)) {
    throw new WorkspaceCatalogError(`${label} escapes the workspace root`);
  }
  return real;
}

/**
 * Canonicalize the workspace root and all artifact directories. Rejects links
 * and path escapes.
 */
function canonicalizeWorkspace(ws: Workspace): Workspace {
  const rootStat = fs.lstatSync(ws.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkspaceCatalogError(`workspace root must be a real directory: ${ws.root}`);
  }
  const realRoot = fs.realpathSync.native(ws.root);
  const artifactDirs = ws.artifactDirs.map((dir) => {
    if (path.isAbsolute(dir)) {
      throw new WorkspaceCatalogError("artifact directory must be relative to its workspace root");
    }
    const candidate = path.resolve(realRoot, dir);
    if (!isInside(realRoot, candidate)) {
      throw new WorkspaceCatalogError("artifact directory escapes the workspace root");
    }
    let current = realRoot;
    for (const segment of path.relative(realRoot, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new WorkspaceCatalogError("artifact directory must not traverse a symbolic link");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return candidate;
  });
  return { ...ws, root: realRoot, artifactDirs };
}

/** Compute a SHA-256 digest over the canonical JSON of a value. */
export function catalogDigest(value: unknown): string {
  const json = JSON.stringify(value);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** Compute a recipe-specific digest bound to the workspace root. */
export function recipeDigest(workspace: Workspace, recipe: Recipe): string {
  return catalogDigest({
    workspaceId: workspace.id,
    root: workspace.root,
    recipe,
  });
}

/** Convert a workspace to its public (root-free) view. */
function publicWorkspace(ws: Workspace): PublicWorkspace {
  return {
    id: ws.id,
    label: ws.label,
    recipes: ws.recipes.map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      steps: recipe.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        enabled: step.enabled,
      })),
    })),
  };
}

/** Convert the entire catalog to its public (root-free) view. */
export function publicCatalog(catalog: WorkspaceCatalog): PublicCatalog {
  return { workspaces: catalog.workspaces.map(publicWorkspace) };
}

/**
 * Load and validate the catalog from `catalogPath`. Rejects links, path
 * escapes, duplicate IDs, unknown recipe step kinds, and files larger than
 * 1 MiB. Returns the canonicalized catalog and its SHA-256 digest.
 */
export function loadLocalWorkspaceCatalog(catalogPath: string): {
  catalog: WorkspaceCatalog;
  digest: string;
} {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(catalogPath);
  } catch {
    throw new WorkspaceCatalogError(`catalog file not found: ${catalogPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkspaceCatalogError("catalog file must be a regular file");
  }
  if (stat.size > MAX_CATALOG_BYTES) {
    throw new WorkspaceCatalogError("catalog file exceeds 1 MiB");
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(catalogPath, flags);
  let raw: string;
  try {
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceCatalogError("catalog file is not valid JSON");
  }
  const result = workspaceCatalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkspaceCatalogError(
      `catalog validation failed: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  // Check for duplicate workspace IDs and duplicate recipe IDs within a workspace.
  const workspaceIds = new Set<string>();
  for (const ws of result.data.workspaces) {
    if (workspaceIds.has(ws.id)) {
      throw new WorkspaceCatalogError(`duplicate workspace id: ${ws.id}`);
    }
    workspaceIds.add(ws.id);
    const recipeIds = new Set<string>();
    for (const recipe of ws.recipes) {
      if (recipeIds.has(recipe.id)) {
        throw new WorkspaceCatalogError(`duplicate recipe id in workspace ${ws.id}: ${recipe.id}`);
      }
      recipeIds.add(recipe.id);
    }
    // Canonicalize root and artifact directories.
  }
  const canonicalized: WorkspaceCatalog = {
    version: 1,
    workspaces: result.data.workspaces.map(canonicalizeWorkspace),
  };
  return { catalog: canonicalized, digest: catalogDigest(canonicalized) };
}

/**
 * Find a workspace by ID in the loaded catalog.
 */
export function findWorkspace(
  catalog: WorkspaceCatalog,
  workspaceId: string,
): Workspace | undefined {
  return catalog.workspaces.find((ws) => ws.id === workspaceId);
}

/**
 * Find a recipe by ID within a workspace.
 */
export function findRecipe(
  workspace: Workspace,
  recipeId: string,
): Recipe | undefined {
  return workspace.recipes.find((recipe) => recipe.id === recipeId);
}
