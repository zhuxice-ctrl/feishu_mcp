import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

const { resolveWindowsToolchain, WINDOWS_TOOLCHAIN_COMPONENTS } = await import(
  "../dist/development/windows/toolchain.js"
);

/** Build a fake environment snapshot with ready components. */
function snapshot(components, overrides = {}) {
  return {
    version: 1,
    catalogDigest: "deadbeef",
    digest: "cafebabe",
    createdAt: "2026-07-30T00:00:00Z",
    components: components.map((id) => ({
      componentId: id,
      target: "native",
      state: overrides[id]?.state ?? "ready",
      realPath: overrides[id]?.realPath ?? `C:\\tools\\${id}\\bin.exe`,
      fileIdentity: "sha256:abc",
      version: "1.0.0",
      ...(overrides[id]?.discovery ? { discovery: overrides[id].discovery } : {}),
    })),
  };
}

test("resolves a fully-ready Windows toolchain", () => {
  const snap = snapshot([...WINDOWS_TOOLCHAIN_COMPONENTS], {
    "microsoft.visualstudio.2022.buildtools": {
      realPath: "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools",
      discovery: "1234abcd5678ef90",
    },
    "microsoft.windows.sdk.11": {
      realPath: "C:\\Program Files (x86)\\Windows Kits\\10",
    },
    "openjs.nodejs.lts": {
      realPath: "C:\\Program Files\\nodejs\\node.exe",
    },
  });
  const result = resolveWindowsToolchain(snap);
  assert.ok(!("error" in result), "should not error");
  const tc = result.toolchain;
  const vsRoot = "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools";
  const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10";
  const nodeDir = "C:\\Program Files\\nodejs";
  assert.equal(tc.dotnet, "C:\\tools\\microsoft.dotnet.sdk.8\\bin.exe");
  // Derived sibling paths are platform-normalized; assert the reviewed root is
  // embedded and the expected executable name is present.
  assert.ok(tc.msbuild.endsWith("MSBuild.exe"), `msbuild: ${tc.msbuild}`);
  assert.ok(tc.msbuild.includes("BuildTools"), `msbuild root: ${tc.msbuild}`);
  assert.equal(tc.vsInstanceId, "1234abcd5678ef90");
  assert.ok(tc.signtool.endsWith("signtool.exe"), `signtool: ${tc.signtool}`);
  assert.ok(tc.signtool.includes("Windows Kits"), `signtool root: ${tc.signtool}`);
  assert.ok(tc.npm.endsWith("npm.cmd"), `npm: ${tc.npm}`);
  assert.ok(tc.corepack.endsWith("corepack.cmd"), `corepack: ${tc.corepack}`);
  void vsRoot; void sdkRoot; void nodeDir;
});

test("reports missing components when some are absent", () => {
  const snap = snapshot(WINDOWS_TOOLCHAIN_COMPONENTS.filter(
    (id) => id !== "kitware.cmake" && id !== "ninja-build.ninja",
  ));
  const result = resolveWindowsToolchain(snap);
  assert.equal(result.error, "ENVIRONMENT_MISSING");
  assert.ok(result.componentIds.includes("kitware.cmake"));
  assert.ok(result.componentIds.includes("ninja-build.ninja"));
});

test("reports a ready component lacking a realPath as missing", () => {
  const snap = snapshot([...WINDOWS_TOOLCHAIN_COMPONENTS], {
    "kitware.cmake": { realPath: undefined },
  });
  // realPath undefined → simulate by stripping it.
  snap.components = snap.components.map((c) =>
    c.componentId === "kitware.cmake" ? { ...c, realPath: undefined } : c,
  );
  const result = resolveWindowsToolchain(snap);
  assert.equal(result.error, "ENVIRONMENT_MISSING");
  assert.ok(result.componentIds.includes("kitware.cmake"));
});

test("reports untrusted components", () => {
  const snap = snapshot([...WINDOWS_TOOLCHAIN_COMPONENTS], {
    "microsoft.visualstudio.2022.buildtools": { state: "untrusted" },
    "kitware.cmake": { state: "incompatible" },
  });
  const result = resolveWindowsToolchain(snap);
  assert.equal(result.error, "TOOLCHAIN_UNTRUSTED");
  assert.ok(result.componentIds.includes("microsoft.visualstudio.2022.buildtools"));
  assert.ok(result.componentIds.includes("kitware.cmake"));
});

test("requires all listed component ids", () => {
  assert.equal(WINDOWS_TOOLCHAIN_COMPONENTS.length, 10);
  assert.ok(WINDOWS_TOOLCHAIN_COMPONENTS.includes("microsoft.dotnet.sdk.8"));
  assert.ok(WINDOWS_TOOLCHAIN_COMPONENTS.includes("git.git"));
});
