import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-server-contracts-"));
const { loadLocalWorkspaceCatalog, publicCatalog } = await import("../dist/development/workspaces/catalog.js");
const { findDevServer } = await import("../dist/development/servers/catalog.js");
test.after(() => rm(root, { recursive: true, force: true }));

async function workspace() {
  const value = await mkdtemp(path.join(root, "workspace-"));
  await mkdir(path.join(value, "web"));
  await mkdir(path.join(value, "python"));
  await mkdir(path.join(value, "android"));
  await mkdir(path.join(value, "generic"));
  return value;
}

function fixture(workspaceRoot, services) {
  return { version: 1, workspaces: [{
    id: "fixture", label: "Fixture", root: workspaceRoot, packageManager: "pnpm", artifactDirs: [],
    recipes: [{ id: "verify", label: "Verify", packageManager: "pnpm", steps: [{ id: "build", kind: "build", enabled: true }] }],
    services,
  }] };
}

async function load(value) {
  const file = path.join(root, `${crypto.randomUUID()}.json`);
  await writeFile(file, JSON.stringify(value));
  return loadLocalWorkspaceCatalog(file);
}

function common(id, runtime, template, workingDirectory) {
  return { id, label: `${runtime} server`, runtime, template, workingDirectory, scopes: ["local", "lan"], portRange: { min: 5173, max: 5179 }, healthPath: "/" };
}

test("loads closed Node, Python, Android and generic server declarations", async () => {
  const dir = await workspace();
  const services = [
    { ...common("web-dev", "node", "pnpm_dev", "web"), script: "dev" },
    { ...common("api-dev", "python", "uvicorn", "python"), app: "app:app" },
    { ...common("android-dev", "android", "adb_reverse", "android"), target: "emulator-5554" },
    { ...common("preview", "generic", "static_node", "generic"), directory: "generic" },
  ];
  const loaded = await load(fixture(dir, services));
  assert.equal(findDevServer(loaded.catalog.workspaces[0], "web-dev")?.runtime, "node");
  assert.deepEqual(publicCatalog(loaded.catalog).workspaces[0].services[0], {
    id: "web-dev", label: "node server", runtime: "node", scopes: ["local", "lan"],
    portRange: { min: 5173, max: 5179 }, healthPath: "/",
  });
  assert.equal(JSON.stringify(publicCatalog(loaded.catalog)).includes(dir), false);
});

test("rejects duplicate IDs and unsafe service declarations", async () => {
  const dir = await workspace();
  const valid = { ...common("web-dev", "node", "pnpm_dev", "web"), script: "dev" };
  await assert.rejects(() => load(fixture(dir, [valid, { ...valid, label: "duplicate" }])), /duplicate service id/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, runtime: "shell" }])), /validation/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, portRange: { min: 6000, max: 5000 } }])), /validation/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, template: "pnpm_dev;whoami" }])), /validation/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, workingDirectory: "../outside" }])), /validation/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, healthPath: "https://example.test/" }])), /validation/i);
  await assert.rejects(() => load(fixture(dir, [{ ...valid, healthPath: "/ready?x=1" }])), /validation/i);
});
