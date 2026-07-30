import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planElectronAction } from "../dist/development/windows/electron.js";
import { buildElectronCommand } from "../dist/development/windows/commands.js";
import { safeParseJson } from "../dist/development/windows/electronManifest.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-electron-inj-"));
}

function toolchain() {
  return {
    dotnet: "C:\\dotnet.exe", msbuild: "C:\\MSBuild.exe", vsInstanceId: "abc",
    signtool: "C:\\signtool.exe", cmake: "C:\\cmake.exe", ninja: "C:\\ninja.exe",
    node: "C:\\node.exe", npm: "C:\\npm.cmd", corepack: "C:\\corepack.cmd", git: "C:\\git.exe",
  };
}

test("prototype pollution via __proto__ key rejected", () => {
  const malicious = '{"__proto__":{"polluted":true},"name":"x"}';
  assert.throws(() => safeParseJson(malicious), /__proto__/);
});

test("script name with shell metacharacters rejected", () => {
  const root = tmpDir();
  const pkg = {
    name: "x", version: "1.0.0",
    scripts: { "evil; rm -rf /": "echo bad" },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(root, "package-lock.json"), "{}");
  assert.throws(
    () => planElectronAction(toolchain(), { root, action: "install", timeoutMs: 60000 }),
    /invalid script name/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("buildElectronCommand rejects extra -- flag in input", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "run_script",
      projectDir: "C:\\proj",
      packageManager: "npm",
      scriptName: "test",
      extraFlag: "--",
    }),
  );
});

test("buildElectronCommand rejects URL in scriptName", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "run_script",
      projectDir: "C:\\proj",
      packageManager: "npm",
      scriptName: "http://evil.com/script.js",
    }),
  );
});

test("buildElectronCommand rejects executable path in scriptName", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "run_script",
      projectDir: "C:\\proj",
      packageManager: "npm",
      scriptName: "C:\\Windows\\system32\\cmd.exe",
    }),
  );
});

test("buildElectronCommand rejects unknown package manager", () => {
  assert.throws(() =>
    buildElectronCommand(toolchain(), {
      action: "install",
      projectDir: "C:\\proj",
      packageManager: "evil-pm",
    }),
  );
});

test("planElectronAction does not accept arbitrary executable field", () => {
  const root = tmpDir();
  const pkg = { name: "x", version: "1.0.0", scripts: { test: "node --test" } };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(root, "package-lock.json"), "{}");
  // The plan should use the trusted toolchain npm, never a caller-provided executable
  const plan = planElectronAction(toolchain(), {
    root, action: "test", scriptName: "test", timeoutMs: 60000,
  });
  assert.equal(plan.executable, "C:\\npm.cmd");
  rmSync(root, { recursive: true, force: true });
});
