import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectDir, "scripts", "test-real-development-environment.ps1");
const batPath = path.join(projectDir, "test-real-development-environment.bat");

let content;
let bat;
test.before(async () => {
  content = await readFile(scriptPath, "utf8");
  bat = await readFile(batPath, "utf8");
});

test("default mode is read-only inspection", () => {
  assert.match(content, /Mode.*Inspect|param.*Mode.*=.*Inspect/i);
  assert.match(content, /-Mode\s+(Inspect|'Inspect')/);
  const inspectFunction = content.match(/function\s+Run-InspectAcceptance\s*\{[\s\S]*?\r?\n\}/i);
  assert.ok(inspectFunction, "Run-InspectAcceptance must exist");
  assert.match(inspectFunction[0], /\/health|Initialize-AcceptanceClient/i);
  assert.match(inspectFunction[0], /inspect_development_environment/i);
  assert.doesNotMatch(inspectFunction[0], /Invoke-ApprovedMcpTool|manage_development_project|apply_environment_plan/i);
});

test("real changes require both -Mode and -ConfirmRealChanges", () => {
  assert.match(content, /ConfirmRealChanges/);
  assert.match(content, /ConfirmRealChanges.*-and.*Mode|Mode.*-and.*ConfirmRealChanges|require.*ConfirmRealChanges/i);
});

test("root must be explicitly provided and disposable", () => {
  assert.match(content, /-Root/);
  assert.match(content, /Root.*required|Root.*must|Root.*explicit/i);
  assert.match(content, /disposable/i);
});

test("HTTP credentials come from environment without echo", () => {
  assert.match(content, /MCP_AUTH_TOKEN/);
  assert.doesNotMatch(content, /Write-Output.*MCP_AUTH_TOKEN|Write-Host.*MCP_AUTH_TOKEN/i);
  assert.match(content, /GetEnvironmentVariable|env:/i);
});

test("cleanup is target-confined to the disposable root", () => {
  assert.match(content, /Root|disposable/i);
  assert.doesNotMatch(content, /Remove-Item.*C:\\|Remove-Item.*\\\\/i);
  assert.match(content, /\.feishu-mcp-acceptance-root/);
  assert.match(content, /finally[\s\S]*Remove-DisposableRoot/i);
  assert.match(content, /must not already exist/i);
});

test("script never changes ngrok configuration", () => {
  assert.doesNotMatch(content, /ngrok.*config|ngrok.*domain.*set|--domain=/i);
});

test("BAT wrapper delegates to the PowerShell runner without secrets", () => {
  assert.match(bat, /scripts\\test-real-development-environment\.ps1/i);
  assert.match(bat, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(bat, /MCP_AUTH_TOKEN|AUTH_PIN|APPROVAL_STATE_SECRET/i);
});

test("checklist document exists and covers prerequisites and sign-off", async () => {
  const checklist = await readFile(
    path.join(projectDir, "docs", "development-acceptance-checklist.md"),
    "utf8",
  );
  assert.match(checklist, /prerequisite|Prerequisite/i);
  assert.match(checklist, /sign-off|Sign-off|reviewer/i);
  assert.match(checklist, /Android/i);
  assert.match(checklist, /Windows/i);
});

test("MCP transport headers negotiate initialize before modern metadata", () => {
  const headersFunction = content.match(/function\s+Get-McpHeaders\s*\([\s\S]*?\r?\n\}/i);
  assert.ok(headersFunction, "Get-McpHeaders must exist");
  assert.match(
    headersFunction[0],
    /if\s*\(\s*\$Method\s+-ne\s+['"]initialize['"]\s*\)\s*\{[\s\S]*?\$headers\[['"]mcp-protocol-version['"]\]\s*=\s*['"]2026-07-28['"]/i,
    "modern protocol metadata must be conditional on post-initialize requests",
  );
  assert.match(headersFunction[0], /\$headers\[['"]mcp-method['"]\]\s*=\s*\$Method/i);
});

test("runner completes MCP approval retries and drains background task logs by cursor", () => {
  assert.match(content, /resultType\s+-eq\s+"input_required"/i);
  assert.match(content, /requestState/i);
  assert.match(content, /inputResponses/i);
  assert.match(content, /decision\s*=\s*"allow_once"/i);
  assert.match(content, /get_development_task/i);
  assert.match(content, /read_development_task_logs/i);
  assert.match(content, /cursorStdout/i);
  assert.match(content, /cursorStderr/i);
  assert.match(content, /succeeded.*failed.*cancelled.*interrupted/i);
});

test("Android acceptance covers build, device lifecycle, transfer, forwarding, signing, and verification", () => {
  for (const action of [
    "build", "bundle", "test_unit", "avd_create", "emulator_start",
    "install", "start_app", "logcat", "screenshot", "push", "pull",
    "forward", "force_stop", "clear", "uninstall", "sign", "verify",
    "emulator_stop",
  ]) {
    assert.match(content, new RegExp(`action\\s*=\\s*"${action}"`), `missing Android action ${action}`);
  }
  assert.match(content, /sys\\\.boot_completed|sys\.boot_completed/);
  assert.match(content, /dev\\\.bootcomplete|dev\.bootcomplete/);
  assert.match(content, /preexisting-avd-preserved/);
  assert.match(content, /FEISHU_MCP_ACCEPTANCE_ANDROID_KEYSTORE_CREDENTIAL_ID/);
  assert.match(content, /FEISHU_MCP_ACCEPTANCE_ANDROID_KEY_CREDENTIAL_ID/);
});

test("Windows acceptance covers all project types, build pipelines, workload inspection, run-stop, and signing", () => {
  for (const ecosystem of ["dotnet", "native", "electron"]) {
    assert.match(content, new RegExp(`Create-WindowsProject\\s+"${ecosystem}"`), `missing ${ecosystem} project creation`);
  }
  for (const action of [
    "dotnet_restore", "dotnet_build", "dotnet_test", "dotnet_publish", "dotnet_pack",
    "native_configure", "native_build", "native_test", "native_package",
    "electron_install", "electron_test", "electron_package", "run", "stop", "sign", "verify",
  ]) {
    assert.match(content, new RegExp(`(?:action\\s*=\\s*"${action}"|"${action}")`), `missing Windows action ${action}`);
  }
  assert.match(content, /microsoft\.visualstudio\.2022\.buildtools/);
  assert.match(content, /microsoft\.visualstudio\.workload\.manageddesktop/);
  assert.match(content, /WINDOWS_CREDENTIAL_UNKNOWN/);
  assert.match(content, /FEISHU_MCP_ACCEPTANCE_WINDOWS_CREDENTIAL_ID/);
});

test("acceptance evidence is redacted and never reports raw task or credential identifiers", () => {
  assert.match(content, /Get-TaskLabel/);
  assert.match(content, /SHA256/);
  assert.doesNotMatch(content, /Write-(?:Output|Host).*TaskId/i);
  assert.doesNotMatch(content, /Write-(?:Output|Host).*(?:ownerId|CredentialId|authToken|authPin)/i);
  assert.match(content, /acceptance-summary\.json/);
});

test("Inspect mode executes the read-only MCP sequence and emits only redacted evidence", {
  skip: process.platform !== "win32",
}, async () => {
  const calls = [];
  const toolNames = Array.from({ length: 30 }, (_, index) => `tool_${index + 1}`);
  let healthWarningBypass;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      healthWarningBypass = req.headers["ngrok-skip-browser-warning"];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        toolCount: 30,
        tools: toolNames,
        authMode: "none",
        developmentEnvironment: { brokerState: "missing" },
      }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    calls.push({
      method: rpc.method,
      name: rpc.params?.name,
      hasModernMeta: rpc.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28",
      headers: {
        protocolVersion: req.headers["mcp-protocol-version"],
        mcpMethod: req.headers["mcp-method"],
        mcpName: req.headers["mcp-name"],
        warningBypass: req.headers["ngrok-skip-browser-warning"],
      },
    });
    if (rpc.method === "initialize" && req.headers["mcp-protocol-version"]) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "initialize must negotiate before modern transport metadata" }));
      return;
    }
    if (rpc.method !== "initialize" && req.headers["mcp-protocol-version"] !== "2026-07-28") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "post-initialize requests require modern protocol metadata" }));
      return;
    }
    if (rpc.method !== "initialize" && !rpc.params?._meta?.["io.modelcontextprotocol/protocolVersion"]) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "post-initialize requests require modern client metadata" }));
      return;
    }
    let result;
    if (rpc.method === "initialize") {
      result = { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" } };
    } else if (rpc.method === "tools/list") {
      result = { tools: toolNames.map((name) => ({ name })) };
    } else if (rpc.method === "tools/call" && rpc.params?.name === "inspect_development_environment") {
      result = {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            catalogVersion: 1,
            components: [{ componentId: "fixture", state: "missing" }],
          }),
        }],
      };
    } else {
      res.statusCode = 400;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const secret = "fixture-transport-secret-not-for-output";
  const owner = "fixture-owner-not-for-output";
  try {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Mode", "Inspect", "-BaseUrl", `http://127.0.0.1:${port}`,
    ], {
      cwd: projectDir,
      env: { ...process.env, MCP_AUTH_TOKEN: secret, OWNER_USER_ID: owner, AUTH_PIN: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, output);
    assert.deepEqual(calls.map(({ method, name }) => ({ method, name })), [
      { method: "initialize", name: undefined },
      { method: "tools/list", name: undefined },
      { method: "tools/call", name: "inspect_development_environment" },
    ]);
    assert.equal(calls[0].headers.protocolVersion, undefined);
    assert.equal(calls[0].headers.mcpMethod, undefined);
    assert.equal(healthWarningBypass, "true");
    for (const call of calls.slice(1)) {
      assert.equal(call.headers.protocolVersion, "2026-07-28");
      assert.equal(call.headers.mcpMethod, call.method);
      assert.equal(call.hasModernMeta, true);
      assert.equal(call.headers.warningBypass, "true");
    }
    assert.equal(calls[2].headers.mcpName, "inspect_development_environment");
    assert.match(output, /"state"\s*:\s*"passed"/);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.doesNotMatch(output, new RegExp(owner));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
