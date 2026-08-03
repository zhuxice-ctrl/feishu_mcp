import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";

const { parseArtifactLockManifest, serializeArtifactLockManifest } =
  await import("../dist/artifacts/manifest.js");

const digest = "a".repeat(64);

test("serializes a sorted version-one artifact lock manifest", () => {
  const manifest = parseArtifactLockManifest({
    version: 1,
    artifacts: [
      { id: "z", artifact: `sha256:${digest}`, size: 12, mediaType: "image/png", class: "project_asset", target: "assets/z.png" },
      { id: "a", artifact: `sha256:${digest}`, size: 12, mediaType: "image/png", class: "project_asset", target: "assets/a.png" },
    ],
  });
  const serialized = serializeArtifactLockManifest(manifest);
  assert.equal(JSON.parse(serialized).artifacts[0].id, "a");
  assert.match(serialized, /\n$/);
});

test("rejects traversal and duplicate lock targets", () => {
  assert.throws(() => parseArtifactLockManifest({
    version: 1,
    artifacts: [
      { id: "a", artifact: `sha256:${digest}`, size: 1, mediaType: "image/png", class: "project_asset", target: "../escape.png" },
    ],
  }), /manifest/i);
  assert.throws(() => parseArtifactLockManifest({
    version: 1,
    artifacts: [
      { id: "a", artifact: `sha256:${digest}`, size: 1, mediaType: "image/png", class: "project_asset", target: "same.png" },
      { id: "b", artifact: `sha256:${digest}`, size: 1, mediaType: "image/png", class: "project_asset", target: "same.png" },
    ],
  }), /manifest/i);
});
