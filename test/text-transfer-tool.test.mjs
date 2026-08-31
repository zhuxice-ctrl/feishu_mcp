import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMcpFixture } from "./helpers/mcp-http-fixture.mjs";

function body(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

test("manage_text_transfer is owner-only and safely resumes into an atomic commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-text-transfer-tool-"));
  const approvalDataDir = path.join(root, "approvals");
  const target = path.join(root, "app.js");
  const source = "export const payload = '" + "x".repeat(167 * 1024) + "';\n";
  const digest = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  await writeFile(target, "old destination", "utf8");
  const fixture = await startMcpFixture({
    allowedDirs: root,
    approvalDataDir,
    env: { CONSENT_ABSOLUTE_PATH: "allow", CONSENT_SENSITIVE_FILE: "allow" },
  });
  try {
    const denied = body(await fixture.callModern("manage_text_transfer", {
      action: "begin", path: target, expectedBytes: Buffer.byteLength(source), expectedSha256: digest,
    }, "other"));
    assert.equal(denied.code, "OWNER_REQUIRED");

    const started = body(await fixture.callModern("manage_text_transfer", {
      action: "begin", path: target, expectedBytes: Buffer.byteLength(source), expectedSha256: digest,
    }));
    assert.equal(started.ok, true);
    assert.equal(started.transfer.chunkBytes, 48 * 1024);
    assert.equal("path" in started.transfer, false);
    const sessionId = started.transfer.sessionId;
    let index = 0;
    for (let offset = 0; offset < source.length; offset += 48 * 1024) {
      const appended = body(await fixture.callModern("manage_text_transfer", {
        action: "append", sessionId, chunkIndex: index, content: source.slice(offset, offset + 48 * 1024),
      }));
      assert.equal(appended.ok, true);
      index += 1;
    }
    const inspection = body(await fixture.callModern("manage_text_transfer", { action: "inspect", sessionId }));
    assert.equal(inspection.transfer.nextChunkIndex, index);
    assert.equal(inspection.transfer.writtenBytes, Buffer.byteLength(source));
    assert.equal("path" in inspection.transfer, false);

    const committed = body(await fixture.callModern("manage_text_transfer", { action: "commit", sessionId }));
    assert.deepEqual(committed.committed, { bytes: Buffer.byteLength(source), sha256: digest });
    assert.equal(await readFile(target, "utf8"), source);
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("digest mismatch preserves the pre-existing destination and tool inventory includes transfer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-text-transfer-digest-"));
  const approvalDataDir = path.join(root, "approvals");
  const target = path.join(root, "unchanged.js");
  const source = "new source\n";
  await writeFile(target, "must survive", "utf8");
  const fixture = await startMcpFixture({
    allowedDirs: root,
    approvalDataDir,
    env: { CONSENT_ABSOLUTE_PATH: "allow", CONSENT_SENSITIVE_FILE: "allow" },
  });
  try {
    const listed = await fixture.rpc("tools/list", {});
    assert.ok(listed.tools.some((tool) => tool.name === "manage_text_transfer"));
    const started = body(await fixture.callModern("manage_text_transfer", {
      action: "begin", path: target, expectedBytes: Buffer.byteLength(source), expectedSha256: "0".repeat(64),
    }));
    const sessionId = started.transfer.sessionId;
    body(await fixture.callModern("manage_text_transfer", { action: "append", sessionId, chunkIndex: 0, content: source }));
    const failed = body(await fixture.callModern("manage_text_transfer", { action: "commit", sessionId }));
    assert.equal(failed.code, "TEXT_TRANSFER_DIGEST_MISMATCH");
    assert.equal(await readFile(target, "utf8"), "must survive");
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
