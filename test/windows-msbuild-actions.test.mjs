import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMsbuildCommand } from "../dist/development/windows/commands.js";
import { planMsbuildAction, digestMsbuildProject, isFixedMsbuildTarget } from "../dist/development/windows/msbuild.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-msbuild-act-"));
}

function toolchain() {
  return {
    dotnet: "C:\\dotnet.exe", msbuild: "C:\\MSBuild.exe", vsInstanceId: "abc",
    signtool: "C:\\signtool.exe", cmake: "C:\\cmake.exe", ninja: "C:\\ninja.exe",
    node: "C:\\node.exe", npm: "C:\\npm.cmd", corepack: "C:\\corepack.cmd", git: "C:\\git.exe",
  };
}

test("build maps to fixed MSBuild args with /m /t /p:Configuration /p:Platform", () => {
  const cmd = buildMsbuildCommand(toolchain(), {
    action: "build", solutionOrProject: "App.sln", target: "Build",
    configuration: "Release", platform: "x64", maxCpuCount: 4,
  });
  assert.deepEqual(cmd.args, [
    "App.sln", "/nologo", "/m:4", "/t:Build",
    "/p:Configuration=Release", "/p:Platform=x64",
  ]);
});

test("rebuild target allowed", () => {
  const cmd = buildMsbuildCommand(toolchain(), {
    action: "rebuild", solutionOrProject: "App.sln", target: "Rebuild",
    configuration: "Debug", platform: "AnyCPU", maxCpuCount: 2,
  });
  assert.ok(cmd.args.includes("/t:Rebuild"));
  assert.ok(cmd.args.includes("/m:2"));
});

test("caller cannot supply arbitrary MSBuild properties — schema strict", () => {
  assert.throws(() =>
    buildMsbuildCommand(toolchain(), {
      action: "build", solutionOrProject: "App.sln", target: "Build",
      configuration: "Release", platform: "x64", maxCpuCount: 4,
      extraProperty: "/p:Evil=true",
    }),
  );
});

test("maxCpuCount is bounded", () => {
  assert.throws(() =>
    buildMsbuildCommand(toolchain(), {
      action: "build", solutionOrProject: "App.sln", target: "Build",
      configuration: "Release", platform: "x64", maxCpuCount: 999,
    }),
  );
});

test("planMsbuildAction sets artifact roots for Build", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.sln"), "");
  const plan = planMsbuildAction(toolchain(), {
    root, solutionOrProject: "App.sln", target: "Build",
    configuration: "Release", platform: "x64", timeoutMs: 60000,
  });
  assert.equal(plan.executable, "C:\\MSBuild.exe");
  assert.ok(plan.artifactRoots.some((r) => r.endsWith("bin")));
  assert.ok(plan.artifactRoots.some((r) => r.endsWith("AppPackages")));
  assert.equal(plan.scriptDigest.length, 64);
  rmSync(root, { recursive: true, force: true });
});

test("Test target sets TestResults artifact root only", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.sln"), "");
  const plan = planMsbuildAction(toolchain(), {
    root, solutionOrProject: "App.sln", target: "Test",
    configuration: "Debug", platform: "AnyCPU", timeoutMs: 60000,
  });
  assert.ok(plan.artifactRoots.every((r) => r.endsWith("TestResults")));
  rmSync(root, { recursive: true, force: true });
});

test("isFixedMsbuildTarget accepts fixed targets", () => {
  assert.ok(isFixedMsbuildTarget("Build"));
  assert.ok(isFixedMsbuildTarget("Rebuild"));
  assert.ok(isFixedMsbuildTarget("Restore"));
  assert.ok(isFixedMsbuildTarget("Test"));
  assert.ok(!isFixedMsbuildTarget("Evil"));
});

test("digestMsbuildProject changes when solution changes", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.sln"), "v1");
  const d1 = digestMsbuildProject(root, "App.sln");
  writeFileSync(path.join(root, "App.sln"), "v2");
  const d2 = digestMsbuildProject(root, "App.sln");
  assert.notEqual(d1, d2);
  rmSync(root, { recursive: true, force: true });
});
