import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

function body(result) {
  return JSON.parse(result.content[0].text);
}

async function approve(fixture, required, decision) {
  return fixture.callLegacy("auth", {
    directoryApproval: {
      challenge: required.directoryApproval.challenge,
      decision,
    },
  });
}

test("legacy owner approves once and the matching retry consumes it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-directory-e2e-"));
  const ownerRoot = path.join(root, "owner-root");
  const outsideRoot = path.join(root, "outside");
  const outsideFile = path.join(outsideRoot, "hello.txt");
  await mkdir(ownerRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(outsideFile, "legacy works", "utf8");
  const fixture = await startMcpFixture({
    allowedDirs: "",
    ownerUserId: "owner",
    ownerDefaultDirs: ownerRoot,
    directoryApprovalFallback: "owner",
    approvalDataDir: path.join(root, "approval-data"),
    userId: "owner",
  });
  try {
    const first = body(await fixture.callLegacy("read_file", { path: outsideFile }));
    assert.equal(first.code, "DIRECTORY_APPROVAL_REQUIRED");
    assert.equal(first.retryable, true);
    assert.deepEqual(first.directoryApproval.decisions,
      ["allow_once", "allow_session", "allow_permanent", "deny"]);

    const approved = body(await approve(fixture, first, "allow_once"));
    assert.equal(approved.directoryApproval.retryOriginalCall, true);
    assert.equal(approved.directoryApproval.retryTool, "read_file");

    assert.equal(
      (await fixture.callLegacy("read_file", { path: outsideFile })).content[0].text,
      "legacy works",
    );
    assert.equal(
      body(await fixture.callLegacy("read_file", { path: outsideFile })).code,
      "DIRECTORY_APPROVAL_REQUIRED",
    );

    const nonOwner = body(await fixture.callLegacy("read_file", { path: outsideFile }, "other"));
    assert.equal(nonOwner.code, "CLIENT_ELICITATION_UNSUPPORTED");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy session reuse, denial, and permanent restart are enforced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-directory-persist-"));
  const ownerRoot = path.join(root, "owner-root");
  const sessionRoot = path.join(root, "session");
  const permanentRoot = path.join(root, "permanent");
  const sessionFile = path.join(sessionRoot, "session.txt");
  const permanentFile = path.join(permanentRoot, "permanent.txt");
  const approvalDataDir = path.join(root, "approval-data");
  await Promise.all([ownerRoot, sessionRoot, permanentRoot].map((item) => mkdir(item, { recursive: true })));
  await writeFile(sessionFile, "session", "utf8");
  await writeFile(permanentFile, "permanent", "utf8");
  const start = () => startMcpFixture({
    allowedDirs: "",
    ownerUserId: "owner",
    ownerDefaultDirs: ownerRoot,
    directoryApprovalFallback: "owner",
    approvalDataDir,
    userId: "owner",
  });
  let fixture = await start();
  try {
    const deniedInitial = body(await fixture.callLegacy("read_file", { path: sessionFile }));
    assert.equal(body(await approve(fixture, deniedInitial, "deny")).code, "DIRECTORY_APPROVAL_DENIED");
    assert.equal(body(await fixture.callLegacy("read_file", { path: sessionFile })).code,
      "DIRECTORY_APPROVAL_REQUIRED");

    const sessionInitial = body(await fixture.callLegacy("read_file", { path: sessionFile }));
    assert.equal(body(await approve(fixture, sessionInitial, "allow_session")).ok, true);
    assert.equal((await fixture.callLegacy("read_file", { path: sessionFile })).content[0].text, "session");

    const permanentInitial = body(await fixture.callLegacy("read_file", { path: permanentFile }));
    assert.equal(body(await approve(fixture, permanentInitial, "allow_permanent")).ok, true);
    await fixture.stop();
    fixture = await start();
    assert.equal((await fixture.callLegacy("read_file", { path: permanentFile })).content[0].text, "permanent");
    assert.equal(body(await fixture.callLegacy("read_file", { path: sessionFile })).code,
      "DIRECTORY_APPROVAL_REQUIRED");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
