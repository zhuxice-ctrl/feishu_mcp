import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";

const { BinaryArtifactStore } = await import("../dist/artifacts/store.js");
const { ArtifactUploadService, ArtifactUploadError } = await import("../dist/artifacts/uploads.js");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const digest = createHash("sha256").update(png).digest("hex");

function begin(service) {
  return service.begin("owner", {
    displayName: "sprite.png",
    declaredMediaType: "image/png",
    expectedSize: png.length,
    expectedSha256: digest,
    class: "project_asset",
  });
}

test("uploads ordered Base64 chunks and commits exact verified bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-upload-"));
  try {
    const service = new ArtifactUploadService(new BinaryArtifactStore({ dataDir: root }), { chunkBytes: 8 });
    const session = begin(service);
    assert.equal(session.nextChunkIndex, 0);
    service.append("owner", session.sessionId, 0, png.subarray(0, 8).toString("base64"));
    service.append("owner", session.sessionId, 1, png.subarray(8).toString("base64"));
    const committed = service.commit("owner", session.sessionId);
    assert.equal(committed.artifact, `sha256:${digest}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid order, identity, oversize and replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-upload-invalid-"));
  try {
    let now = Date.now();
    const service = new ArtifactUploadService(new BinaryArtifactStore({ dataDir: root }), {
      chunkBytes: 8, ttlMs: 10, now: () => now,
    });
    const session = begin(service);
    const expect = (run, code) => assert.throws(run, (error) =>
      error instanceof ArtifactUploadError && error.code === code);
    expect(() => service.append("owner", session.sessionId, 1, png.subarray(0, 8).toString("base64")), "BINARY_ARTIFACT_UPLOAD_ORDER");
    expect(() => service.append("other", session.sessionId, 0, png.subarray(0, 8).toString("base64")), "BINARY_ARTIFACT_UPLOAD_NOT_FOUND");
    expect(() => service.append("owner", session.sessionId, 0, Buffer.alloc(9).toString("base64")), "BINARY_ARTIFACT_TOO_LARGE");
    service.append("owner", session.sessionId, 0, png.subarray(0, 8).toString("base64"));
    expect(() => service.append("owner", session.sessionId, 0, png.subarray(0, 8).toString("base64")), "BINARY_ARTIFACT_UPLOAD_ORDER");
    now += 11;
    expect(() => service.commit("owner", session.sessionId), "BINARY_ARTIFACT_UPLOAD_EXPIRED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
