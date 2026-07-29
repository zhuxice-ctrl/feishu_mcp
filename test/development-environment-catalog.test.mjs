/**
 * Tests for the versioned trusted-component development catalog.
 *
 * The catalog is the single source of truth for which toolchain components
 * may be discovered, planned, and installed. It must reject any caller-
 * controlled URL, executable, free-form switch, script, or registry write:
 * the only permitted install operations are the four reviewed forms.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LOG_LEVEL = "error";

const { loadDevelopmentCatalog, CATALOG_VERSION, ALLOWED_ARCHIVE_HOSTS } =
  await import("../dist/development/environment/catalog.js");

const REPO_CATALOG = path.resolve("config/development-package-catalog.json");
const tmp = await mkdtemp(path.join(tmpdir(), "feishu-catalog-"));
test.after(async () => rm(tmp, { recursive: true, force: true }));

async function writeCatalog(object) {
  const file = path.join(tmp, `catalog-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(object));
  return file;
}

const catalog = loadDevelopmentCatalog(REPO_CATALOG);

test("catalog has version 1", () => {
  assert.equal(catalog.version, CATALOG_VERSION);
  assert.equal(catalog.version, 1);
});

test("component ids are unique", () => {
  const ids = catalog.components.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("includes dotnet sdk 8 and android platform-tools", () => {
  assert(catalog.components.some((c) => c.id === "microsoft.dotnet.sdk.8"));
  assert(catalog.components.some((c) => c.id === "google.android.platform-tools"));
});

test("every target is a supported group", () => {
  const supported = new Set(["android", "dotnet", "native", "electron"]);
  for (const c of catalog.components) {
    assert(supported.has(c.target), `bad target ${c.target} on ${c.id}`);
  }
});

test("winget operations carry exact publisher package ids", () => {
  const winget = catalog.components
    .filter((c) => c.install.kind === "winget")
    .map((c) => c.install.packageId);
  assert(winget.includes("Microsoft.DotNet.SDK.8"));
  assert(winget.includes("Git.Git"));
  for (const op of catalog.components) {
    if (op.install.kind === "winget") {
      assert.equal(op.install.source, "winget");
    }
  }
});

test("visual studio workload ids are exact", () => {
  const workloads = catalog.components
    .filter((c) => c.install.kind === "vs_workload")
    .map((c) => c.install.workloadId);
  assert(workloads.includes("Microsoft.VisualStudio.Workload.ManagedDesktop"));
  assert(workloads.includes("Microsoft.VisualStudio.Workload.NativeDesktop"));
  assert(workloads.includes("Microsoft.VisualStudio.Workload.Universal"));
});

test("verified archive sources are https on allowlisted hosts", () => {
  for (const c of catalog.components) {
    if (c.install.kind !== "verified_archive") continue;
    const url = new URL(c.install.url);
    assert.equal(url.protocol, "https:");
    assert(ALLOWED_ARCHIVE_HOSTS.includes(url.hostname), `host ${url.hostname} not allowlisted`);
    assert.match(c.install.sha256, /^[0-9a-f]{64}$/);
    assert.match(c.install.artifactId, /^[\w.-]+$/);
  }
});

test("android sdk operations reference sdkmanager package paths", () => {
  const sdk = catalog.components.filter((c) => c.install.kind === "android_sdk");
  assert(sdk.length >= 4);
  for (const c of sdk) {
    assert.match(c.install.packageId, /^[a-z0-9_;./-]+$/i);
  }
});

test("rejects an unknown install kind", async () => {
  const file = await writeCatalog({
    version: 1,
    components: [
      {
        id: "evil", target: "native", displayName: "x", versions: ["1"],
        discovery: { kind: "fixed_candidates", values: [] },
        publishers: ["x"],
        install: { kind: "run_command", executable: "cmd.exe" },
      },
    ],
  });
  assert.throws(() => loadDevelopmentCatalog(file));
});

test("rejects an extra caller-controlled url on a winget operation", async () => {
  const file = await writeCatalog({
    version: 1,
    components: [
      {
        id: "microsoft.dotnet.sdk.8", target: "dotnet", displayName: "x", versions: ["8"],
        discovery: { kind: "fixed_candidates", values: [] },
        publishers: ["Microsoft"],
        install: { kind: "winget", packageId: "Microsoft.DotNet.SDK.8", source: "winget", url: "http://evil/x" },
      },
    ],
  });
  assert.throws(() => loadDevelopmentCatalog(file));
});

test("rejects a verified archive with a non-https url", async () => {
  const file = await writeCatalog({
    version: 1,
    components: [
      {
        id: "org.gradle.distribution", target: "native", displayName: "x", versions: ["8"],
        discovery: { kind: "fixed_candidates", values: [] },
        publishers: ["Gradle"],
        install: {
          kind: "verified_archive", artifactId: "gradle-8",
          url: "http://services.gradle.org/distributions/gradle-8.10.2-bin.zip",
          sha256: "31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26",
        },
      },
    ],
  });
  assert.throws(() => loadDevelopmentCatalog(file));
});

test("rejects a verified archive on a non-allowlisted host", async () => {
  const file = await writeCatalog({
    version: 1,
    components: [
      {
        id: "org.gradle.distribution", target: "native", displayName: "x", versions: ["8"],
        discovery: { kind: "fixed_candidates", values: [] },
        publishers: ["Gradle"],
        install: {
          kind: "verified_archive", artifactId: "gradle-8",
          url: "https://evil.example.com/distributions/gradle-8.10.2-bin.zip",
          sha256: "31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26",
        },
      },
    ],
  });
  assert.throws(() => loadDevelopmentCatalog(file));
});

test("rejects an unknown top-level key", async () => {
  const file = await writeCatalog({
    version: 1,
    components: [],
    ownerSid: "S-1-5-32-544",
  });
  assert.throws(() => loadDevelopmentCatalog(file));
});
