import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function parseMcpResponse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

async function stopChild(child) {
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

test("PIN authentication is isolated per request identity", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "feishu-mcp-auth-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: workspace,
      LOG_DIR: path.join(workspace, "logs"),
      MCP_AUTH_TOKEN: "",
      AUTH_MODE: "pin",
      AUTH_PIN: "12345678",
      AUTH_USER_HEADER: "x-test-user",
      AUTH_EMAIL_HEADER: "x-test-email",
      AUTH_USER_QUERY_PARAM: "",
      AUTH_MULTI_USER: "false",
      AUTH_MAX_USERS: "8",
      CONSENT_ABSOLUTE_PATH: "deny",
      CONSENT_SENSITIVE_FILE: "allow",
      NON_INTERACTIVE: "deny",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  let requestId = 0;
  async function callTool(name, args, userId) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-user": userId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const payload = parseMcpResponse(body);
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    return payload.result;
  }

  try {
    let lastError;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`server exited early (${child.exitCode})\n${output}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          lastError = undefined;
          ready = true;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error(`server did not become ready: ${lastError}\n${output}`);

    const health = await (await fetch(`${baseUrl}/health`)).json();
    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-user": "alice",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "security-test", version: "1.0.0" },
        },
      }),
    });
    const initialize = parseMcpResponse(await initializeResponse.text());
    assert.deepEqual(initialize.result.serverInfo, {
      name: health.service,
      version: health.version,
    });

    const preflight = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    const allowedHeaders = preflight.headers
      .get("access-control-allow-headers")
      .split(",")
      .map((header) => header.trim().toLowerCase());
    for (const expected of [
      "content-type",
      "authorization",
      "mcp-protocol-version",
      "mcp-method",
      "mcp-name",
      "mcp-session-id",
      "x-test-user",
      "x-test-email",
    ]) {
      assert(allowedHeaders.includes(expected), `missing CORS header ${expected}`);
    }
    assert.equal(new Set(allowedHeaders).size, allowedHeaders.length);

    const malformedResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-user": "alice",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: 42 } },
      }),
    });
    const malformedBody = await malformedResponse.text();
    assert.equal(malformedResponse.status, 200, malformedBody);
    const malformed = parseMcpResponse(malformedBody);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      {
        malformedDeniedBeforeValidation:
          malformed.error === undefined &&
          malformed.result?.isError === true &&
          /authentication required/i.test(malformed.result?.content?.[0]?.text || ""),
        bannerLeaksPin: output.includes("12345678"),
        bannerDescribesHiddenPin: output.includes(
          "PIN: configured via AUTH_PIN (value hidden)"
        ),
      },
      {
        malformedDeniedBeforeValidation: true,
        bannerLeaksPin: false,
        bannerDescribesHiddenPin: true,
      }
    );
    assert.doesNotMatch(
      JSON.stringify(malformed),
      /expected.*string|invalid.*type|validation error/i
    );

    assert.equal(
      (await callTool("list_allowed_directories", {}, "alice")).isError,
      true
    );
    assert.equal((await callTool("ping", {}, "alice")).isError, true);
    const guardedRead = await callTool(
      "read_file",
      { path: path.join(workspace, "missing.txt") },
      "alice"
    );
    assert.equal(guardedRead.isError, true);
    assert.match(guardedRead.content[0].text, /authentication required/i);
    assert.equal(
      (await callTool("auth", { pin: "incorrect" }, "alice")).isError,
      true
    );
    assert.equal(
      (await callTool("auth", { pin: "12345678" }, "alice")).isError,
      undefined
    );
    assert.equal(
      (await callTool("list_allowed_directories", {}, "alice")).isError,
      undefined
    );
    const readableFile = path.join(workspace, "relative-readable.txt");
    await writeFile(readableFile, "relative path is allowed", "utf8");
    const absoluteRead = await callTool(
      "read_file",
      { path: readableFile },
      "alice"
    );
    assert.equal(absoluteRead.isError, true);
    assert.match(absoluteRead.content[0].text, /consent.*denied/i);
    const outsideRead = await callTool(
      "read_file",
      { path: path.resolve(workspace, "..", "outside.txt") },
      "alice"
    );
    assert.equal(outsideRead.isError, true);
    assert.match(outsideRead.content[0].text, /outside all allowed directories/i);
    assert.doesNotMatch(outsideRead.content[0].text, /consent/i);
    const relativeRead = await callTool(
      "read_file",
      { path: "relative-readable.txt" },
      "alice"
    );
    assert.equal(relativeRead.isError, undefined);
    assert.equal(relativeRead.content[0].text, "relative path is allowed");
    assert.equal(
      (await callTool("list_allowed_directories", {}, "bob")).isError,
      true
    );
  } finally {
    await stopChild(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("pin mode requires an operator-configured PIN", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      AUTH_MODE: "pin",
      AUTH_PIN: "",
      AUTH_MULTI_USER: "false",
      AUTH_MAX_USERS: "8",
      LOG_LEVEL: "info",
      LOG_FORMAT: "pretty",
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_PIN is required when AUTH_MODE=pin/);
});

test("structured event fields are recursively redacted", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "feishu-mcp-log-"));
  const environment = {
    LOG_DIR: logDir,
    LOG_LEVEL: "warn",
    LOG_FORMAT: "json",
    AUTH_MODE: "none",
    AUTH_PIN: "",
    AUTH_MULTI_USER: "false",
    AUTH_MAX_USERS: "8",
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, environment);
  const originalWrite = process.stderr.write;
  const output = [];
  process.stderr.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };
  try {
    const { logger } = await import("../dist/security/logger.js");
    const fields = {
      authorization: "Bearer raw-token",
      request: {
        profile: [{ pin: "12345678", name: "alice" }],
        Cookie: "session=secret",
      },
    };
    logger.info("suppressed_event", fields);
    logger.warn("visible_event", fields);
    assert.equal(output.length, 1);
    const event = JSON.parse(output[0]);
    assert.equal(event.level, "warn");
    assert.equal(event.event, "visible_event");
    assert.deepEqual(event.request, {
      profile: [{ pin: "[REDACTED]", name: "alice" }],
      Cookie: "[REDACTED]",
    });
    assert.equal(event.authorization, "[REDACTED]");
  } finally {
    process.stderr.write = originalWrite;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(logDir, { recursive: true, force: true });
  }
});
