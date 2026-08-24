import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OWNER_USER_ID = "owner";
process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";

const { toolError } = await import("../dist/tools/results.js");
const { WorkspaceContextStore } = await import(
  "../dist/development/workspaces/context.js"
);
const { workspaceContext } = await import("../dist/tools/workspaceContext.js");

function baseWorkspace(id, label, workspaceRoot, hints) {
  return {
    id,
    label,
    root: workspaceRoot,
    packageManager: "pnpm",
    artifactDirs: ["dist"],
    recipes: [{
      id: "verify",
      label: "Verify",
      packageManager: "pnpm",
      steps: [{ id: "build", kind: "build", enabled: true }],
    }],
    hints,
  };
}

async function makeDeps() {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-ws-tool-"));
  const workspaceRoot = await mkdtemp(path.join(root, "workspace"));
  const store = new WorkspaceContextStore(path.join(root, "contexts"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      workspaces: [
        baseWorkspace("android-game", "Android Game", workspaceRoot, {
          ecosystems: ["android"],
          instructionFiles: ["CLAUDE.md"],
          capabilities: ["android_development", "file_read", "content_search"],
        }),
        baseWorkspace("node-web", "Node Web", workspaceRoot, {
          ecosystems: ["node"],
          instructionFiles: ["README.md"],
          capabilities: ["node_workflow", "file_read", "content_search"],
        }),
      ],
    }),
    "utf8",
  );
  const deps = {
    catalogPath,
    store,
    ownerKey: (userId) => `owner-${userId}`,
    hasAccess: () => true,
    userId: () => "owner",
  };
  return { deps, root, workspaceRoot, store };
}

test("workspace selection error gives bounded next action", () => {
  const result = toolError(
    "WORKSPACE_SELECTION_REQUIRED",
    "Select workspace.",
    false,
    {},
    { tool: "workspace_context", action: "bootstrap", reason: "No active workspace." },
    [{ workspaceId: "demo", label: "Demo" }],
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "WORKSPACE_SELECTION_REQUIRED");
  assert.equal(result.structuredContent.nextAction.tool, "workspace_context");
  assert.equal(result.structuredContent.nextAction.action, "bootstrap");
  assert.deepEqual(result.structuredContent.candidates, [
    { workspaceId: "demo", label: "Demo" },
  ]);
});

test("toolError preserves existing call signatures", () => {
  const plain = toolError("OWNER_REQUIRED", "Owner only.");
  assert.equal(plain.structuredContent.ok, false);
  assert.equal(plain.structuredContent.code, "OWNER_REQUIRED");
  assert.equal(plain.structuredContent.nextAction, undefined);
});

test("bootstrap returns selected authorized workspace and Android route", async () => {
  const { deps, root } = await makeDeps();
  try {
    const result = await workspaceContext(
      { action: "bootstrap", workspaceId: "android-game" },
      deps,
    );
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.workspaceId, "android-game");
    assert.equal(
      result.structuredContent.route.recommended.some(
        (step) => step.tool === "android_development",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous bootstrap returns root-free candidates", async () => {
  const { deps, root, workspaceRoot } = await makeDeps();
  try {
    await workspaceContext({ action: "bootstrap", workspaceId: "android-game" }, deps);
    await workspaceContext({ action: "bootstrap", workspaceId: "node-web" }, deps);
    const result = await workspaceContext({ action: "bootstrap" }, deps);
    assert.equal(result.structuredContent.code, "WORKSPACE_SELECTION_REQUIRED");
    assert.equal(JSON.stringify(result.structuredContent).includes(workspaceRoot), false);
    assert.ok(result.structuredContent.candidates.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unauthorized workspace returns WORKSPACE_NOT_AUTHORIZED", async () => {
  const { deps, root } = await makeDeps();
  deps.hasAccess = () => false;
  try {
    const result = await workspaceContext(
      { action: "select", workspaceId: "android-game" },
      deps,
    );
    assert.equal(result.structuredContent.code, "WORKSPACE_NOT_AUTHORIZED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mark_instructions_read advances phase and get reflects the route", async () => {
  const { deps, root } = await makeDeps();
  try {
    const boot = await workspaceContext(
      { action: "bootstrap", workspaceId: "android-game" },
      deps,
    );
    const contextId = boot.structuredContent.contextId;
    const marked = await workspaceContext(
      { action: "mark_instructions_read", contextId, files: ["CLAUDE.md"] },
      deps,
    );
    assert.equal(marked.structuredContent.ok, true);
    assert.equal(marked.structuredContent.phase, "instructions_ready");
    const got = await workspaceContext({ action: "get" }, deps);
    assert.equal(got.structuredContent.phase, "instructions_ready");
    assert.equal(got.structuredContent.route.recommended[0].tool, "read_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear removes the owner context idempotently", async () => {
  const { deps, root } = await makeDeps();
  try {
    const boot = await workspaceContext(
      { action: "bootstrap", workspaceId: "node-web" },
      deps,
    );
    const contextId = boot.structuredContent.contextId;
    const cleared = await workspaceContext({ action: "clear", contextId }, deps);
    assert.equal(cleared.structuredContent.ok, true);
    const again = await workspaceContext({ action: "clear", contextId }, deps);
    assert.equal(again.structuredContent.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Aily guide prescribes bootstrap and forbids shell trial-and-error", () => {
  const guide = readFileSync(
    path.resolve(import.meta.dirname, "..", "docs", "aily-integration-guide.md"),
    "utf8",
  );
  assert.match(guide, /workspace_context[\s\S]*android_development/);
  assert.doesNotMatch(guide, /scan F:\\|gradlew .*execute_command/i);
});