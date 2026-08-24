import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { WorkspaceContextStore, WorkspaceContextError } = await import(
  "../dist/development/workspaces/context.js"
);

async function tempRoot(label) {
  return mkdtemp(path.join(os.tmpdir(), `feishu-workspace-ctx-${label}-`));
}

test("context is owner-isolated and expires after 24h inactivity", async () => {
  const root = await tempRoot("isolate");
  let now = 1_800_000_000_000;
  const store = new WorkspaceContextStore(root, () => now);
  try {
    const saved = store.upsert("owner-a", "android-game", "catalog-a");
    assert.equal(store.get("owner-a", saved.contextId)?.workspaceId, "android-game");
    assert.equal(store.get("owner-b", saved.contextId), undefined);
    now += 86_400_001;
    assert.equal(store.get("owner-a", saved.contextId), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed catalog digest marks context stale", async () => {
  const root = await tempRoot("stale");
  let now = 1_800_000_000_000;
  const store = new WorkspaceContextStore(root, () => now);
  try {
    const saved = store.upsert("owner-a", "android-game", "before");
    assert.equal(store.requireFresh("owner-a", saved.contextId, "after").kind, "stale");
    assert.equal(store.requireFresh("owner-a", saved.contextId, "before").kind, "fresh");
    assert.equal(store.requireFresh("owner-b", saved.contextId, "before").kind, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear is idempotent and scoped to the owner", async () => {
  const root = await tempRoot("clear");
  const store = new WorkspaceContextStore(root);
  try {
    const saved = store.upsert("owner-a", "android-game", "catalog-a");
    assert.equal(store.clear("owner-a", saved.contextId), true);
    assert.equal(store.clear("owner-a", saved.contextId), false);
    store.upsert("owner-a", "android-game", "catalog-a");
    const other = store.upsert("owner-b", "android-game", "catalog-a");
    assert.equal(store.clear("owner-a", other.contextId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt store files and unrecognized phases are rejected", async () => {
  const root = await tempRoot("corrupt");
  const store = new WorkspaceContextStore(root);
  try {
    const saved = store.upsert("owner-a", "android-game", "catalog-a");
    const corrupt = path.join(root, `${saved.contextId}.json`);
    writeFileSync(corrupt, "{ not json", "utf8");
    assert.throws(() => store.get("owner-a", saved.contextId), WorkspaceContextError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const phaseRoot = await tempRoot("phase");
  const phaseStore = new WorkspaceContextStore(phaseRoot);
  try {
    const second = phaseStore.upsert("owner-a", "android-web", "catalog-a");
    const badPhase = path.join(phaseRoot, `${second.contextId}.json`);
    const parsed = JSON.parse(readFileSync(badPhase, "utf8"));
    parsed.phase = "surfing";
    writeFileSync(badPhase, JSON.stringify(parsed), "utf8");
    assert.throws(() => phaseStore.get("owner-a", second.contextId), WorkspaceContextError);
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
});

test("mark_instructions_read accepts only declared files and advances phase", async () => {
  const root = await tempRoot("instructions");
  let now = 1_800_000_000_000;
  const store = new WorkspaceContextStore(root, () => now);
  try {
    const saved = store.upsert("owner-a", "android-game", "catalog-a");
    const declared = ["CLAUDE.md", "docs/setup.md"];
    let ctx = store.markInstructionsRead(
      "owner-a",
      saved.contextId,
      declared,
      ["CLAUDE.md"],
    );
    assert.equal(ctx.phase, "selected");
    ctx = store.markInstructionsRead("owner-a", saved.contextId, declared, ["docs/setup.md"]);
    assert.equal(ctx.phase, "instructions_ready");
    assert.equal(ctx.instructionFilesRead.length, 2);
    assert.throws(
      () => store.markInstructionsRead("owner-a", saved.contextId, declared, ["secret.md"]),
      WorkspaceContextError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records are capped at 16 per owner and ambiguous bootstrap is detected", async () => {
  const root = await tempRoot("cap");
  const store = new WorkspaceContextStore(root);
  try {
    for (let index = 0; index < 20; index += 1) {
      store.upsert("owner-a", `ws-${index}`, "digest");
    }
    const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 16);
    assert.equal(store.findUnambiguous("owner-a"), "ambiguous");
    assert.equal(store.findUnambiguous("owner-b"), "none");

    const one = new WorkspaceContextStore(root);
    const saved = one.upsert("owner-z", "solo", "digest");
    assert.equal(one.findUnambiguous("owner-z")?.workspaceId, "solo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});