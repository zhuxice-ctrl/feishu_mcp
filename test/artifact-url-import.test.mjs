import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.AUTH_PIN = "";

const { BinaryArtifactStore } = await import("../dist/artifacts/store.js");
const { ArtifactUrlImportError, importArtifactUrl } = await import("../dist/artifacts/urlImport.js");

test("URL import rejects non-HTTPS and credential-bearing inputs before staging bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-url-"));
  const store = new BinaryArtifactStore({ dataDir: root });
  const request = {
    displayName: "sprite.png",
    declaredMediaType: "image/png",
    expectedSize: null,
    expectedSha256: null,
    class: "project_asset",
  };
  try {
    await assert.rejects(
      importArtifactUrl(store, { ...request, url: "http://8.8.8.8/image.png" }, new AbortController().signal),
      (error) => error instanceof ArtifactUrlImportError && error.code === "BINARY_ARTIFACT_SOURCE_DENIED",
    );
    await assert.rejects(
      importArtifactUrl(store, { ...request, url: "https://user:pass@8.8.8.8/image.png" }, new AbortController().signal),
      (error) => error instanceof ArtifactUrlImportError && error.code === "BINARY_ARTIFACT_SOURCE_DENIED",
    );
    assert.equal(store.healthSummary().activeUploads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
