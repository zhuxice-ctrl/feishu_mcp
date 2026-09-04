import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-server-recovery-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "server-recovery-test-secret-0123456789abcdef";
const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
const { DevelopmentTaskScheduler } = await import("../dist/development/tasks/scheduler.js");
const { DevelopmentTaskCoordinator, developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");
test.after(() => rm(root, { recursive: true, force: true }));

test("recovery marks a stale server heartbeat interrupted without probing or killing its port", () => {
  const store = new DevelopmentTaskStore(path.join(root, "tasks"));
  const task = store.create({ ownerKey: developmentOwnerKey("owner"), tool: "local_dev_server", action: "start", class: "default", kind: "server", resources: ["workspace:fixture", "port:5173"] });
  store.saveServerSpec(task.id, { executable: process.execPath, args: ["-v"], cwd: root, env: {}, timeoutMs: 60_000, successExitCodes: [0], startupTimeoutMs: 1_000, server: { serviceId: "fixture", runtime: "node", scope: "local", port: 5173, localUrl: "http://127.0.0.1:5173" } });
  store.update(task.id, "queued", { state: "running", worker: { pid: 999999, nonce: "0123456789abcdef", heartbeatAt: new Date(0).toISOString() }, server: { serviceId: "fixture", runtime: "node", scope: "local", port: 5173, state: "running", localUrl: "http://127.0.0.1:5173", lanUrls: [] } });
  new DevelopmentTaskCoordinator(store, new DevelopmentTaskScheduler({ total: 1, builds: 1, queueTimeoutMs: 1_000 }), { approvalDataDir: root, heartbeatStaleMs: 1, startupGraceMs: 1, pollIntervalMs: 1 });
  assert.equal(store.get(task.id)?.state, "interrupted");
  assert.equal(store.get(task.id)?.server?.state, "failed");
});
