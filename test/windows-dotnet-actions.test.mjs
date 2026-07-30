import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDotnetCommand } from "../dist/development/windows/commands.js";
import { planDotnetAction, digestDotnetProject, hasDependencyLock } from "../dist/development/windows/dotnet.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-dotnet-act-"));
}

function toolchain() {
  return {
    dotnet: "C:\\dotnet\\dotnet.exe",
    msbuild: "C:\\msbuild\\MSBuild.exe",
    vsInstanceId: "abc",
    signtool: "C:\\signtool.exe",
    cmake: "C:\\cmake.exe",
    ninja: "C:\\ninja.exe",
    node: "C:\\node.exe",
    npm: "C:\\npm.cmd",
    corepack: "C:\\corepack.cmd",
    git: "C:\\git.exe",
  };
}

test("restore maps to --locked-mode when packages.lock.json exists", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "packages.lock.json"), "{}");
  assert.ok(hasDependencyLock(root));
  const cmd = buildDotnetCommand(toolchain(), {
    action: "restore", projectOrSolution: "App.csproj", lockedMode: true,
  });
  assert.deepEqual(cmd.args, ["restore", "App.csproj", "--locked-mode"]);
  rmSync(root, { recursive: true, force: true });
});

test("restore omits --locked-mode when no lock exists", () => {
  const cmd = buildDotnetCommand(toolchain(), {
    action: "restore", projectOrSolution: "App.csproj", lockedMode: false,
  });
  assert.deepEqual(cmd.args, ["restore", "App.csproj"]);
});

test("build maps to build --no-restore with config/framework", () => {
  const cmd = buildDotnetCommand(toolchain(), {
    action: "build", projectOrSolution: "App.csproj",
    configuration: "Release", framework: "net8.0", noRestore: true,
  });
  assert.deepEqual(cmd.args, ["build", "App.csproj", "--no-restore", "--configuration", "Release", "--framework", "net8.0"]);
});

test("test maps to test --no-build --logger trx", () => {
  const cmd = buildDotnetCommand(toolchain(), {
    action: "test", projectOrSolution: "App.csproj",
    configuration: "Debug", noBuild: true,
  });
  assert.deepEqual(cmd.args, ["test", "App.csproj", "--no-build", "--logger", "trx", "--configuration", "Debug"]);
});

test("publish maps to publish --no-build with optional runtime", () => {
  const cmd = buildDotnetCommand(toolchain(), {
    action: "publish", projectOrSolution: "App.csproj",
    configuration: "Release", runtime: "win-x64", noBuild: true,
  });
  assert.deepEqual(cmd.args, ["publish", "App.csproj", "--no-build", "--configuration", "Release", "--runtime", "win-x64"]);
});

test("generate_dependency_lock maps to restore --use-lock-file", () => {
  const cmd = buildDotnetCommand(toolchain(), {
    action: "generate_dependency_lock", projectOrSolution: "App.csproj",
  });
  assert.deepEqual(cmd.args, ["restore", "App.csproj", "--use-lock-file"]);
});

test("caller cannot supply arbitrary switches — schema is strict", () => {
  assert.throws(() =>
    buildDotnetCommand(toolchain(), {
      action: "build", projectOrSolution: "App.csproj", maliciousFlag: "--eval",
    }),
  );
});

test("planDotnetAction digests project scripts and sets artifact roots", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.csproj"), "<Project/>");
  const plan = planDotnetAction(toolchain(), {
    root, projectOrSolution: "App.csproj", action: "build",
    configuration: "Release", timeoutMs: 60000,
  });
  assert.equal(plan.executable, "C:\\dotnet\\dotnet.exe");
  assert.equal(plan.cwd, root);
  assert.equal(plan.scriptDigest.length, 64);
  assert.ok(plan.artifactRoots.length > 0);
  assert.deepEqual(plan.successExitCodes, [0]);
  rmSync(root, { recursive: true, force: true });
});

test("digestDotnetProject redacts sensitive key=value entries", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.csproj"), "<Project/>");
  // A properties-style file with a sensitive key: the value is redacted so the
  // literal secret never enters the digest input.
  writeFileSync(path.join(root, "Directory.Packages.props"), "NuGetPassword=secret123\nVersion=1.0.0\n");
  const d1 = digestDotnetProject(root, "App.csproj");
  // Changing only the sensitive value must NOT change the digest (redacted).
  writeFileSync(path.join(root, "Directory.Packages.props"), "NuGetPassword=different\nVersion=1.0.0\n");
  const d2 = digestDotnetProject(root, "App.csproj");
  assert.equal(d1, d2, "redacted sensitive value should not affect digest");
  // Changing a non-sensitive field must change the digest.
  writeFileSync(path.join(root, "Directory.Packages.props"), "NuGetPassword=different\nVersion=2.0.0\n");
  const d3 = digestDotnetProject(root, "App.csproj");
  assert.notEqual(d1, d3);
  rmSync(root, { recursive: true, force: true });
});

test("test action sets TestResults artifact root", () => {
  const root = tmpDir();
  writeFileSync(path.join(root, "App.csproj"), "<Project/>");
  const plan = planDotnetAction(toolchain(), {
    root, projectOrSolution: "App.csproj", action: "test",
    configuration: "Debug", timeoutMs: 60000,
  });
  assert.ok(plan.artifactRoots.some((r) => r.endsWith("TestResults")));
  rmSync(root, { recursive: true, force: true });
});
