import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { artifactId, decodedBase64Length, parseSha256, sha256File } =
  await import("../dist/artifacts/digest.js");
const { detectArtifactMediaType, validateArtifactType } =
  await import("../dist/artifacts/signatures.js");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const digest = createHash("sha256").update(png).digest("hex");

test("parses lowercase SHA-256 values and calculates decoded Base64 length", () => {
  assert.equal(parseSha256(digest), digest);
  assert.equal(parseSha256(digest.toUpperCase()), null);
  assert.equal(artifactId(digest), `sha256:${digest}`);
  assert.equal(decodedBase64Length(png.toString("base64"), png.length), png.length);
  assert.throws(() => decodedBase64Length("not base64!", 100), /Base64/i);
  assert.throws(() => decodedBase64Length(Buffer.alloc(32).toString("base64"), 8), /too large/i);
});

test("streams a file digest without changing its bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-digest-"));
  const file = path.join(root, "image.png");
  try {
    await writeFile(file, png);
    assert.deepEqual(sha256File(file), { sha256: digest, size: png.length });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes supported signatures and enforces type policy", () => {
  assert.equal(detectArtifactMediaType(png), "image/png");
  assert.equal(detectArtifactMediaType(Buffer.from("504b0304", "hex")), "application/zip");
  assert.equal(detectArtifactMediaType(Buffer.from("4d5a9000", "hex")), "application/vnd.microsoft.portable-executable");
  assert.equal(detectArtifactMediaType(Buffer.from("%PDF-1.7")), "application/pdf");
  assert.equal(detectArtifactMediaType(Buffer.from("524946460000000057415645", "hex")), "audio/wav");
  assert.equal(detectArtifactMediaType(Buffer.from("4f67675300", "hex")), "audio/ogg");
  assert.deepEqual(
    validateArtifactType({ declaredMediaType: "image/png", class: "project_asset", expectedSha256: null }, png),
    { ok: true, detectedMediaType: "image/png" },
  );
  assert.deepEqual(
    validateArtifactType({ declaredMediaType: "image/jpeg", class: "project_asset", expectedSha256: null }, png),
    { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" },
  );
  assert.deepEqual(
    validateArtifactType({ declaredMediaType: "application/octet-stream", class: "project_asset", expectedSha256: null }, png),
    { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" },
  );
  assert.deepEqual(
    validateArtifactType({ declaredMediaType: "application/zip", class: "archive", expectedSha256: null }, Buffer.from("504b0304", "hex")),
    { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" },
  );
});
