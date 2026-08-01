import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

function body(result) {
  return JSON.parse(result.content[0].text);
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

test("legacy owner uses direct ordinary Git commands and exact soft confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-soft-approval-e2e-"));
  const repository = path.join(root, "repository");
  await (await import("node:fs/promises")).mkdir(repository, { recursive: true });
  git(repository, "init");
  git(repository, "config", "user.email", "owner@example.test");
  git(repository, "config", "user.name", "Owner");
  await writeFile(path.join(repository, "marker.txt"), "initial\n", "utf8");
  git(repository, "add", "marker.txt");
  git(repository, "commit", "-m", "initial");
  await writeFile(path.join(repository, "marker.txt"), "changed\n", "utf8");

  const fixture = await startMcpFixture({
    allowedDirs: repository,
    ownerUserId: "owner",
    approvalDataDir: path.join(root, "approval-data"),
    env: { GIT_COMMAND_POLICY: "soft_owner" },
  });
  try {
    const ordinary = body(await fixture.callLegacy("execute_command", {
      command: "git status --short",
      workdir: repository,
    }));
    assert.equal(ordinary.ok, true);
    assert.match(ordinary.stdout, /marker\.txt/);

    const initial = body(await fixture.callLegacy("execute_command", {
      command: "git reset --hard HEAD",
      workdir: repository,
    }));
    assert.equal(initial.code, "GIT_CONFIRMATION_REQUIRED");
    assert.equal(initial.retryable, true);
    assert.ok(initial.gitConfirmation.token);
    assert.equal((await (await import("node:fs/promises")).readFile(path.join(repository, "marker.txt"), "utf8")).replace(/\r\n/g, "\n"), "changed\n");

    const altered = body(await fixture.callLegacy("execute_command", {
      command: "git reset --hard HEAD~1",
      workdir: repository,
      confirmationToken: initial.gitConfirmation.token,
    }));
    assert.equal(altered.code, "APPROVAL_DENIED");
    assert.equal((await (await import("node:fs/promises")).readFile(path.join(repository, "marker.txt"), "utf8")).replace(/\r\n/g, "\n"), "changed\n");

    const completed = body(await fixture.callLegacy("execute_command", {
      command: "git reset --hard HEAD",
      workdir: repository,
      confirmationToken: initial.gitConfirmation.token,
    }));
    assert.equal(completed.ok, true);
    assert.equal((await (await import("node:fs/promises")).readFile(path.join(repository, "marker.txt"), "utf8")).replace(/\r\n/g, "\n"), "initial\n");

    const replay = body(await fixture.callLegacy("execute_command", {
      command: "git reset --hard HEAD",
      workdir: repository,
      confirmationToken: initial.gitConfirmation.token,
    }));
    assert.equal(replay.code, "APPROVAL_DENIED");

    const nonOwner = body(await fixture.callLegacy("execute_command", {
      command: "git status --short",
      workdir: repository,
    }, "other"));
    assert.equal(nonOwner.code, "CLIENT_ELICITATION_UNSUPPORTED");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
