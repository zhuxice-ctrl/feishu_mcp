import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";

const { BinaryArtifactStore, ArtifactStoreError } = await import("../dist/artifacts/store.js");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const digest = createHash("sha256").update(png).digest("hex");

function request(sessionId) {
  return {
    sessionId,
    displayName: "sprite.png",
    declaredMediaType: "image/png",
    expectedSize: png.length,
    expectedSha256: digest,
    class: "project_asset",
    source: "upload",
  };
}

test("promotes a verified staged file once and redacts store paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
  const store = new BinaryArtifactStore({ dataDir: root });
  try {
    store.createUploadStaging("first");
    await writeFile(path.join(root, "uploads", "first", "content.partial"), png);
    const first = store.promoteStaging(request("first"));
    assert.equal(first.artifact, `sha256:${digest}`);
    assert.equal(first.size, png.length);
    assert.equal(store.healthSummary().storedObjects, 1);

    store.createUploadStaging("second");
    await writeFile(path.join(root, "uploads", "second", "content.partial"), png);
    const second = store.promoteStaging(request("second"));
    assert.equal(second.artifact, first.artifact);
    assert.equal(store.healthSummary().storedObjects, 1);

    const metadata = await readFile(path.join(root, "objects", digest.slice(0, 2), digest, "metadata.json"), "utf8");
    assert.doesNotMatch(metadata, /https?:|target|identity|uploads|objects/i);
    assert.deepEqual(store.inspect(first.artifact)?.artifact, first.artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a corrupted existing object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-corrupt-"));
  const store = new BinaryArtifactStore({ dataDir: root });
  try {
    store.createUploadStaging("first");
    await writeFile(path.join(root, "uploads", "first", "content.partial"), png);
    store.promoteStaging(request("first"));
    await writeFile(path.join(root, "objects", digest.slice(0, 2), digest, "content"), "corrupted");
    store.createUploadStaging("second");
    await writeFile(path.join(root, "uploads", "second", "content.partial"), png);
    assert.throws(() => store.promoteStaging(request("second")), (error) =>
      error instanceof ArtifactStoreError && error.code === "BINARY_ARTIFACT_STORE_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
