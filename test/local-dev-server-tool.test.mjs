import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-local-server-tool-"));
const workspace = path.join(root, "workspace");
const approval = path.join(root, "approval-data");
await mkdir(workspace, { recursive: true });
await mkdir(approval, { recursive: true });
process.env.AUTH_MODE = "none";
process.env.OWNER_USER_ID = "owner";
process.env.OWNER_DEFAULT_DIRS = workspace;
process.env.APPROVAL_DATA_DIR = approval;
process.env.APPROVAL_STATE_SECRET = "local-server-tool-test-secret-0123456789abcdef";
process.env.PNPM_EXECUTABLE = process.execPath;
const catalogPath = path.join(approval, "local-workspaces.json");
await writeFile(catalogPath, JSON.stringify({ version: 1, workspaces: [{
  id: "fixture", label: "Fixture", root: workspace, packageManager: "pnpm", artifactDirs: [],
  recipes: [{ id: "verify", label: "Verify", packageManager: "pnpm", steps: [{ id: "build", kind: "build", enabled: true }] }],
  services: [{ id: "web", label: "Web", runtime: "node", template: "pnpm_dev", script: "dev", workingDirectory: ".", scopes: ["local", "lan"], portRange: { min: 5173, max: 5174 }, healthPath: "/" }],
}] }), "utf8");
const { localDevServer, localDevServerInputSchema } = await import("../dist/tools/localDevServer.js");
test.after(() => rm(root, { recursive: true, force: true }));

function body(result) { return JSON.parse(result.content[0].text); }
function coordinator(active = 0) {
  const calls = [];
  return {
    calls,
    store: { list: () => Array.from({ length: active }, () => ({ kind: "server", state: "running" })) },
    enqueueServer(input) { calls.push(input); return { id: "00000000-0000-4000-8000-000000000001", state: "queued" }; },
  };
}

test("start accepts only catalog identifiers and creates an adapter-owned loopback plan", async () => {
  const c = coordinator();
  const result = body(await localDevServer({ action: "start", workspaceId: "fixture", serviceId: "web", port: 5173, scope: "local" }, { coordinator: c, catalogPath, userId: () => "owner" }));
  assert.equal(result.ok, true);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].server.server.localUrl, "http://127.0.0.1:5173");
  assert.deepEqual(c.calls[0].server.args.slice(-4), ["--host", "127.0.0.1", "--port", "5173"]);
  assert.equal(JSON.stringify(c.calls[0]).includes("command"), false);
});

test("tool schema rejects command injection and owner/port/session boundaries fail closed", async () => {
  assert.equal(localDevServerInputSchema.safeParse({ action: "start", workspaceId: "fixture", serviceId: "web", port: 5173, scope: "local", command: "whoami" }).success, false);
  const forbidden = body(await localDevServer({ action: "start", workspaceId: "fixture", serviceId: "web", port: 5173, scope: "local" }, { coordinator: coordinator(), catalogPath, userId: () => "intruder" }));
  assert.equal(forbidden.code, "OWNER_REQUIRED");
  const invalidPort = body(await localDevServer({ action: "start", workspaceId: "fixture", serviceId: "web", port: 5175, scope: "local" }, { coordinator: coordinator(), catalogPath, userId: () => "owner" }));
  assert.equal(invalidPort.code, "INVALID_ARGUMENT");
  const atLimit = body(await localDevServer({ action: "start", workspaceId: "fixture", serviceId: "web", port: 5173, scope: "local" }, { coordinator: coordinator(4), catalogPath, userId: () => "owner" }));
  assert.equal(atLimit.code, "TASK_QUEUE_FULL");
});
