import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { detectWindowsProject, lockfileToManager, ARCHITECTURES, CONFIGURATIONS } = await import(
  "../dist/development/windows/projectDetector.js"
);

async function tmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `feishu-win-detect-${prefix}-`));
}

test("detects a .NET ecosystem from a .csproj", async () => {
  const root = await tmp("dotnet");
  await writeFile(path.join(root, "App.csproj"), "<Project />");
  const result = await detectWindowsProject(root);
  assert.deepEqual(result.ecosystems, ["dotnet"]);
  assert.equal(result.entrypoints.length, 1);
  assert.equal(result.entrypoints[0].kind, "project");
  assert.equal(result.entrypoints[0].relativePath, "App.csproj");
  assert.equal(result.entrypoints[0].ecosystem, "dotnet");
  assert.equal(result.packageManager, null);
  await rm(root, { recursive: true, force: true });
});

test("detects a .NET solution and sorts it before projects", async () => {
  const root = await tmp("sln");
  await writeFile(path.join(root, "App.sln"), "");
  await writeFile(path.join(root, "Lib.csproj"), "<Project />");
  const result = await detectWindowsProject(root);
  assert.deepEqual(result.ecosystems, ["dotnet"]);
  assert.equal(result.entrypoints.length, 2);
  assert.equal(result.entrypoints[0].kind, "solution");
  assert.equal(result.entrypoints[0].relativePath, "App.sln");
  assert.equal(result.entrypoints[1].kind, "project");
  await rm(root, { recursive: true, force: true });
});

test("detects a native CMake project", async () => {
  const root = await tmp("cmake");
  await writeFile(path.join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)");
  await writeFile(path.join(root, "CMakePresets.json"), "{}");
  const result = await detectWindowsProject(root);
  assert.deepEqual(result.ecosystems, ["native"]);
  assert.equal(result.entrypoints[0].relativePath, "CMakeLists.txt");
  await rm(root, { recursive: true, force: true });
});

test("detects a native .vcxproj project", async () => {
  const root = await tmp("vcxproj");
  await writeFile(path.join(root, "Native.vcxproj"), "<Project />");
  const result = await detectWindowsProject(root);
  assert.deepEqual(result.ecosystems, ["native"]);
  assert.equal(result.entrypoints[0].ecosystem, "native");
  await rm(root, { recursive: true, force: true });
});

test("detects an Electron project and maps a lockfile to a package manager", async () => {
  const root = await tmp("electron");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app", dependencies: { electron: "^30.0.0" } }),
  );
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const result = await detectWindowsProject(root);
  assert.ok(result.ecosystems.includes("electron"));
  assert.deepEqual(result.packageManager, { manager: "npm", lockfile: "package-lock.json" });
  await rm(root, { recursive: true, force: true });
});

test("maps pnpm and yarn lockfiles correctly", async () => {
  const root = await tmp("lockfiles");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app", devDependencies: { electron: "^30.0.0" } }),
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  assert.equal((await detectWindowsProject(root)).packageManager.manager, "pnpm");
  await rm(root, { recursive: true, force: true });

  const root2 = await tmp("yarn");
  await writeFile(
    path.join(root2, "package.json"),
    JSON.stringify({ name: "app", dependencies: { electron: "^30" } }),
  );
  await writeFile(path.join(root2, "yarn.lock"), "");
  assert.equal((await detectWindowsProject(root2)).packageManager.manager, "yarn");
  await rm(root2, { recursive: true, force: true });
});

test("reports mixed ecosystems deterministically", async () => {
  const root = await tmp("mixed");
  await writeFile(path.join(root, "App.csproj"), "<Project />");
  await writeFile(path.join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shell", devDependencies: { electron: "^30" } }),
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  const result = await detectWindowsProject(root);
  assert.deepEqual(result.ecosystems, ["dotnet", "native", "electron"]);
  await rm(root, { recursive: true, force: true });
});

test("rejects a junction escape as an entrypoint", async () => {
  const root = await tmp("junction");
  const outside = await tmp("outside");
  await writeFile(path.join(outside, "App.csproj"), "<Project />");
  // Create a symlink (junction-equivalent on POSIX) inside root pointing out.
  try {
    await symlink(outside, path.join(root, "escaped"), "dir");
  } catch {
    // Some platforms/sandbox configs disallow symlink creation; skip gracefully.
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    return;
  }
  // A symlinked directory is not a manifest file; nothing inside it is read.
  const result = await detectWindowsProject(root);
  assert.equal(result.entrypoints.length, 0);
  assert.deepEqual(result.ecosystems, []);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("does not execute package scripts or msbuild during inspection", async () => {
  const root = await tmp("noexec");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: { electron: "^30" },
      scripts: { malicious: "rm -rf /" },
    }),
  );
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const result = await detectWindowsProject(root);
  // The malicious script is never executed; inspection only reads manifests.
  assert.ok(result.ecosystems.includes("electron"));
  assert.ok(existsSync(path.join(root, "package.json")));
  await rm(root, { recursive: true, force: true });
});

test("lockfileToManager maps canonical names", () => {
  assert.equal(lockfileToManager("package-lock.json"), "npm");
  assert.equal(lockfileToManager("pnpm-lock.yaml"), "pnpm");
  assert.equal(lockfileToManager("yarn.lock"), "yarn");
  assert.equal(lockfileToManager("unknown.lock"), null);
});

test("exposes architecture and configuration enums", () => {
  assert.deepEqual([...ARCHITECTURES], ["x64", "x86", "ARM64"]);
  assert.deepEqual([...CONFIGURATIONS], ["Debug", "Release"]);
});
