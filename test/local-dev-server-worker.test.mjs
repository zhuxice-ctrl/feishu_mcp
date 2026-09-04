import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-server-worker-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "server-worker-test-secret-0123456789abcdef";
process.env.DEV_TASK_HEARTBEAT_MS = "100";
process.env.DEV_TASK_CANCEL_GRACE_MS = "100";
const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator, developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");
const ownerKey = developmentOwnerKey("server-owner");
const fixture = path.resolve(import.meta.dirname, "fixtures/local-dev-server-fixture.mjs");
test.after(() => rm(root, { recursive: true, force: true }));

function coordinator() {
  const store = new DevelopmentTaskStore(path.join(root, crypto.randomUUID()));
  return new DevelopmentTaskCoordinator(store, new DevelopmentTaskScheduler({ total: 2, builds: 1, queueTimeoutMs: 10_000 }), { approvalDataDir: root, pollIntervalMs: 20, startupGraceMs: 1_000 });
}
async function port() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function spec(port, args = []) {
  return {
    executable: process.execPath, args: [fixture, "--host", "127.0.0.1", "--port", String(port), "--ready-path", "/ready", ...args], cwd: root, env: {}, timeoutMs: 5_000, successExitCodes: [0], startupTimeoutMs: 1_000,
    server: { serviceId: "fixture", runtime: "node", scope: "local", port, localUrl: `http://127.0.0.1:${port}`, healthPath: "/ready" },
  };
}
async function wait(store, id, predicate, timeout = 8_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = store.get(id); if (value && predicate(value)) return value; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`server task timed out: ${JSON.stringify(store.get(id))}`);
}

test("server reaches running then stops and only its spawned tree is cancelled", async () => {
  const c = coordinator(); const assigned = await port();
  const task = c.enqueueServer({ ownerKey, tool: "local_dev_server", action: "start", class: "default", resources: ["workspace:fixture", `port:${assigned}`], server: spec(assigned), lanUrls: [] });
  const running = await wait(c.store, task.id, (record) => record.server?.state === "running");
  assert.equal(running.state, "running");
  c.cancel(task.id, ownerKey);
  const final = await wait(c.store, task.id, (record) => record.state === "cancelled");
  assert.equal(final.server?.state, "stopped");
});

test("readiness failure becomes a failed server task", async () => {
  const c = coordinator(); const assigned = await port();
  const task = c.enqueueServer({ ownerKey, tool: "local_dev_server", action: "start", class: "default", resources: ["workspace:fixture", `port:${assigned}`], server: spec(assigned, ["--exit-before-ready", "yes"]), lanUrls: [] });
  const final = await wait(c.store, task.id, (record) => record.state === "failed");
  assert.equal(final.server?.state, "failed");
});

test("server lifetime expires without discovering unrelated processes by port", async () => {
  const c = coordinator(); const assigned = await port(); const launch = spec(assigned); launch.timeoutMs = 300;
  const task = c.enqueueServer({ ownerKey, tool: "local_dev_server", action: "start", class: "default", resources: ["workspace:fixture", `port:${assigned}`], server: launch, lanUrls: [] });
  const final = await wait(c.store, task.id, (record) => record.server?.state === "expired", 10_000);
  assert.equal(final.state, "succeeded");
});
