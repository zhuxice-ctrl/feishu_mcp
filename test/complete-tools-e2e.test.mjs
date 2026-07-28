import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const expectedTools = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
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

function body(result) {
  return JSON.parse(result.content[0].text);
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

test("complete development tools work over HTTP including input_required retries", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "feishu-complete-e2e-"));
  const approvalRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-complete-approval-"));
  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const pin = randomBytes(12).toString("base64url");
  const user = `e2e-${randomBytes(8).toString("hex")}`;
  const serverOutput = [];
  await writeFile(path.join(workspace, "before.txt"), "alpha\n", "utf8");
  await writeFile(path.join(workspace, "after.txt"), "beta\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "before.txt"), "alpha changed\n", "utf8");

  const localWeb = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<h1>Local development page</h1>");
  });
  await new Promise((resolve) => localWeb.listen(0, "127.0.0.1", resolve));
  const webAddress = localWeb.address();
  assert(webAddress && typeof webAddress === "object");

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: workspace,
      APPROVAL_DATA_DIR: approvalRoot,
      APPROVAL_STATE_SECRET: randomBytes(32).toString("hex"),
      LOG_DIR: path.join(workspace, "logs"),
      MCP_AUTH_TOKEN: token,
      AUTH_MODE: "pin",
      AUTH_PIN: pin,
      AUTH_USER_HEADER: "x-e2e-user",
      CONSENT_ABSOLUTE_PATH: "allow",
      CONSENT_SENSITIVE_FILE: "deny",
      NGROK_DOMAIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
  child.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));

  let requestId = 0;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "x-e2e-user": user,
  };
  async function rpc(method, params = {}) {
    const requestHeaders = { ...headers };
    if (method === "initialize") {
      delete requestHeaders["mcp-protocol-version"];
    } else {
      requestHeaders["mcp-method"] = method;
      if (method === "tools/call") requestHeaders["mcp-name"] = params.name;
    }
    const requestParams = method === "initialize" ? params : {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        "io.modelcontextprotocol/clientInfo": { name: "complete-e2e", version: "1.0.0" },
      },
    };
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params: requestParams }),
    });
    const payload = parseMcp(await response.text());
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    return payload.result;
  }
  async function call(name, args, retry) {
    return rpc("tools/call", { name, arguments: args, ...(retry ?? {}) });
  }
  async function accept(name, args, initial, key, content) {
    assert.equal(initial.resultType, "input_required");
    return call(name, args, {
      requestState: initial.requestState,
      inputResponses: { [key]: { action: "accept", content } },
    });
  }

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "complete-e2e", version: "1.0.0" },
    });
    assert.equal(initialized.serverInfo.name, "feishu-mcp");
    assert.deepEqual((await rpc("tools/list")).tools.map((tool) => tool.name), expectedTools);
    assert.equal((await call("auth", { pin })).isError, undefined);
    assert.match((await call("ping", { message: "complete" })).content[0].text, /pong: complete/);

    assert.equal(body(await call("todo_write", { todos: [{ content: "verify tools", status: "in_progress" }] })).counts.total, 1);
    assert.equal(body(await call("todo_read", {})).todos[0].content, "verify tools");

    const search = body(await call("search_content", { pattern: "alpha changed", path: workspace }));
    assert.equal(search.ok, true);
    assert(search.results.length >= 1);
    assert.equal(body(await call("git_status", { path: workspace })).dirty, 1);
    assert.match(body(await call("git_diff", { path: workspace })).diff, /alpha changed/);
    assert.equal(body(await call("compare_files", {
      path_a: path.join(workspace, "before.txt"), path_b: path.join(workspace, "after.txt"),
    })).identical, false);

    const patchResult = body(await call("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: patched.txt\n+patched through MCP\n*** End Patch",
    }));
    assert.equal(patchResult.applied, true);
    assert.equal(await readFile(path.join(workspace, "patched.txt"), "utf8"), "patched through MCP\n");

    const commandArgs = { command: "node --version", workdir: workspace };
    const commandInitial = await call("execute_command", commandArgs);
    const commandResult = body(await accept(
      "execute_command", commandArgs, commandInitial, "approval", { decision: "allow_once" },
    ));
    assert.equal(commandResult.exitCode, 0);

    const questionArgs = { question: "Select environment", options: ["development", "test", "release"] };
    const question = await accept(
      "ask_user", questionArgs, await call("ask_user", questionArgs), "answer", { answer: "test" },
    );
    assert.deepEqual(body(question), { ok: true, answered: true, answer: "test", selectedIndex: 1 });

    const fetchArgs = { url: `http://127.0.0.1:${webAddress.port}/`, format: "text" };
    const fetched = body(await accept(
      "web_fetch", fetchArgs, await call("web_fetch", fetchArgs), "approval", { decision: "allow_once" },
    ));
    assert.match(fetched.content, /Local development page/);

    const combinedOutput = serverOutput.join("");
    for (const secret of [token, pin]) assert.equal(combinedOutput.includes(secret), false);
  } finally {
    await stop(child);
    await new Promise((resolve) => localWeb.close(resolve));
    await rm(workspace, { recursive: true, force: true });
    await rm(approvalRoot, { recursive: true, force: true });
  }
});
