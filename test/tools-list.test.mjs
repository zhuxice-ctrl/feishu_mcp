import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const expected = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
  "get_development_task", "read_development_task_logs", "cancel_development_task",
];

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

test("production MCP advertises exactly the 24-tool inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-tools-list-"));
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
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const payload = parseMcp(await response.text());
    assert.equal(response.status, 200);
    assert.deepEqual(payload.result.tools.map((tool) => tool.name), expected);
    assert.equal(new Set(payload.result.tools.map((tool) => tool.name)).size, 24);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
