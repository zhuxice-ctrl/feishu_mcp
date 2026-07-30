import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planElectronAction, isManifestDigestStale } from "../dist/development/windows/electron.js";
import { buildElectronCommand } from "../dist/development/windows/commands.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-electron-act-"));
}

function toolchain() {
  return {
    dotnet: "C:\\dotnet.exe", msbuild: "C:\\MSBuild.exe", vsInstanceId: "abc",
    signtool: "C:\\signtool.exe", cmake: "C:\\cmake.exe", ninja: "C:\\ninja.exe",
    node: "C:\\node.exe", npm: "C:\\npm.cmd", corepack: "C:\\corepack.cmd", git: "C:\\git.exe",
  };
}

function writeNpmFixture(dir) {
  const pkg = {
    name: "test-app",
    version: "1.0.0",
    scripts: { start: "electron .", test: "node --test", package: "electron-builder --win" },
  };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
}

function writePnpmFixture(dir) {
  const pkg = { name: "test-app", version: "1.0.0", scripts: { test: "node --test" } };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
}

function writeYarnFixture(dir) {
  const pkg = { name: "test-app", version: "1.0.0", scripts: { test: "node --test" } };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(dir, "yarn.lock"), "# yarn lockfile v1\n");
}

test("npm ci frozen install", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const plan = planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 });
  assert.deepEqual(plan.args, ["ci"]);
  assert.equal(plan.packageManager, "npm");
  rmSync(root, { recursive: true, force: true });
});

test("pnpm install --frozen-lockfile", () => {
  const root = tmpDir();
  writePnpmFixture(root);
  const plan = planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 });
  assert.deepEqual(plan.args, ["install", "--frozen-lockfile"]);
  assert.equal(plan.packageManager, "pnpm");
  rmSync(root, { recursive: true, force: true });
});

test("yarn install --immutable", () => {
  const root = tmpDir();
  writeYarnFixture(root);
  const plan = planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 });
  assert.deepEqual(plan.args, ["install", "--immutable"]);
  assert.equal(plan.packageManager, "yarn");
  rmSync(root, { recursive: true, force: true });
});

test("run_script executes exact manifest script", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const plan = planElectronAction(toolchain(), {
    root, action: "run_script", scriptName: "start", timeoutMs: 60000,
  });
  assert.deepEqual(plan.args, ["run", "start"]);
  rmSync(root, { recursive: true, force: true });
});

test("test action runs manifest test script", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const plan = planElectronAction(toolchain(), {
    root, action: "test", scriptName: "test", timeoutMs: 60000,
  });
  assert.deepEqual(plan.args, ["run", "test"]);
  rmSync(root, { recursive: true, force: true });
});

test("package action runs manifest package script", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const plan = planElectronAction(toolchain(), {
    root, action: "package", scriptName: "package", timeoutMs: 60000,
  });
  assert.deepEqual(plan.args, ["run", "package"]);
  rmSync(root, { recursive: true, force: true });
});

test("run_script rejects unknown script name", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  assert.throws(
    () => planElectronAction(toolchain(), {
      root, action: "run_script", scriptName: "evil-script", timeoutMs: 60000,
    }),
    /script not found in manifest/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("run_script rejects missing scriptName", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  assert.throws(
    () => planElectronAction(toolchain(), {
      root, action: "run_script", timeoutMs: 60000,
    }),
    /scriptName is required/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("lifecycle scripts are surfaced for approval", () => {
  const root = tmpDir();
  const pkg = {
    name: "test-app", version: "1.0.0",
    scripts: {
      start: "electron .",
      postinstall: "node postinstall.js",
      prepare: "husky install",
    },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  const plan = planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 });
  const phases = plan.lifecycleScripts.map((l) => l.phase);
  assert.ok(phases.includes("postinstall"));
  assert.ok(phases.includes("prepare"));
  rmSync(root, { recursive: true, force: true });
});

test("changed manifest invalidates digest", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const plan = planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 });
  const originalDigest = plan.manifestLockDigest;
  // Modify package.json
  const pkg = { name: "test-app", version: "2.0.0", scripts: { start: "electron ." } };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  assert.ok(isManifestDigestStale(root, originalDigest));
  rmSync(root, { recursive: true, force: true });
});

test("multiple lockfiles rejected", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  writeFileSync(path.join(root, "yarn.lock"), "# yarn lockfile v1\n");
  assert.throws(
    () => planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 }),
    /multiple lockfiles/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("no lockfile rejected", () => {
  const root = tmpDir();
  const pkg = { name: "test-app", version: "1.0.0", scripts: {} };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  assert.throws(
    () => planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 }),
    /no recognized lockfile/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("package action collects artifacts from dist", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  // Create dist with a fake .exe
  const distDir = path.join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, "app-1.0.0.exe"), Buffer.from("fake exe content"));
  const plan = planElectronAction(toolchain(), {
    root, action: "package", scriptName: "package", timeoutMs: 60000,
  });
  assert.ok(plan.artifacts);
  assert.ok(plan.artifacts.length >= 1);
  const exe = plan.artifacts.find((a) => a.name.endsWith(".exe"));
  assert.ok(exe, "should find .exe artifact");
  rmSync(root, { recursive: true, force: true });
});

test("package action rejects symlink artifacts", () => {
  const root = tmpDir();
  writeNpmFixture(root);
  const distDir = path.join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  // Create a real file outside dist and symlink into it
  writeFileSync(path.join(root, "real.exe"), "payload");
  try {
    fs.symlinkSync(path.join(root, "real.exe"), path.join(distDir, "link.exe"));
  } catch {
    // symlinks may not be supported; skip
  }
  const plan = planElectronAction(toolchain(), {
    root, action: "package", scriptName: "package", timeoutMs: 60000,
  });
  // symlink should be filtered out
  if (plan.artifacts) {
    const link = plan.artifacts.find((a) => a.name === "link.exe");
    assert.ok(!link, "symlink artifact should be rejected");
  }
  rmSync(root, { recursive: true, force: true });
});

test("buildElectronCommand rejects unknown action via strict schema", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "evil",
      projectDir: "C:\\proj",
      packageManager: "npm",
    }),
  );
});

test("buildElectronCommand rejects cacheVariable injection", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "install",
      projectDir: "C:\\proj",
      packageManager: "npm",
      cacheVariable: "EVIL=;rm -rf /",
    }),
  );
});
