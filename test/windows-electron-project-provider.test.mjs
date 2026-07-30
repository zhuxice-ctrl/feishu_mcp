import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectRegistry } from "../dist/development/projects/registry.js";
import { ElectronProjectProvider } from "../dist/development/windows/electronProjectProvider.js";
import { inspectElectronManifest, currentManifestLockDigest } from "../dist/development/windows/electronManifest.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-electron-"));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("enumerates the electron-basic template", () => {
  const p = new ElectronProjectProvider();
  const ids = p.templates().map((t) => t.id);
  assert.deepEqual(ids, ["electron-basic"]);
});

test("create stages a locked Electron project with exact dependencies", async () => {
  const p = new ElectronProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "ElectronApp");
  const result = await p.create(
    {
      templateId: "electron-basic",
      projectName: "ElectronApp",
      packageId: "com.example.app",
      destination: dest,
      profile: { packageManager: "npm" },
    },
    staging,
  );
  assert.equal(result.root, dest);
  const files = walk(dest).map((f) => path.relative(dest, f).replace(/\\/g, "/")).sort();
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("package-lock.json"));
  assert.ok(files.includes("src/main.js"));
  assert.ok(files.includes("src/preload.js"));
  assert.ok(files.includes("src/index.html"));
  // Pinned versions present in both package.json and lockfile.
  const pkg = JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8"));
  assert.equal(pkg.dependencies.electron, "30.0.0");
  assert.equal(pkg.devDependencies["electron-builder"], "24.13.3");
  // No install was performed during rendering (no node_modules).
  assert.ok(!files.some((f) => f.startsWith("node_modules/")));
  // Scripts are exactly start/test/package.
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["package", "start", "test"]);
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects an unknown template id", async () => {
  const p = new ElectronProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "X");
  await assert.rejects(
    () => p.create(
      { templateId: "electron-evil", projectName: "X", packageId: "com.example.x", destination: dest, profile: {} },
      staging,
    ),
    /unknown electron template/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects a nonempty destination", async () => {
  const p = new ElectronProjectProvider();
  const staging = tmpDir();
  const dest = tmpDir();
  writeFileSync(path.join(dest, "pre.txt"), "x");
  await assert.rejects(
    () => p.create(
      { templateId: "electron-basic", projectName: "X", packageId: "com.example.x", destination: dest, profile: {} },
      staging,
    ),
    /not empty/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("provider registers under the electron ecosystem", () => {
  const reg = new ProjectRegistry();
  reg.register(new ElectronProjectProvider());
  assert.equal(reg.get("electron").ecosystem, "electron");
});
