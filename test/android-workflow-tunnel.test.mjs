import assert from "node:assert/strict";
import test from "node:test";

const { buildTunnelArgs, validateAlias } = await import("../dist/android-workflow/tunnelAdapter.js");

test("buildTunnelArgs produces the fixed OpenSSH staging loopback vector", () => {
  assert.deepEqual(buildTunnelArgs("staging", 3100, 3100), [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:3100:127.0.0.1:3100",
    "staging",
  ]);
});

test("buildTunnelArgs rejects shell metacharacters in the alias", () => {
  assert.throws(() => buildTunnelArgs("staging;del", 3100, 3100), /invalid SSH alias/);
  assert.throws(() => buildTunnelArgs("staging && rm -rf /", 3100, 3100), /invalid SSH alias/);
  assert.throws(() => buildTunnelArgs("staging`whoami`", 3100, 3100), /invalid SSH alias/);
});

test("buildTunnelArgs rejects non-3100 ports", () => {
  assert.throws(() => buildTunnelArgs("staging", 3101, 3100), /localPort must be 3100/);
  assert.throws(() => buildTunnelArgs("staging", 3100, 8080), /remotePort must be 3100/);
});

test("validateAlias accepts dotted and dashed aliases", () => {
  assert.doesNotThrow(() => validateAlias("staging.example.com"));
  assert.doesNotThrow(() => validateAlias("my-host"));
  assert.doesNotThrow(() => validateAlias("host_01"));
});

test("validateAlias rejects empty and path-like input", () => {
  assert.throws(() => validateAlias(""), /invalid SSH alias/);
  assert.throws(() => validateAlias("/etc/passwd"), /invalid SSH alias/);
  assert.throws(() => validateAlias("../escape"), /invalid SSH alias/);
  assert.throws(() => validateAlias("host|cat"), /invalid SSH alias/);
});
