import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapeRegex, startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

async function approveOnce(fixture, name, args, initial) {
  return fixture.retryModern(name, args, initial, {
    directory_approval: { action: "accept", content: { decision: "allow_once" } },
  });
}

test("filesystem tools authorize outside scopes and retry the original tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-fs-tools-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  const approvalDataDir = path.join(root, "approval");
  await mkdir(allowed);
  await mkdir(outside);
  const readDir = path.join(outside, "read");
  const editDir = path.join(outside, "edit");
  const listDir = path.join(outside, "list");
  const infoDir = path.join(outside, "info");
  await Promise.all([readDir, editDir, listDir, infoDir].map((dir) => mkdir(dir)));
  const readPath = path.join(readDir, "file.txt");
  const editPath = path.join(editDir, "file.txt");
  const infoPath = path.join(infoDir, "file.txt");
  await writeFile(readPath, "outside content");
  await writeFile(editPath, "before");
  await writeFile(path.join(listDir, "listed.txt"), "listed");
  await writeFile(infoPath, "info");

  const fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
  try {
    const cases = [
      ["read_file", { path: readPath }, readDir],
      ["write_file", { path: path.join(outside, "write", "file.txt"), content: "new" }, path.join(outside, "write")],
      ["edit_file", { path: editPath, oldText: "before", newText: "after" }, editDir],
      ["create_directory", { path: path.join(outside, "created") }, path.join(outside, "created")],
      ["list_directory", { path: listDir }, listDir],
      ["search_files", { path: listDir, pattern: "*.txt" }, listDir],
      ["get_file_info", { path: infoPath }, infoDir],
    ];
    for (const [name, args, expectedScope] of cases) {
      const first = await fixture.callModern(name, args);
      assert.equal(first.resultType, "input_required", `${name}: ${JSON.stringify(first)}`);
      assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);
      assert.match(first.inputRequests.directory_approval.params.message, new RegExp(escapeRegex(expectedScope)));
      const result = await approveOnce(fixture, name, args, first);
      assert.notEqual(result.resultType, "input_required", `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
    }
    assert.equal(await readFile(editPath, "utf8"), "after");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("move_file authorizes both parents at once and denial changes nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-fs-move-"));
  const allowed = path.join(root, "allowed");
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  const approvalDataDir = path.join(root, "approval");
  await Promise.all([allowed, sourceDir, destinationDir].map((dir) => mkdir(dir)));
  const source = path.join(sourceDir, "source.txt");
  const destination = path.join(destinationDir, "destination.txt");
  await writeFile(source, "source-bytes");
  const fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
  try {
    const args = { source, destination };
    const first = await fixture.callModern("move_file", args);
    assert.equal(first.resultType, "input_required");
    const message = first.inputRequests.directory_approval.params.message;
    assert.match(message, new RegExp(escapeRegex(sourceDir)));
    assert.match(message, new RegExp(escapeRegex(destinationDir)));
    const denied = await fixture.retryModern("move_file", args, first, {
      directory_approval: { action: "accept", content: { decision: "deny" } },
    });
    assert.equal(JSON.parse(denied.content[0].text).code, "DIRECTORY_APPROVAL_DENIED");
    assert.equal(await readFile(source, "utf8"), "source-bytes");
    await assert.rejects(readFile(destination));
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("static-root move preserves chained absolute-path consent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-fs-static-move-"));
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  const approvalDataDir = path.join(root, "approval");
  await Promise.all([sourceDir, destinationDir].map((dir) => mkdir(dir)));
  const source = path.join(sourceDir, "source.txt");
  const destination = path.join(destinationDir, "destination.txt");
  await writeFile(source, "move-me");
  const fixture = await startMcpFixture({ allowedDirs: root, approvalDataDir });
  try {
    const args = { source, destination };
    const first = await fixture.callModern("move_file", args);
    assert.deepEqual(Object.keys(first.inputRequests), ["approval"]);
    const second = await fixture.retryModern("move_file", args, first, {
      approval: { action: "accept", content: { decision: "allow_once" } },
    });
    assert.deepEqual(Object.keys(second.inputRequests), ["approval"]);
    const moved = await fixture.retryModern("move_file", args, second, {
      approval: { action: "accept", content: { decision: "allow_once" } },
    });
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    assert.equal(await readFile(destination, "utf8"), "move-me");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("session and permanent directory grants are isolated and reusable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-fs-grants-"));
  const allowed = path.join(root, "allowed");
  const sessionDir = path.join(root, "session");
  const permanentDir = path.join(root, "permanent");
  const approvalDataDir = path.join(root, "approval");
  await Promise.all([allowed, sessionDir, permanentDir].map((dir) => mkdir(dir)));
  const sessionFile = path.join(sessionDir, "file.txt");
  const permanentFile = path.join(permanentDir, "file.txt");
  await writeFile(sessionFile, "session");
  await writeFile(permanentFile, "permanent");
  let fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
  try {
    const sessionFirst = await fixture.callModern("read_file", { path: sessionFile });
    const sessionAllowed = await fixture.retryModern("read_file", { path: sessionFile }, sessionFirst, {
      directory_approval: { action: "accept", content: { decision: "allow_session" } },
    });
    assert.equal(sessionAllowed.content[0].text, "session");
    assert.equal((await fixture.callModern("read_file", { path: sessionFile })).content[0].text, "session");

    const permanentFirst = await fixture.callModern("read_file", { path: permanentFile });
    const permanentAllowed = await fixture.retryModern("read_file", { path: permanentFile }, permanentFirst, {
      directory_approval: { action: "accept", content: { decision: "allow_permanent" } },
    });
    assert.equal(permanentAllowed.content[0].text, "permanent");

    const ownerRoots = await fixture.callModern("list_allowed_directories", {});
    const otherRoots = await fixture.callModern("list_allowed_directories", {}, "other");
    assert(ownerRoots.structuredContent.count > otherRoots.structuredContent.count);
    await fixture.stop();

    fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
    assert.equal((await fixture.callModern("read_file", { path: permanentFile })).content[0].text, "permanent");
    assert.equal((await fixture.callModern("read_file", { path: sessionFile })).resultType, "input_required");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
