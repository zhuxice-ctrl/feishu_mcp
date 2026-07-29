/**
 * Tests for trusted executable discovery.
 *
 * The resolver canonicalizes candidate paths, denies junction/symlink escape
 * outside an allowed root, injects the publisher/checksum verifier (so tests
 * never touch a real Authenticode signature), invalidates its cache when a
 * file changes, and reports ambiguous candidates. It never accepts a
 * caller-supplied executable, URL, or argument list.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFakeExecutable,
  replaceFixture,
  makeSymlink,
} from "./fixtures/fake-toolchain.mjs";

process.env.LOG_LEVEL = "error";

const { TrustedExecutableResolver } =
  await import("../dist/development/environment/trustedExecutable.js");

const root = await mkdtemp(path.join(tmpdir(), "feishu-tex-"));
const outside = await mkdtemp(path.join(tmpdir(), "feishu-tex-out-"));
test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function makeVerifier(publisher, trusted, countRef) {
  return async () => {
    countRef.n += 1;
    return { publisher, trusted };
  };
}

test("resolves a trusted candidate and reports ready state", async () => {
  const file = await createFakeExecutable(root, "dotnet/dotnet.exe", { version: "8.0.1" });
  const count = { n: 0 };
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Microsoft Corporation", true, count),
    candidates: [
      { target: "dotnet", componentId: "microsoft.dotnet.sdk.8", path: file, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolve("dotnet");
  assert.equal(result.trusted, true);
  assert.equal(result.state, "ready");
  assert.equal(result.publisher, "Microsoft Corporation");
  assert.equal(result.version, "8.0.1");
  assert.match(result.fileIdentity, /^[0-9a-f]{64}$/);
  assert.equal(result.realPath, path.resolve(file));
});

test("cache invalidates after the fixture is replaced", async () => {
  const file = await createFakeExecutable(root, "gradle/bin/gradle.bat", { version: "8.10.2" });
  const count = { n: 0 };
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Gradle Inc.", true, count),
    candidates: [
      { target: "android", componentId: "org.gradle.distribution", path: file, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const first = await resolver.resolve("android");
  const firstIdentity = first.fileIdentity;
  assert.equal(first.trusted, true);
  // cached: a second resolve without changes must not re-run the verifier
  const cached = await resolver.resolve("android");
  assert.equal(cached.fileIdentity, firstIdentity);
  assert.equal(count.n, 1);
  await replaceFixture(file);
  const second = await resolver.resolve("android");
  assert.notEqual(second.fileIdentity, firstIdentity);
  assert.equal(count.n, 2);
});

test("denies a symlink that escapes the allowed root", async () => {
  const realOutside = await createFakeExecutable(outside, "rogue.exe", { version: "1.0.0" });
  const link = path.join(root, "escape", "link.exe");
  await makeSymlink(link, realOutside);
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Evil", true, { n: 0 }),
    candidates: [
      { target: "native", componentId: "rogue", path: link, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolve("native");
  assert.equal(result.trusted, false);
  assert.equal(result.state, "untrusted");
  assert.match(result.reason || "", /escape|outside/i);
});

test("reports a missing candidate", async () => {
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Microsoft Corporation", true, { n: 0 }),
    candidates: [
      { target: "native", componentId: "kitware.cmake", path: path.join(root, "missing", "cmake.exe"), discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolve("native");
  assert.equal(result.state, "missing");
  assert.equal(result.trusted, false);
});

test("reports ambiguous candidates as incompatible", async () => {
  const a = await createFakeExecutable(root, "amb/a.exe", { version: "1.0.0" });
  const b = await createFakeExecutable(root, "amb/b.exe", { version: "1.0.0" });
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Microsoft Corporation", true, { n: 0 }),
    candidates: [
      { target: "native", componentId: "amb", path: a, discovery: "fixed_candidates" },
      { target: "native", componentId: "amb", path: b, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolve("native");
  assert.equal(result.ambiguous, true);
  assert.equal(result.state, "incompatible");
});

test("untrusted publisher yields untrusted state", async () => {
  const file = await createFakeExecutable(root, "node/node.exe", { version: "22.12.0" });
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("Unknown Publisher", false, { n: 0 }),
    candidates: [
      { target: "electron", componentId: "openjs.nodejs.lts", path: file, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolve("electron");
  assert.equal(result.trusted, false);
  assert.equal(result.state, "untrusted");
});

test("resolves by component id", async () => {
  const file = await createFakeExecutable(root, "git/git.exe", { version: "2.47.1" });
  const resolver = new TrustedExecutableResolver({
    verify: makeVerifier("The Git Development Community", true, { n: 0 }),
    candidates: [
      { target: "native", componentId: "git.git", path: file, discovery: "fixed_candidates" },
    ],
    allowedRoots: [root],
  });
  const result = await resolver.resolveComponent("git.git");
  assert.equal(result.state, "ready");
  assert.equal(result.componentId, "git.git");
});
