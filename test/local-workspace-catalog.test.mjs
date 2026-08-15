import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-workspace-catalog-"));
const { loadLocalWorkspaceCatalog, publicCatalog, findWorkspace, findRecipe, recipeDigest } = await import("../dist/development/workspaces/catalog.js");
test.after(() => rm(root, { recursive: true, force: true }));

function catalog(workspaceRoot) {
  return {
    version: 1,
    workspaces: [{
      id: "zeroxcore-web", label: "ZeroXCore Web", root: workspaceRoot, packageManager: "pnpm", artifactDirs: ["dist"],
      recipes: [{
        id: "verify_web", label: "Web verification", packageManager: "pnpm",
        steps: [
          { id: "typecheck", kind: "typecheck", enabled: true },
          { id: "lint", kind: "lint", enabled: true },
          { id: "test_selected", kind: "test_selected", enabled: true },
          { id: "build", kind: "build", enabled: true },
        ],
      }],
    }],
  };
}

async function load(value) {
  const file = path.join(root, `${crypto.randomUUID()}.json`);
  await writeFile(file, JSON.stringify(value));
  return loadLocalWorkspaceCatalog(file);
}

test("loads a trusted catalog and exposes no roots", async () => {
  const workspace = await mkdtemp(path.join(root, "workspace-"));
  const { catalog: loaded, digest } = await load(catalog(workspace));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(loaded.workspaces[0].artifactDirs[0], path.join(workspace, "dist"));
  const publicView = publicCatalog(loaded);
  assert.equal(publicView.workspaces[0].root, undefined);
  assert.equal(publicView.workspaces[0].recipes[0].steps.length, 4);
  const found = findWorkspace(loaded, "zeroxcore-web");
  assert.equal(findRecipe(found, "verify_web")?.id, "verify_web");
  assert.match(recipeDigest(found, found.recipes[0]), /^[a-f0-9]{64}$/);
});

test("rejects invalid catalog files, symbolic links and artifact escapes", async () => {
  const workspace = await mkdtemp(path.join(root, "workspace-"));
  await assert.rejects(async () => load({ version: 2, workspaces: [] }));
  const escaped = catalog(workspace);
  escaped.workspaces[0].artifactDirs = ["../outside"];
  await assert.rejects(async () => load(escaped), /escapes/i);
  const link = path.join(root, "workspace-link");
  try {
    await symlink(workspace, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(async () => load(catalog(link)), /symbolic link|real directory/i);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
  }
});
