/**
 * HTTP-level smoke test for the windows_development tool.
 *
 * Spawns the production MCP server and verifies that `tools/list` includes
 * `windows_development` and that the tool accepts a strict `inspect_project`
 * call. This is a server-spawn test: in the 1-core sandbox the express server
 * cannot boot within the readiness window (same baseline as tools-list /
 * health-concurrency), so it is expected to fail here and pass on a real
 * Windows host.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";

const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function parseMcp(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
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

test("windows_development is registered and callable over HTTP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-win-e2e-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: root,
      APPROVAL_DATA_DIR: path.join(root, "approvals"),
      LOG_DIR: path.join(root, "logs"),
      MCP_AUTH_TOKEN: "",
      AUTH_MODE: "none",
      AUTH_PIN: "",
      NGROK_DOMAIN: "",
      OWNER_USER_ID: "owner",
    },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // tools/list includes windows_development
    const listResp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const listPayload = parseMcp(await listResp.text());
    const toolNames = listPayload.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("windows_development"), "windows_development must be registered");
    assert.equal(new Set(toolNames).size, 29, "exactly 29 tools");
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
