/**
 * Tests for deterministic environment snapshots.
 *
 * The inspector sorts components by id, excludes absolute paths from the
 * public status, hashes the full private canonical snapshot into a stable
 * digest, and maps each component to ready|missing|untrusted|incompatible
 * with a remediation hint. No environment variable or user path leaks into
 * the public response.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFakeExecutable } from "./fixtures/fake-toolchain.mjs";

process.env.LOG_LEVEL = "error";

const { loadDevelopmentCatalog, catalogDigest } =
  await import("../dist/development/environment/catalog.js");
const { TrustedExecutableResolver } =
  await import("../dist/development/environment/trustedExecutable.js");
const { EnvironmentInspector, publicComponentStatus } =
  await import("../dist/development/environment/inspect.js");

const root = await mkdtemp(path.join(tmpdir(), "feishu-inspect-"));
const tmp = await mkdtemp(path.join(tmpdir(), "feishu-inspect-cat-"));
test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

async function writeCatalog(object) {
  const file = path.join(tmp, `cat-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(object));
  return file;
}

const minimalCatalog = {
  version: 1,
  components: [
    {
      id: "microsoft.dotnet.sdk.8",
      target: "dotnet",
      displayName: ".NET SDK 8",
      versions: ["8.0.404"],
      discovery: { kind: "fixed_candidates", values: [] },
      publishers: ["Microsoft Corporation"],
      install: { kind: "winget", packageId: "Microsoft.DotNet.SDK.8", source: "winget" },
    },
    {
      id: "google.android.platform-tools",
      target: "android",
      displayName: "Android platform-tools",
      versions: ["35.0.2"],
      discovery: { kind: "fixed_candidates", values: [] },
      publishers: ["Google LLC"],
      install: { kind: "android_sdk", packageId: "platform-tools" },
    },
  ],
};

test("snapshot is deterministic and digest matches catalog digest", async () => {
  const cat = loadDevelopmentCatalog(await writeCatalog(minimalCatalog));
  const dotnet = await createFakeExecutable(root, "dotnet/dotnet.exe", { version: "8.0.404" });
  const resolver = new TrustedExecutableResolver({
    verify: async () => ({ publisher: "Microsoft Corporation", trusted: true }),
    candidates: [
      { target: "dotnet", componentId: "microsoft.dotnet.sdk.8", path: dotnet, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const inspector = new EnvironmentInspector({ catalog: cat, resolver });
  const first = await inspector.inspect();
  const second = await inspector.inspect();
  assert.equal(first.snapshot.digest, second.snapshot.digest);
  assert.equal(first.snapshot.catalogDigest, catalogDigest(cat));
});

test("public status excludes paths and env, includes remediation for missing", async () => {
  const cat = loadDevelopmentCatalog(await writeCatalog(minimalCatalog));
  const resolver = new TrustedExecutableResolver({
    verify: async () => ({ publisher: "Google LLC", trusted: true }),
    candidates: [],
    allowedRoots: [root],
  });
  const inspector = new EnvironmentInspector({ catalog: cat, resolver });
  const { publicStatus } = await inspector.inspect();
  assert.equal(publicStatus.length, 2);
  const serialized = JSON.stringify(publicStatus);
  assert.equal(serialized.includes(root), false, "public status must not contain file paths");
  assert.equal(serialized.includes("path"), false, "public status must not expose path fields");
  const platform = publicStatus.find((s) => s.componentId === "google.android.platform-tools");
  assert.equal(platform.state, "missing");
  assert.ok(platform.remediation, "missing component needs a remediation hint");
});

test("incompatible version is reported", async () => {
  const cat = loadDevelopmentCatalog(await writeCatalog(minimalCatalog));
  const dotnet = await createFakeExecutable(root, "dotnet/bad.exe", { version: "7.0.100" });
  const resolver = new TrustedExecutableResolver({
    verify: async () => ({ publisher: "Microsoft Corporation", trusted: true }),
    candidates: [
      { target: "dotnet", componentId: "microsoft.dotnet.sdk.8", path: dotnet, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const inspector = new EnvironmentInspector({ catalog: cat, resolver });
  const { publicStatus } = await inspector.inspect();
  const dotnetStatus = publicStatus.find((s) => s.componentId === "microsoft.dotnet.sdk.8");
  assert.equal(dotnetStatus.state, "incompatible");
});

test("untrusted publisher is reported", async () => {
  const cat = loadDevelopmentCatalog(await writeCatalog(minimalCatalog));
  const dotnet = await createFakeExecutable(root, "dotnet/untrusted.exe", { version: "8.0.404" });
  const resolver = new TrustedExecutableResolver({
    verify: async () => ({ publisher: "Unknown", trusted: false }),
    candidates: [
      { target: "dotnet", componentId: "microsoft.dotnet.sdk.8", path: dotnet, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const inspector = new EnvironmentInspector({ catalog: cat, resolver });
  const { publicStatus } = await inspector.inspect();
  const dotnetStatus = publicStatus.find((s) => s.componentId === "microsoft.dotnet.sdk.8");
  assert.equal(dotnetStatus.state, "untrusted");
});

test("publicComponentStatus helper redacts private fields", () => {
  const redacted = publicComponentStatus({
    componentId: "x",
    displayName: "X",
    state: "ready",
    version: "1.0.0",
    realPath: "C:\\secret\\x.exe",
    publisher: "Pub",
    discovery: "fixed_candidates",
    fileIdentity: "abc",
  });
  const keys = Object.keys(redacted);
  assert.deepEqual(keys.sort(), ["componentId", "displayName", "remediation", "state", "version"].sort());
});
