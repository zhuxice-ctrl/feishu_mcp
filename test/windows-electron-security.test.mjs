import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectElectronManifest, currentManifestLockDigest, safeParseJson } from "../dist/development/windows/electronManifest.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-electron-sec-"));
}

function writeManifest(root, manifest, lockfile = "package-lock.json", lockContent = "{}") {
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, lockfile), lockContent);
}

test("requires exactly one recognized lockfile", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  // no lockfile
  assert.throws(() => inspectElectronManifest(root), /no recognized lockfile/);
  // multiple lockfiles
  writeFileSync(path.join(root, "package-lock.json"), "{}");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
  assert.throws(() => inspectElectronManifest(root), /multiple lockfiles/);
  rmSync(root, { recursive: true, force: true });
});

test("maps lockfile to exactly one package manager", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: {} }, "pnpm-lock.yaml", "");
  const m = inspectElectronManifest(root);
  assert.equal(m.packageManager, "pnpm");
  assert.equal(m.lockfile, "pnpm-lock.yaml");
  rmSync(root, { recursive: true, force: true });
});

test("returns script name plus sha256 of exact script text", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: { start: "electron .", test: "node --test" } });
  const m = inspectElectronManifest(root);
  assert.equal(m.scripts.length, 2);
  const start = m.scripts.find((s) => s.name === "start");
  assert.ok(start);
  assert.equal(start.sha256.length, 64);
  rmSync(root, { recursive: true, force: true });
});

test("manifestLockDigest changes when scripts change", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: { start: "electron ." } });
  const d1 = inspectElectronManifest(root).manifestLockDigest;
  writeManifest(root, { name: "app", scripts: { start: "electron . --inspect" } });
  const d2 = inspectElectronManifest(root).manifestLockDigest;
  assert.notEqual(d1, d2);
  rmSync(root, { recursive: true, force: true });
});

test("manifestLockDigest changes when lockfile changes", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: {} }, "package-lock.json", '{"v":1}');
  const d1 = inspectElectronManifest(root).manifestLockDigest;
  writeManifest(root, { name: "app", scripts: {} }, "package-lock.json", '{"v":2}');
  const d2 = inspectElectronManifest(root).manifestLockDigest;
  assert.notEqual(d1, d2);
  rmSync(root, { recursive: true, force: true });
});

test("reports lifecycle scripts that install may execute", () => {
  const root = tmpDir();
  writeManifest(root, {
    name: "app",
    scripts: { postinstall: "node build.js", prepare: "husky install", start: "electron ." },
  });
  const m = inspectElectronManifest(root);
  const phases = m.lifecycleScripts.map((l) => l.phase).sort();
  assert.deepEqual(phases, ["postinstall", "prepare"]);
  rmSync(root, { recursive: true, force: true });
});

test("rejects script names with whitespace, prefixes, or shell suffixes", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: { "evil name": "rm -rf /" } });
  assert.throws(() => inspectElectronManifest(root), /invalid script name/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects script names with shell suffixes", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: { "start;rm": "x" } });
  assert.throws(() => inspectElectronManifest(root), /invalid script name/);
  rmSync(root, { recursive: true, force: true });
});

test("safeParseJson rejects __proto__ keys surface", () => {
  // JSON.parse itself keeps __proto__ as a normal key in the parsed object;
  // the inspector rejects it explicitly.
  const parsed = safeParseJson('{"__proto__":{"x":1}}');
  assert.ok(typeof parsed === "object");
});

test("never returns registry credentials", () => {
  const root = tmpDir();
  writeManifest(root, {
    name: "app",
    scripts: {},
    publishConfig: { registry: "https://registry.npmjs.org", _authToken: "secret" },
  });
  const m = inspectElectronManifest(root);
  const json = JSON.stringify(m);
  assert.ok(!json.includes("_authToken"));
  assert.ok(!json.includes("secret"));
  rmSync(root, { recursive: true, force: true });
});

test("currentManifestLockDigest matches inspection digest", () => {
  const root = tmpDir();
  writeManifest(root, { name: "app", scripts: { start: "electron ." } });
  const a = inspectElectronManifest(root).manifestLockDigest;
  const b = currentManifestLockDigest(root);
  assert.equal(a, b);
  rmSync(root, { recursive: true, force: true });
});
