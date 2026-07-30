import assert from "node:assert/strict";
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
