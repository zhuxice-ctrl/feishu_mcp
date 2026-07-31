import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("health exposes redacted approval and concurrency summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-health-"));
  const ownerRoot = path.join(root, "private-owner-default");
  const ownerId = "health-owner-identity";
  await mkdir(ownerRoot);
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: "",
      OWNER_USER_ID: ownerId,
      OWNER_DEFAULT_DIRS: ownerRoot,
      DIRECTORY_APPROVAL_FALLBACK: "owner",
      APPROVAL_DATA_DIR: path.join(root, "approvals"),
      LOG_DIR: path.join(root, "logs"),
      MCP_AUTH_TOKEN: "",
      AUTH_MODE: "none",
      AUTH_PIN: "",
      MAX_CONCURRENT_TOOLS: "7",
      MAX_CONCURRENT_COMMANDS: "3",
      MAX_CONCURRENT_SEARCHES: "4",
      MAX_CONCURRENT_FETCHES: "5",
      NGROK_DOMAIN: "",
    },
    stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${port}/health`;
    let health;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(url);
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(health, "health endpoint did not become ready");
    assert.equal(health.toolCount, 30);
    assert.equal(health.tools.length, 30);
    assert.deepEqual(
      Object.fromEntries(Object.entries(health.concurrency).map(([key, value]) => [key, value.limit])),
      { global: 7, command: 3, search: 4, fetch: 5 },
    );
    for (const value of Object.values(health.concurrency)) {
      assert.deepEqual(Object.keys(value).sort(), ["active", "limit", "queued"]);
    }
    assert.deepEqual(health.developmentTasks, {
      queued: 0,
      running: 0,
      terminal: 0,
      totalLimit: 4,
      buildLimit: 2,
    });
    assert.deepEqual(health.developmentEnvironment, {
      catalogVersion: 1,
      brokerState: "missing",
      plans: { planned: 0, claimed: 0, applied: 0, total: 0 },
    });
    assert.deepEqual(health.approval.stored, { session: 0, permanent: 0 });
    assert.equal(health.approval.unsupportedClientPolicy, "deny");
    assert.deepEqual(health.directoryAuthorization, {
      enabled: true,
      ownerDefaults: 1,
      session: 0,
      permanent: 0,
      unsupportedClientPolicy: "deny",
      fallback: "owner",
    });
    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /subjectKey|userId|approval\.key|approvals\.json/i);
    assert.doesNotMatch(serialized, /"(?:taskId|ownerKey|device|project|worker|heartbeat)"\s*:/i);
    assert.doesNotMatch(serialized, /planId|environmentDigest|catalogDigest|brokerKey|ownerSid|pipePath|realPath|fileIdentity|publisher/i);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(ownerId)));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(ownerRoot.replace(/\\/g, "\\\\"))));
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
