import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.AUTH_MODE = "none";

const { loadDevelopmentCatalog } = await import("../dist/development/environment/catalog.js");
const {
  installReviewedGradleWrapper,
  REVIEWED_GRADLE_WRAPPER_VERSION,
} = await import("../dist/development/android/wrapperAssets.js");

const projectDir = path.resolve(import.meta.dirname, "..");
const assetsRoot = path.join(projectDir, "assets", "gradle-wrapper", REVIEWED_GRADLE_WRAPPER_VERSION);
const catalog = loadDevelopmentCatalog(path.join(projectDir, "config", "development-package-catalog.json"));

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("installs the reviewed Gradle wrapper assets and catalog checksum", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-wrapper-"));
  try {
    const result = installReviewedGradleWrapper(staging, REVIEWED_GRADLE_WRAPPER_VERSION, catalog);
    const manifest = JSON.parse(fs.readFileSync(path.join(assetsRoot, "manifest.json"), "utf8"));
    for (const entry of manifest.files) {
      const destination = entry.path === "gradle-wrapper.jar"
        ? path.join(staging, "gradle", "wrapper", entry.path)
        : path.join(staging, entry.path);
      assert.equal(fs.statSync(destination).size, entry.size);
      assert.equal(digest(destination), entry.sha256);
    }
    const component = catalog.components.find((entry) => entry.id === "org.gradle.distribution");
    assert.equal(result.distributionSha256Sum, component.install.sha256);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("rejects a Gradle version not present in the reviewed wrapper set", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-wrapper-version-"));
  try {
    assert.throws(
      () => installReviewedGradleWrapper(staging, "8.2", catalog),
      /not approved/i,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("rejects a tampered wrapper asset before copying any project bytes", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-wrapper-tamper-stage-"));
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-wrapper-tamper-assets-"));
  try {
    for (const name of ["gradlew", "gradlew.bat", "gradle-wrapper.jar"]) {
      fs.copyFileSync(path.join(assetsRoot, name), path.join(tampered, name));
    }
    fs.appendFileSync(path.join(tampered, "gradlew.bat"), "tampered");
    assert.throws(
      () => installReviewedGradleWrapper(
        staging,
        REVIEWED_GRADLE_WRAPPER_VERSION,
        catalog,
        { assetsRoot: tampered },
      ),
      /failed verification/i,
    );
    assert.equal(fs.existsSync(path.join(staging, "gradlew.bat")), false);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tampered, { recursive: true, force: true });
  }
});

test("git attributes preserve the reviewed wrapper bytes on every platform", () => {
  const attributes = fs.readFileSync(path.join(projectDir, ".gitattributes"), "utf8");
  assert.match(attributes, /\/assets\/gradle-wrapper\/8\.10\.2\/gradlew text eol=lf/);
  assert.match(attributes, /\/assets\/gradle-wrapper\/8\.10\.2\/gradlew\.bat text eol=lf/);
  assert.match(attributes, /\/assets\/gradle-wrapper\/8\.10\.2\/manifest\.json text eol=lf/);
  assert.match(attributes, /\/assets\/gradle-wrapper\/8\.10\.2\/gradle-wrapper\.jar binary/);
});
