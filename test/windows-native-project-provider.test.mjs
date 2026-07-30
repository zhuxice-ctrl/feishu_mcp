import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectRegistry } from "../dist/development/projects/registry.js";
import { NativeProjectProvider, isValidPreset } from "../dist/development/windows/nativeProjectProvider.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-native-"));
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

test("enumerates the native-basic template", () => {
  const p = new NativeProjectProvider();
  const ids = p.templates().map((t) => t.id);
  assert.deepEqual(ids, ["native-basic"]);
});

test("create stages a native-basic executable project", async () => {
  const p = new NativeProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "NativeApp");
  const result = await p.create(
    {
      templateId: "native-basic",
      projectName: "NativeApp",
      packageId: "com.example.app",
      destination: dest,
      profile: { cppStandard: "20", buildType: "executable", withTests: true },
    },
    staging,
  );
  assert.equal(result.root, dest);
  const files = walk(dest).map((f) => path.relative(dest, f).replace(/\\/g, "/")).sort();
  assert.ok(files.includes("CMakeLists.txt"));
  assert.ok(files.includes("CMakePresets.json"));
  assert.ok(files.includes("src/main.cpp"));
  assert.ok(files.includes("tests/main_test.cpp"));
  const presets = readFileSync(path.join(dest, "CMakePresets.json"), "utf8");
  assert.ok(!presets.includes("C:\\"), "no local VS path embedded");
  const cmake = readFileSync(path.join(dest, "CMakeLists.txt"), "utf8");
  assert.ok(!cmake.includes("__"), "tokens resolved");
  assert.ok(cmake.includes("set(CMAKE_CXX_STANDARD 20)"));
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create stages a library without tests", async () => {
  const p = new NativeProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "NativeLib");
  await p.create(
    {
      templateId: "native-basic",
      projectName: "NativeLib",
      packageId: "com.example.app",
      destination: dest,
      profile: { cppStandard: "17", buildType: "library", withTests: false },
    },
    staging,
  );
  const cmake = readFileSync(path.join(dest, "CMakeLists.txt"), "utf8");
  assert.ok(cmake.includes("add_library"));
  // withTests=false: the tests subdirectory is not staged.
  const files = walk(dest).map((f) => path.relative(dest, f).replace(/\\/g, "/"));
  assert.ok(!files.some((f) => f.startsWith("tests/")));
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects an unknown template id", async () => {
  const p = new NativeProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "X");
  await assert.rejects(
    () => p.create(
      { templateId: "native-evil", projectName: "X", packageId: "x", destination: dest, profile: {} },
      staging,
    ),
    /unknown native template/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects a nonempty destination", async () => {
  const p = new NativeProjectProvider();
  const staging = tmpDir();
  const dest = tmpDir();
  writeFileSync(path.join(dest, "pre.txt"), "x");
  await assert.rejects(
    () => p.create(
      { templateId: "native-basic", projectName: "X", packageId: "x", destination: dest, profile: {} },
      staging,
    ),
    /not empty/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects an invalid c++ standard", async () => {
  const p = new NativeProjectProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "X");
  await assert.rejects(
    () => p.create(
      { templateId: "native-basic", projectName: "X", packageId: "x", destination: dest, profile: { cppStandard: "99" } },
      staging,
    ),
    /invalid c\+\+ standard/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("provider registers under the native ecosystem", () => {
  const reg = new ProjectRegistry();
  reg.register(new NativeProjectProvider());
  assert.equal(reg.get("native").ecosystem, "native");
});

test("isValidPreset accepts catalog presets and rejects others", () => {
  assert.ok(isValidPreset("msvc-debug"));
  assert.ok(isValidPreset("ninja-release"));
  assert.ok(!isValidPreset("msvc-evil"));
  assert.ok(!isValidPreset("custom;rm -rf /"));
});
