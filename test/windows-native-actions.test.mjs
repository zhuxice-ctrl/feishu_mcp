import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNativeCommand } from "../dist/development/windows/commands.js";
import { planNativeAction, digestNativeProject, isBuildDirConfined, discoverCmakeTargets } from "../dist/development/windows/native.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-native-act-"));
}

function toolchain() {
  return {
    dotnet: "C:\\dotnet.exe", msbuild: "C:\\MSBuild.exe", vsInstanceId: "abc",
    signtool: "C:\\signtool.exe", cmake: "C:\\cmake.exe", ninja: "C:\\ninja.exe",
    node: "C:\\node.exe", npm: "C:\\npm.cmd", corepack: "C:\\corepack.cmd", git: "C:\\git.exe",
  };
}

test("configure with approved preset uses --preset", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "configure", sourceDir: "src", buildDir: "build", preset: "ninja-debug",
  });
  assert.deepEqual(cmd.args, ["--preset", "ninja-debug", "-S", "src", "-B", "build"]);
});

test("configure without preset uses generator", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "configure", sourceDir: "src", buildDir: "build", configuration: "Debug",
  });
  assert.ok(cmd.args.includes("-G"));
  assert.ok(cmd.args.includes("-DCMAKE_BUILD_TYPE=Debug"));
});

test("build maps to --build --config --target", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "build", buildDir: "build", target: "myapp", configuration: "Release",
  });
  assert.deepEqual(cmd.args, ["--build", "build", "--config", "Release", "--target", "myapp"]);
});

test("test maps to --build --target test --config", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "test", buildDir: "build", configuration: "Debug",
  });
  assert.deepEqual(cmd.args, ["--build", "build", "--target", "test", "--config", "Debug"]);
});

test("install maps to --install --prefix", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "install", buildDir: "build", configuration: "Release", prefix: "C:\\install",
  });
  assert.deepEqual(cmd.args, ["--install", "build", "--config", "Release", "--prefix", "C:\\install"]);
});

test("package maps to cpack --config", () => {
  const cmd = buildNativeCommand(toolchain(), {
    action: "package", buildDir: "build", configuration: "Release",
  });
  assert.ok(cmd.executable.endsWith("cpack"));
  assert.ok(cmd.args.some((a) => a.includes("CPackConfig.cmake")));
  assert.ok(cmd.args.includes("-C"));
  assert.ok(cmd.args.includes("Release"));
});

test("malicious cache variable rejected by strict schema", () => {
  assert.throws(() =>
    buildNativeCommand(toolchain(), {
      action: "configure", sourceDir: "src", buildDir: "build",
      cacheVariable: "EVIL=;rm -rf /",
    }),
  );
});

test("planNativeAction rejects an unapproved preset", () => {
  const root = tmpDir();
  assert.throws(
    () => planNativeAction(toolchain(), {
      root, sourceDir: root, buildDir: path.join(root, "build"),
      action: "configure", preset: "custom-evil", configuration: "Debug", timeoutMs: 60000,
    }),
    /unapproved cmake preset/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("planNativeAction rejects build dir escaping root", () => {
  const root = tmpDir();
  assert.throws(
    () => planNativeAction(toolchain(), {
      root, sourceDir: root, buildDir: path.join(root, "..", "escape"),
      action: "build", configuration: "Debug", target: "app", timeoutMs: 60000,
    }),
    /escapes project root/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("planNativeAction rejects invalid configuration", () => {
  const root = tmpDir();
  assert.throws(
    () => planNativeAction(toolchain(), {
      root, sourceDir: root, buildDir: path.join(root, "build"),
      action: "build", configuration: "Evil", target: "app", timeoutMs: 60000,
    }),
    /invalid cmake configuration/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("planNativeAction rejects parallelism out of bounds", () => {
  const root = tmpDir();
  assert.throws(
    () => planNativeAction(toolchain(), {
      root, sourceDir: root, buildDir: path.join(root, "build"),
      action: "build", configuration: "Debug", target: "app", timeoutMs: 60000,
      parallelism: 999,
    }),
    /invalid parallelism/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("isBuildDirConfined accepts nested and rejects escape", () => {
  const root = tmpDir();
  assert.ok(isBuildDirConfined(root, path.join(root, "build")));
  assert.ok(isBuildDirConfined(root, path.join(root, "sub", "build")));
  assert.ok(!isBuildDirConfined(root, path.join(root, "..", "escape")));
  rmSync(root, { recursive: true, force: true });
});

test("digestNativeProject changes when CMakeLists changes", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "CMakeLists.txt"), "v1");
  const d1 = digestNativeProject(root, root);
  writeFileSync(path.join(root, "CMakeLists.txt"), "v2");
  const d2 = digestNativeProject(root, root);
  assert.notEqual(d1, d2);
  rmSync(root, { recursive: true, force: true });
});

test("discoverCmakeTargets reads File API replies", () => {
  const root = tmpDir();
  const buildDir = path.join(root, "build");
  const replyDir = path.join(buildDir, ".cmake", "api", "v1", "reply");
  mkdirSync(replyDir, { recursive: true });
  writeFileSync(path.join(replyDir, "target-myapp.json"), JSON.stringify({ targets: [{ name: "myapp" }, { name: "tests" }] }));
  const targets = discoverCmakeTargets(buildDir);
  assert.ok(targets.includes("myapp"));
  assert.ok(targets.includes("tests"));
  rmSync(root, { recursive: true, force: true });
});
