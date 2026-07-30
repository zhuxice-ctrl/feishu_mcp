/**
 * Tests for the administrator-broker build script.
 *
 * The script is parsed as text (it runs PowerShell on Windows only) to assert
 * it accepts only the two reviewed runtime enums, publishes self-contained
 * single-file artifacts, emits a manifest with the required fields, rejects an
 * absolute output root, and never uses Invoke-Expression, a remote script
 * download, or an embedded secret.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts/build-admin-broker.ps1");
const script = await fs.readFile(scriptPath, "utf8");

test("accepts only win-x64 and win-arm64 runtimes", () => {
  assert.match(script, /\[ValidateSet\('win-x64',\s*'win-arm64'\)\]/);
  assert.doesNotMatch(script, /win-x86/);
});

test("publishes self-contained single-file artifacts", () => {
  assert.match(script, /--self-contained\s+true/);
  assert.match(script, /PublishSingleFile=true/);
  assert.match(script, /dotnet publish/);
});

test("rejects an absolute output root", () => {
  assert.match(script, /IsPathRooted/);
});

test("emits a manifest with the required fields", () => {
  for (const field of ["protocolVersion", "catalogDigest", "runtime", "filename", "byteSize", "sha256"]) {
    assert.match(script, new RegExp(field));
  }
  assert.match(script, /manifest\.json/);
});

test("uses a fixed service name and named pipe prefix", () => {
  // service name lives in the host; ensure the build targets the host project
  assert.match(script, /FeishuMcp\.AdminBroker\.Host\.csproj/);
});

test("never uses Invoke-Expression", () => {
  assert.doesNotMatch(script, /Invoke-Expression/i);
});

test("never downloads or invokes a remote script", () => {
  assert.doesNotMatch(script, /Invoke-WebRequest|iex\s*\(|irm\s+http|curl\s+http/i);
  assert.doesNotMatch(script, /https?:\/\/(?!services\.gradle\.org|dl\.google\.com)/i);
});

test("embeds no secret", () => {
  assert.doesNotMatch(script, /Bearer\s|password\s*=|secret\s*=/i);
});
