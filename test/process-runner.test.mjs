import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { runProcess } = await import("../dist/tools/processRunner.js");
const cwd = await mkdtemp(path.join(os.tmpdir(), "feishu-process-"));
test.after(async () => rm(cwd, { recursive: true, force: true }));

test("captures stdout, stderr, and exit code", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('out');process.stderr.write('err')"],
    { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 },
  );
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("marks output truncation at the combined byte limit", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1000));process.stderr.write('y'.repeat(1000))"],
    { cwd, timeoutMs: 5_000, maxOutputBytes: 100 },
  );
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 100);
  assert.equal(result.truncated, true);
});

test("times out and kills a long-running process", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { cwd, timeoutMs: 100, maxOutputBytes: 1024 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true);
  assert.ok(result.durationMs < 5_000);
});
