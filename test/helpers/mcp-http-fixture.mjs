import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..", "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve));
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

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function startMcpFixture({
  allowedDirs = "",
  ownerUserId = "owner",
  ownerDefaultDirs = "",
  approvalDataDir,
  userId = "owner",
  env = {},
}) {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_MODE: "none",
      AUTH_PIN: "",
      MCP_AUTH_TOKEN: "",
      AUTH_USER_HEADER: "x-test-user",
      ALLOWED_DIRS: allowedDirs,
      OWNER_USER_ID: ownerUserId,
      OWNER_DEFAULT_DIRS: ownerDefaultDirs,
      APPROVAL_DATA_DIR: approvalDataDir,
      APPROVAL_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      CONSENT_ABSOLUTE_PATH: "confirm",
      CONSENT_SENSITIVE_FILE: "confirm",
      LOG_LEVEL: "error",
      NGROK_DOMAIN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; }
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) {
    await stopChild(child);
    throw new Error(`server did not become ready: ${output.join("")}`);
  }

  let id = 0;
  async function rpc(method, params, modern = false, identity = userId) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (identity !== null) headers["x-test-user"] = identity;
    let requestParams = params;
    if (modern) {
      headers["mcp-protocol-version"] = "2026-07-28";
      headers["mcp-method"] = method;
      if (method === "tools/call") headers["mcp-name"] = params.name;
      requestParams = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
          "io.modelcontextprotocol/clientInfo": { name: "directory-test", version: "1.0.0" },
        },
      };
    }
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: requestParams }),
    });
    const payload = parseMcp(await response.text());
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    return payload.result;
  }

  const callModern = (name, args, identity = userId) =>
    rpc("tools/call", { name, arguments: args }, true, identity);
  const retryModern = (name, args, initial, inputResponses, identity = userId) =>
    rpc("tools/call", {
      name,
      arguments: args,
      requestState: initial.requestState,
      inputResponses,
    }, true, identity);

  return {
    child,
    baseUrl,
    output,
    rpc,
    callModern,
    retryModern,
    stop: () => stopChild(child),
  };
}
