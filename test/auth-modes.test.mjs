import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function parseMcp(text) {
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : text);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function withServer(mode, consentPolicy, run) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `feishu-mcp-${mode}-`));
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: workspace,
      APPROVAL_DATA_DIR: path.join(workspace, "approvals"),
      LOG_DIR: path.join(workspace, "logs"),
      MCP_AUTH_TOKEN: "",
      AUTH_MODE: mode,
      AUTH_PIN: "",
      AUTH_USER_HEADER: "x-test-user",
      AUTH_EMAIL_HEADER: "x-test-email",
      AUTH_MULTI_USER: "false",
      AUTH_MAX_USERS: "8",
      CONSENT_ABSOLUTE_PATH: consentPolicy,
      CONSENT_SENSITIVE_FILE: "allow",
      NON_INTERACTIVE: "deny",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const baseUrl = `http://127.0.0.1:${port}`;

  async function call(name, args = {}, userId) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (userId) headers["x-test-user"] = userId;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    return parseMcp(await response.text()).result;
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`server exited early\n${output}`);
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error(`server did not become ready\n${output}`);
    await run({ workspace, call });
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
  }
}

test("header mode requires and trusts the configured request identity", async () => {
  await withServer("header", "allow", async ({ call }) => {
    assert.equal((await call("list_allowed_directories")).isError, true);
    assert.equal((await call("list_allowed_directories", {}, "alice")).isError, undefined);
  });
});

test("none mode allows tools without a request identity", async () => {
  await withServer("none", "allow", async ({ call }) => {
    assert.equal((await call("list_allowed_directories")).isError, undefined);
  });
});

test("confirm policy denies absolute paths when the client cannot elicit", async () => {
  await withServer("none", "confirm", async ({ workspace, call }) => {
    const target = path.join(workspace, "sample.txt");
    await writeFile(target, "sample", "utf8");
    const result = await call("read_file", { path: target });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CLIENT_ELICITATION_UNSUPPORTED/);
  });
});
