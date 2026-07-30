import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectDir, "scripts", "manage-development-tasks.ps1");
const batPath = path.join(projectDir, "manage-development-tasks.bat");

let content;
let bat;
test.before(async () => {
  content = await readFile(scriptPath, "utf8");
  bat = await readFile(batPath, "utf8");
});

test("script exposes List, Remove, and ClearTerminal parameters", () => {
  assert.match(content, /\[switch\]\$List/);
  assert.match(content, /\[string\]\$Remove/);
  assert.match(content, /\[switch\]\$ClearTerminal/);
});

test("script resolves APPROVAL_DATA_DIR and confines DEV_TASK_DATA_DIR inside it", () => {
  assert.match(content, /APPROVAL_DATA_DIR/);
  assert.match(content, /DEV_TASK_DATA_DIR/);
  assert.match(content, /must remain inside APPROVAL_DATA_DIR/);
});

test("script reads metadata.json and never launches workers or devices", () => {
  assert.match(content, /metadata\.json/);
  // Must not start node, spawn workers, or contact adb/emulator commands.
  assert.doesNotMatch(content, /Start-Process.*node/i);
  assert.doesNotMatch(content, /\bStart-Process\b.*\b(adb|emulator)\b/i);
  assert.doesNotMatch(content, /\bngrok\b/i);
});

test("script only removes terminal-state tasks", () => {
  assert.match(content, /succeeded.*failed.*cancelled.*interrupted|terminalStates/);
  assert.match(content, /is not terminal/);
});

test("Remove rejects ambiguous prefixes and missing matches", () => {
  assert.match(content, /Ambiguous prefix/);
  assert.match(content, /No task found matching/);
});

test("summary is redacted — no owner key, resource paths, or launch args", () => {
  // The redacted summary must not include ownerKey, resources, or launch.json.
  assert.doesNotMatch(content, /ownerKey|launch\.json/i);
  // Summary fields are explicitly enumerated.
  assert.match(content, /byteSize/);
  assert.match(content, /createdAt/);
});

test("script uses -LiteralPath throughout to reject wildcard injection", () => {
  // A bare "-Path " parameter (space-delimited, not part of Join-Path/-PathType)
  // would allow wildcard injection; only -LiteralPath is permitted.
  assert.doesNotMatch(content, /\s-Path\s/i);
  assert.match(content, /-LiteralPath/);
});

test("BAT wrapper delegates to the PowerShell script without printing secrets", () => {
  assert.match(bat, /scripts\\manage-development-tasks\.ps1/i);
  assert.match(bat, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(bat, /MCP_AUTH_TOKEN|AUTH_PIN|APPROVAL_STATE_SECRET|NGROK_AUTHTOKEN/i);
});
