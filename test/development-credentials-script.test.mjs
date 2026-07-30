import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PS1 = fs.readFileSync("scripts/manage-development-credentials.ps1", "utf8");
const BAT = fs.readFileSync("manage-development-credentials.bat", "utf8");

test("script requires elevation", () => {
  assert.ok(/#Requires -RunAsAdministrator/.test(PS1));
});

test("script never accepts a plaintext secret on the command line", () => {
  // No -Secret / -Password / -Value param; secret comes only from Read-Host -AsSecureString
  assert.ok(/param\s*\(/s.test(PS1));
  const paramBlock = PS1.match(/param\s*\(([\s\S]*?)\)/)[1];
  assert.ok(!/secret|password/i.test(paramBlock));
});

test("script prompts with Read-Host -AsSecureString", () => {
  assert.ok(/Read-Host\s+-AsSecureString/.test(PS1));
});

test("script encrypts with DPAPI CurrentUser scope", () => {
  assert.ok(/ProtectedData\]::Protect/.test(PS1));
  assert.ok(/DataProtectionScope\]::CurrentUser/.test(PS1));
});

test("script stores blobs under APPROVAL_DATA_DIR credentials", () => {
  assert.ok(/APPROVAL_DATA_DIR/.test(PS1));
  assert.ok(/credentials/.test(PS1));
});

test("script uses -LiteralPath throughout (no wildcard injection)", () => {
  const literalCount = (PS1.match(/-LiteralPath/g) || []).length;
  assert.ok(literalCount >= 4, `expected several -LiteralPath uses, got ${literalCount}`);
  // -Path as a parameter (not the Join-Path/Test-Path cmdlet names) must not appear
  assert.ok(!/(?<![a-zA-Z])-Path\s+/.test(PS1), "raw -Path parameter must not be used");
});

test("script sets owner-only ACL on blob and index", () => {
  assert.ok(/SetAccessRuleProtection/.test(PS1));
  assert.ok(/Get-Acl/.test(PS1));
});

test("script zeroes plaintext from memory after encryption", () => {
  assert.ok(/\[char\]0/.test(PS1));
});

test("script list output exposes no secret fields", () => {
  // list block constructs objects with id/kind/alias/fingerprint/timestamps only
  const listBlock = PS1.match(/"list"\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(listBlock, "list block found");
  assert.ok(!/secret|password|value/i.test(listBlock[1]));
});

test("script uses a fixed action enum", () => {
  assert.ok(/ValidateSet\("create",\s*"list",\s*"remove"\)/.test(PS1));
});

test("bat wrapper calls the ps1 with -File and forwards args", () => {
  assert.ok(/-File/.test(BAT));
  assert.ok(/%\*/.test(BAT));
  assert.ok(/powershell/i.test(BAT));
});
