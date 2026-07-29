import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

const projectDir = path.resolve(import.meta.dirname, "..");
const managementScript = path.join(projectDir, "scripts", "manage-approvals.ps1");

function directoryDecision(decision) {
  return {
    directory_approval: { action: "accept", content: { decision } },
  };
}

function errorCode(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text).code;
}

test("owner defaults and session directory approval work over modern HTTP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-http-e2e-"));
  const ownerDefaultRoot = path.join(root, "owner-default");
  const outsideRoot = path.join(root, "outside");
  const approvalDataDir = path.join(root, "approval-data");
  const ownerDefaultFile = path.join(ownerDefaultRoot, "owner.txt");
  const outsideFile = path.join(outsideRoot, "outside.txt");
  await mkdir(ownerDefaultRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(ownerDefaultFile, "owner default", "utf8");
  await writeFile(outsideFile, "outside", "utf8");

  const fixture = await startMcpFixture({
    allowedDirs: "",
    ownerUserId: "owner",
    ownerDefaultDirs: ownerDefaultRoot,
    approvalDataDir,
    userId: "owner",
  });
  try {
    const direct = await fixture.callModern("read_file", { path: ownerDefaultFile });
    assert.equal(direct.content[0].text, "owner default");

    const first = await fixture.callModern("read_file", { path: outsideFile });
    assert.equal(first.resultType, "input_required");
    assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);

    const session = await fixture.retryModern(
      "read_file",
      { path: outsideFile },
      first,
      directoryDecision("allow_session"),
    );
    assert.equal(session.content[0].text, "outside");
    assert.equal((await fixture.callModern("read_file", { path: outsideFile })).content[0].text, "outside");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("permanent directory approval survives restart and local revocation", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-permanent-e2e-"));
  const ownerDefaultRoot = path.join(root, "owner-default");
  const outsideRoot = path.join(root, "outside");
  const approvalDataDir = path.join(root, "approval-data");
  const outsideFile = path.join(outsideRoot, "outside.txt");
  await mkdir(ownerDefaultRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(outsideFile, "permanent", "utf8");

  const start = () => startMcpFixture({
    allowedDirs: "",
    ownerUserId: "owner",
    ownerDefaultDirs: ownerDefaultRoot,
    approvalDataDir,
    userId: "owner",
  });
  let fixture = await start();
  try {
    const first = await fixture.callModern("read_file", { path: outsideFile });
    const approved = await fixture.retryModern(
      "read_file",
      { path: outsideFile },
      first,
      directoryDecision("allow_permanent"),
    );
    assert.equal(approved.content[0].text, "permanent");
    await fixture.stop();

    fixture = await start();
    assert.equal((await fixture.callModern("read_file", { path: outsideFile })).content[0].text, "permanent");
    await fixture.stop();

    const grants = JSON.parse(await readFile(path.join(approvalDataDir, "directory-grants.json"), "utf8"));
    assert.equal(grants.grants.length, 1);
    const revoke = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", managementScript,
      "-DataDir", approvalDataDir, "-RemoveDirectory", grants.grants[0].id,
    ], { cwd: projectDir, encoding: "utf8" });
    assert.equal(revoke.status, 0, revoke.stderr);

    fixture = await start();
    const afterRevoke = await fixture.callModern("read_file", { path: outsideFile });
    assert.equal(afterRevoke.resultType, "input_required");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported and unidentified clients cannot read outside roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-deny-e2e-"));
  const ownerDefaultRoot = path.join(root, "owner-default");
  const outsideRoot = path.join(root, "outside");
  const approvalDataDir = path.join(root, "approval-data");
  const outsideFile = path.join(outsideRoot, "outside.txt");
  await mkdir(ownerDefaultRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(outsideFile, "must not be read", "utf8");

  const fixture = await startMcpFixture({
    allowedDirs: "",
    ownerUserId: "owner",
    ownerDefaultDirs: ownerDefaultRoot,
    approvalDataDir,
    userId: "owner",
  });
  try {
    const legacy = await fixture.rpc("tools/call", {
      name: "read_file",
      arguments: { path: outsideFile },
    });
    assert.equal(errorCode(legacy), "CLIENT_ELICITATION_UNSUPPORTED");

    const unidentified = await fixture.callModern("read_file", { path: outsideFile }, null);
    assert.equal(errorCode(unidentified), "DIRECTORY_IDENTITY_REQUIRED");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
