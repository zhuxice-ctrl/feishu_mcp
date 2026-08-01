/**
 * Tests for the administrator-broker install and uninstall scripts.
 *
 * Both PowerShell scripts and their BAT wrappers are parsed as text to assert:
 *  - a fixed Windows service name;
 *  - literal paths under %ProgramData%\FeishuMcp\Broker;
 *  - SID-based ACL setup for the pipe and key file;
 *  - SHA-256 verification of the broker artifact against the manifest;
 *  - elevation requirement;
 *  - use of -LiteralPath (not -Path) to prevent wildcard injection;
 *  - no embedded secret, no remote script download, no Invoke-Expression.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const installPs1 = await fs.readFile(
  path.resolve("scripts/install-admin-broker.ps1"), "utf8",
);
const uninstallPs1 = await fs.readFile(
  path.resolve("scripts/uninstall-admin-broker.ps1"), "utf8",
);
const installBat = await fs.readFile(
  path.resolve("install-feishu-mcp-admin-broker.bat"), "utf8",
);
const uninstallBat = await fs.readFile(
  path.resolve("uninstall-feishu-mcp-admin-broker.bat"), "utf8",
);
const allScripts = installPs1 + "\n" + uninstallPs1 + "\n" + installBat + "\n" + uninstallBat;

// ---------------------------------------------------------------------------
// Install script
// ---------------------------------------------------------------------------

test("install uses a fixed service name", () => {
  assert.match(installPs1, /FeishuMcpAdminBroker/i);
});

test("install creates the fixed ProgramData directory compatibly with Windows PowerShell", () => {
  assert.match(installPs1, /ProgramData[%\\/]*\s*FeishuMcp[\\/]Broker/i);
  assert.match(installPs1, /Directory\]::CreateDirectory\(\$BrokerDir\)/);
  assert.doesNotMatch(installPs1, /^\s*New-Item\b[^\r\n]*-LiteralPath/im);
});

test("install generates a random key", () => {
  assert.match(installPs1, /RandomNumberGenerator|GetRandomData|randomBytes|GenerateKey/i);
});

test("install applies ACLs for SYSTEM and owner SID", () => {
  assert.match(installPs1, /PipeSecurity|SetAccessControl|ACL|System\.Security\.Principal/i);
  assert.match(installPs1, /WellKnownSidType\]::LocalSystemSid/i);
  assert.match(installPs1, /CurrentUser|owner|SID/i);
  assert.match(installPs1, /SecurityIdentifier\]::new\(\$ownerSid\)/i);
  assert.doesNotMatch(installPs1, /FileSystemAccessRule\(\s*\$ownerSid/i);
});

test("install verifies broker artifact SHA-256 against manifest", () => {
  assert.match(installPs1, /SHA-?256|sha256/i);
  assert.match(installPs1, /manifest/i);
});

test("install requires elevation", () => {
  assert.match(installPs1, /Administrator|elevat|RequireAdmin/i);
});

test("install installs and starts the Windows service", () => {
  assert.match(installPs1, /New-Service|sc\.exe.*create|Install-Service/i);
  assert.match(installPs1, /Start-Service|sc\.exe.*start/i);
});

// ---------------------------------------------------------------------------
// Uninstall script
// ---------------------------------------------------------------------------

test("uninstall stops and removes only the exact service", () => {
  assert.match(uninstallPs1, /FeishuMcpAdminBroker/i);
  assert.match(uninstallPs1, /Stop-Service|sc\.exe.*stop/i);
  assert.match(uninstallPs1, /Remove-Service|sc\.exe.*delete|Delete-Service/i);
  // must verify service name before deleting
  assert.match(uninstallPs1, /Get-Service|Where-Object.*Name/i);
});

test("uninstall deletes only the verified broker directory", () => {
  assert.match(uninstallPs1, /ProgramData[%\\/]*\s*FeishuMcp[\\/]Broker/i);
  assert.match(uninstallPs1, /-LiteralPath/i);
  assert.match(uninstallPs1, /Remove-Item/i);
  // path and service name must be checked before deletion
  assert.match(uninstallPs1, /Test-Path|if.*exist/i);
});

test("uninstall requires elevation", () => {
  assert.match(uninstallPs1, /Administrator|elevat|RequireAdmin/i);
});

// ---------------------------------------------------------------------------
// BAT wrappers
// ---------------------------------------------------------------------------

test("install BAT invokes the PowerShell script", () => {
  assert.match(installBat, /install-admin-broker\.ps1/i);
  assert.match(installBat, /powershell/i);
});

test("uninstall BAT invokes the PowerShell script", () => {
  assert.match(uninstallBat, /uninstall-admin-broker\.ps1/i);
  assert.match(uninstallBat, /powershell/i);
});

// ---------------------------------------------------------------------------
// Shared security assertions
// ---------------------------------------------------------------------------

test("no script uses Invoke-Expression", () => {
  assert.doesNotMatch(allScripts, /Invoke-Expression/i);
  assert.doesNotMatch(allScripts, /\biex\b\s*\(/i);
});

test("no script downloads or invokes a remote script", () => {
  assert.doesNotMatch(allScripts, /Invoke-WebRequest|iex\s*\(|irm\s+http|curl\s+http/i);
  assert.doesNotMatch(allScripts, /https?:\/\//i);
});

test("no script embeds a secret", () => {
  assert.doesNotMatch(allScripts, /Bearer\s|password\s*=|secret\s*=|api[_-]?key\s*=/i);
});

test("no script uses wildcard -Path (only -LiteralPath)", () => {
  // Match standalone -Path parameter (whitespace before dash), not -LiteralPath or Resolve-Path
  assert.doesNotMatch(installPs1, /\s-Path\s/i);
  assert.doesNotMatch(uninstallPs1, /\s-Path\s/i);
});
