import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { TextTransferService, TextTransferError } = await import("../dist/textTransfers/service.js");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof TextTransferError && error.code === code);
}

function begin(service, owner, content, overrides = {}) {
  return service.begin(owner, {
    expectedBytes: Buffer.byteLength(content, "utf8"),
    expectedSha256: sha256(content),
    ...overrides,
  });
}

test("transfers a 167 KiB UTF-8 text file in ordered chunks and retains verified content until discarded", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "text-transfer-"));
  try {
    const content = "a".repeat((167 * 1024) - Buffer.byteLength("你好", "utf8")) + "你好";
    assert.equal(Buffer.byteLength(content, "utf8"), 167 * 1024);
    const service = new TextTransferService({ dataDir, chunkBytes: 48 * 1024 });
    const session = begin(service, "owner-1", content);
    assert.equal(session.chunkBytes, 48 * 1024);

    let offset = 0;
    let index = 0;
    while (offset < content.length) {
      let end = Math.min(content.length, offset + 10_000);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
      const result = service.append("owner-1", session.sessionId, index, content.slice(offset, end));
      assert.equal(result.nextChunkIndex, index + 1);
      offset = end;
      index += 1;
    }

    const inspected = service.inspect("owner-1", session.sessionId);
    assert.equal(inspected.writtenBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(inspected.nextChunkIndex, index);
    assert.equal(inspected.verified, false);

    const verified = service.verify("owner-1", session.sessionId);
    assert.equal(verified.sha256, sha256(content));
    assert.equal(verified.size, Buffer.byteLength(content, "utf8"));
    const source = service.readVerified("owner-1", session.sessionId);
    assert.equal(await readFile(source.path, "utf8"), content);
    assert.equal(source.sha256, sha256(content));
    assert.equal(service.inspect("owner-1", session.sessionId).verified, true);

    service.discard("owner-1", session.sessionId);
    expectCode(() => service.inspect("owner-1", session.sessionId), "TEXT_TRANSFER_NOT_FOUND");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("isolates sessions by owner and rejects out-of-order, oversized, and malformed UTF-8 chunks", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "text-transfer-invalid-"));
  try {
    const service = new TextTransferService({ dataDir, chunkBytes: 8 });
    const session = begin(service, "owner-1", "abcdefgh");
    expectCode(() => service.inspect("owner-2", session.sessionId), "TEXT_TRANSFER_NOT_FOUND");
    expectCode(() => service.append("owner-1", session.sessionId, 1, "abcd"), "TEXT_TRANSFER_ORDER");
    expectCode(() => service.append("owner-1", session.sessionId, 0, "abcdefghi"), "TEXT_TRANSFER_CHUNK_INVALID");
    expectCode(() => service.append("owner-1", session.sessionId, 0, "\uD800"), "TEXT_TRANSFER_CHUNK_INVALID");
    service.append("owner-1", session.sessionId, 0, "abcd");
    expectCode(() => service.append("owner-1", session.sessionId, 0, "efgh"), "TEXT_TRANSFER_ORDER");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("keeps staging on size or digest verification failure and removes expired sessions", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "text-transfer-errors-"));
  try {
    let now = Date.now();
    const service = new TextTransferService({ dataDir, chunkBytes: 16, ttlMs: 10, now: () => now });
    const sizeSession = begin(service, "owner", "abcdefgh", { expectedBytes: 9 });
    service.append("owner", sizeSession.sessionId, 0, "abcdefgh");
    expectCode(() => service.verify("owner", sizeSession.sessionId), "TEXT_TRANSFER_SIZE_MISMATCH");
    assert.equal(service.inspect("owner", sizeSession.sessionId).writtenBytes, 8);

    const digestSession = begin(service, "owner", "abcdefgh", { expectedSha256: sha256("different") });
    service.append("owner", digestSession.sessionId, 0, "abcdefgh");
    expectCode(() => service.verify("owner", digestSession.sessionId), "TEXT_TRANSFER_DIGEST_MISMATCH");
    assert.equal(service.inspect("owner", digestSession.sessionId).verified, false);

    now += 11;
    expectCode(() => service.inspect("owner", digestSession.sessionId), "TEXT_TRANSFER_EXPIRED");
    assert.equal(service.cleanupExpired(), 1);
    expectCode(() => service.inspect("owner", digestSession.sessionId), "TEXT_TRANSFER_NOT_FOUND");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
