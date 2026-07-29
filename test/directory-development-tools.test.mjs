import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapeRegex, startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

function approval(decision = "allow_once") {
  return { approval: { action: "accept", content: { decision } } };
}

function directoryApproval(decision = "allow_once") {
  return { directory_approval: { action: "accept", content: { decision } } };
}

test("command, search, Git and diff request directory approval before work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-dev-tools-"));
  const allowed = path.join(root, "allowed");
  const commandDir = path.join(root, "command");
  const searchDir = path.join(root, "search");
  const gitDir = path.join(root, "git");
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  const approvalDataDir = path.join(root, "approval");
  await Promise.all([allowed, commandDir, searchDir, gitDir, firstDir, secondDir].map((dir) => mkdir(dir)));
  await writeFile(path.join(searchDir, "search.txt"), "find this needle\n");
  await writeFile(path.join(firstDir, "a.txt"), "one\n");
  await writeFile(path.join(secondDir, "b.txt"), "two\n");
  execFileSync("git", ["init"], { cwd: gitDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: gitDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: gitDir });
  await writeFile(path.join(gitDir, "file.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: gitDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: gitDir, stdio: "ignore" });
  await writeFile(path.join(gitDir, "file.txt"), "two\n");

  const fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
  try {
    const marker = path.join(commandDir, "marker.txt");
    const commandArgs = {
      command: "echo ran>marker.txt",
      workdir: commandDir,
    };
    const commandFirst = await fixture.callModern("execute_command", commandArgs);
    assert.deepEqual(Object.keys(commandFirst.inputRequests), ["directory_approval"]);
    await assert.rejects(readFile(marker));
    const commandRisk = await fixture.retryModern(
      "execute_command", commandArgs, commandFirst, directoryApproval(),
    );
    assert.deepEqual(Object.keys(commandRisk.inputRequests), ["approval"]);
    await assert.rejects(readFile(marker));
    const commandResult = await fixture.retryModern(
      "execute_command", commandArgs, commandRisk, approval(),
    );
    assert.equal(commandResult.structuredContent.exitCode, 0, JSON.stringify(commandResult));
    assert.match(await readFile(marker, "utf8"), /^ran\s*$/);

    const searchArgs = { pattern: "needle", path: searchDir };
    const searchFirst = await fixture.callModern("search_content", searchArgs);
    assert.deepEqual(Object.keys(searchFirst.inputRequests), ["directory_approval"]);
    const searchResult = await fixture.retryModern(
      "search_content", searchArgs, searchFirst, directoryApproval(),
    );
    assert.equal(searchResult.structuredContent.matchCount, 1);

    const statusArgs = { path: gitDir };
    const statusFirst = await fixture.callModern("git_status", statusArgs);
    assert.deepEqual(Object.keys(statusFirst.inputRequests), ["directory_approval"]);
    const status = await fixture.retryModern("git_status", statusArgs, statusFirst, directoryApproval());
    assert.equal(status.structuredContent.dirty, 1);

    const gitDiffArgs = { path: gitDir, file: "file.txt" };
    const gitDiffFirst = await fixture.callModern("git_diff", gitDiffArgs);
    assert.deepEqual(Object.keys(gitDiffFirst.inputRequests), ["directory_approval"]);
    const gitDiff = await fixture.retryModern("git_diff", gitDiffArgs, gitDiffFirst, directoryApproval());
    assert.match(gitDiff.structuredContent.diff, /-one\s*\+two/);

    const compareArgs = { path_a: path.join(firstDir, "a.txt"), path_b: path.join(secondDir, "b.txt") };
    const compareFirst = await fixture.callModern("compare_files", compareArgs);
    assert.deepEqual(Object.keys(compareFirst.inputRequests), ["directory_approval"]);
    const message = compareFirst.inputRequests.directory_approval.params.message;
    assert.match(message, new RegExp(escapeRegex(firstDir)));
    assert.match(message, new RegExp(escapeRegex(secondDir)));
    const compared = await fixture.retryModern("compare_files", compareArgs, compareFirst, directoryApproval());
    assert.equal(compared.structuredContent.identical, false);
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-directory patch is all-or-nothing across directory approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-dev-patch-"));
  const allowed = path.join(root, "allowed");
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  const approvalDataDir = path.join(root, "approval");
  await Promise.all([allowed, firstDir, secondDir].map((dir) => mkdir(dir)));
  const firstFile = path.join(firstDir, "first.txt");
  const secondFile = path.join(secondDir, "second.txt");
  const patch = `*** Begin Patch
*** Add File: ${firstFile.replace(/\\/g, "/")}
+first
*** Add File: ${secondFile.replace(/\\/g, "/")}
+second
*** End Patch`;
  const args = { patch };
  const fixture = await startMcpFixture({ allowedDirs: allowed, approvalDataDir });
  try {
    const first = await fixture.callModern("apply_patch", args);
    assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);
    const message = first.inputRequests.directory_approval.params.message;
    assert.match(message, new RegExp(escapeRegex(firstDir)));
    assert.match(message, new RegExp(escapeRegex(secondDir)));
    const denied = await fixture.retryModern("apply_patch", args, first, directoryApproval("deny"));
    assert.equal(JSON.parse(denied.content[0].text).code, "DIRECTORY_APPROVAL_DENIED");
    await assert.rejects(readFile(firstFile));
    await assert.rejects(readFile(secondFile));

    const retry = await fixture.callModern("apply_patch", args);
    const applied = await fixture.retryModern("apply_patch", args, retry, directoryApproval());
    assert.equal(applied.structuredContent.applied, true, JSON.stringify(applied));
    assert.equal(await readFile(firstFile, "utf8"), "first\n");
    assert.equal(await readFile(secondFile, "utf8"), "second\n");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
