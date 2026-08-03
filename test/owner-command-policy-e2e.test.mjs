import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

const { startMcpFixture } = await import("./helpers/mcp-http-fixture.mjs");

function readBody(result) {
  if (!result || !Array.isArray(result.content) || result.content.length === 0) return null;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

async function withFixture(fn, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owner-policy-"));
  const project = path.join(root, "project");
  const approvalDataDir = path.join(root, "approvals");
  await mkdir(project, { recursive: true });
  await mkdir(approvalDataDir, { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "owner-policy-fixture",
      private: true,
      scripts: {
        verify: 'node -e "process.stdout.write(\'verified\')"',
        fail: 'node -e "process.stderr.write(\'boom\'); process.exit(2)"',
      },
    }),
  );
  const fixture = await startMcpFixture({
    allowedDirs: project,
    ownerUserId: "owner",
    userId: "owner",
    approvalDataDir,
    env: { OWNER_COMMAND_POLICY: "direct", ...overrides.env },
    ...overrides,
  });
  try {
    await fn({ fixture, project, approvalDataDir, root });
  } finally {
    fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("owner with direct policy runs build verification without a second approval", async () => {
  await withFixture(async ({ fixture, project }) => {
    const result = await fixture.callModern("execute_command", {
      command: "npm run verify",
      workdir: project,
    });
    assert.notEqual(result, undefined);
    assert.notEqual(result.resultType, "input_required",
      "direct owner should not hit input_required");
    const body = readBody(result);
    assert(body, `expected JSON body, got: ${JSON.stringify(result)}`);
    assert.equal(body.ok, true);
    assert.equal(body.exitCode, 0);
    assert.ok(typeof body.durationMs === "number" || typeof body.duration === "number",
      "result should carry bounded duration");
    assert.ok(JSON.stringify(body).includes("verified"),
      "bounded stdout should be present");
  });
});

test("direct owner still receives the exit code and stderr of a failing command", async () => {
  await withFixture(async ({ fixture, project }) => {
    const result = await fixture.callModern("execute_command", {
      command: "npm run fail",
      workdir: project,
    });
    const body = readBody(result);
    assert(body, `expected JSON body, got: ${JSON.stringify(result)}`);
    assert.equal(body.ok, true);
    assert.equal(body.exitCode, 2);
    assert.ok(JSON.stringify(body).includes("boom"),
      "failing command stderr should be returned for automatic repair");
  });
});

test("a non-owner still receives normal command approval under direct policy", async () => {
  await withFixture(async ({ fixture, project }) => {
    const result = await fixture.callModern("execute_command", {
      command: "npm run verify",
      workdir: project,
    }, "guest");
    assert.equal(result.resultType, "input_required",
      "non-owner must not benefit from direct policy");
    assert.ok(result.requestState, "approval request state should be present");
  });
});

test("direct policy does not bypass directory confinement", async () => {
  await withFixture(async ({ fixture, project, approvalDataDir }) => {
    // Owner running inside the authorized root still works.
    const inside = await fixture.callModern("execute_command", {
      command: "npm run verify",
      workdir: project,
    });
    const insideBody = readBody(inside);
    assert.equal(insideBody.ok, true);

    // A workdir outside the authorized root is rejected — directory
    // authorization is not bypassed by the direct policy.
    const outside = await fixture.callModern("execute_command", {
      command: "npm run verify",
      workdir: os.tmpdir(),
    });
    const outsideBody = readBody(outside);
    assert(outsideBody === null || outsideBody.ok !== true,
      `outside-root command must not succeed, got: ${JSON.stringify(outsideBody)}`);

    // The protected approval-data directory stays denied.
    const protectedDir = await fixture.callModern("execute_command", {
      command: "npm run verify",
      workdir: approvalDataDir,
    });
    const protectedBody = readBody(protectedDir);
    assert(protectedBody === null || protectedBody.ok !== true,
      `protected approval dir must not be usable, got: ${JSON.stringify(protectedBody)}`);
  });
});

test("tools/list keeps execute_command and adds no new shell tool under direct policy", async () => {
  await withFixture(async ({ fixture }) => {
    const listed = await fixture.rpc("tools/list", {});
    const names = listed.tools.map((t) => t.name);
    assert.ok(names.includes("execute_command"),
      "execute_command must remain registered");
    // No new shell tool is introduced by the direct owner policy.
    assert.ok(!names.includes("shell"), "no generic shell tool should be added");
    assert.ok(!names.includes("run_shell"), "no run_shell tool should be added");
  });
});
