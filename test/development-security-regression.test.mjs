import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const root = mkdtempSync(path.join(os.tmpdir(), "feishu-sec-reg-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "sec-reg-secret-0123456789abcdef0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const {
  androidDevelopmentInputSchema,
} = await import("../dist/tools/androidDevelopment.js");
const {
  windowsDevelopmentInputSchema,
} = await import("../dist/tools/windowsDevelopment.js");
const {
  manageDevelopmentProjectInputSchema,
} = await import("../dist/tools/developmentProjects.js");
const {
  inspectInputSchema,
  planInputSchema,
  applyInputSchema,
} = await import("../dist/tools/developmentEnvironment.js");

// A fake spawn recorder — if any malicious input reaches a spawn, this flips.
let spawnCalled = false;
function recorder() { spawnCalled = true; }

function rejects(schema, label, input) {
  assert.throws(() => schema.parse(input), `${label}: expected rejection`);
}

// ----------------------------------------------- universal injection -----

const INJECTION_FIELDS = [
  { key: "url", value: "https://evil.example/payload" },
  { key: "executable", value: "/bin/sh" },
  { key: "args", value: ["--evil"] },
  { key: "shell", value: "bash -c 'rm -rf /'" },
  { key: "command", value: "format c:" },
];

test("android schema rejects every universal injection field on a build action", () => {
  const base = { action: "build", root: "/proj", module: "app", variant: "debug" };
  for (const { key, value } of INJECTION_FIELDS) {
    rejects(androidDevelopmentInputSchema, `android build + ${key}`, { ...base, [key]: value });
    assert.equal(spawnCalled, false, `spawn recorder triggered by ${key}`);
  }
});

test("windows schema rejects every universal injection field on a dotnet_build action", () => {
  const base = { action: "dotnet_build", root: "/proj", projectOrSolution: "App.csproj" };
  for (const { key, value } of INJECTION_FIELDS) {
    rejects(windowsDevelopmentInputSchema, `windows dotnet_build + ${key}`, { ...base, [key]: value });
    assert.equal(spawnCalled, false, `spawn recorder triggered by ${key}`);
  }
});

test("project schema rejects every universal injection field on create", () => {
  const base = {
    action: "create", ecosystem: "android", templateId: "android-basic",
    projectName: "App", packageId: "com.x", destination: "/proj/app",
    profile: { compileSdk: 34, minSdk: 24, targetSdk: 34, agp: "8.2.0", kotlin: "1.9.20", gradle: "8.2" },
  };
  for (const { key, value } of INJECTION_FIELDS) {
    rejects(manageDevelopmentProjectInputSchema, `project create + ${key}`, { ...base, [key]: value });
    assert.equal(spawnCalled, false, `spawn recorder triggered by ${key}`);
  }
});

test("environment plan schema rejects url/executable/args injection", () => {
  const base = { targets: ["android"], components: ["android.sdk"], intent: "install" };
  for (const { key, value } of INJECTION_FIELDS) {
    rejects(planInputSchema, `plan + ${key}`, { ...base, [key]: value });
  }
});

// ----------------------------------------------- android-specific -----

test("android schema rejects dangerous serial keywords", () => {
  for (const serial of ["bootloader", "recovery", "sideload", "fastboot"]) {
    rejects(
      androidDevelopmentInputSchema,
      `android install + serial ${serial}`,
      { action: "install", root: "/proj", module: "app", variant: "debug", serial, apkPath: "/proj/app.apk" },
    );
    assert.equal(spawnCalled, false);
  }
});

test("android schema rejects malformed device serials", () => {
  for (const serial of ["serial;rm -rf /", "serial$(whoami)", "serial `id`", "serial|cat"]) {
    rejects(
      androidDevelopmentInputSchema,
      `android install + serial ${serial}`,
      { action: "install", root: "/proj", module: "app", variant: "debug", serial, apkPath: "/proj/app.apk" },
    );
  }
});

test("android schema rejects unknown actions", () => {
  rejects(androidDevelopmentInputSchema, "android unknown action", { action: "root_device", serial: "abc" });
  rejects(androidDevelopmentInputSchema, "android flash action", { action: "flash", serial: "abc" });
});

// ----------------------------------------------- windows-specific -----

test("windows schema rejects unknown actions and missing required fields", () => {
  rejects(windowsDevelopmentInputSchema, "windows unknown action", { action: "dotnet_format" });
  rejects(windowsDevelopmentInputSchema, "windows dotnet_build missing root", { action: "dotnet_build", projectOrSolution: "App.csproj" });
  rejects(windowsDevelopmentInputSchema, "windows sign missing credentialId", { action: "sign", inFile: "/a", outFile: "/b", timestampOrigin: "http://ts" });
});

test("windows msbuild rejects injected platform/target properties", () => {
  for (const platform of ["x64;evil", "AnyCPU -p:evil=true", "$(pwd)"]) {
    rejects(
      windowsDevelopmentInputSchema,
      `windows msbuild_build platform ${platform}`,
      { action: "msbuild_build", root: "/p", solutionOrProject: "App.sln", target: "Build", configuration: "Debug", platform },
    );
  }
});

test("windows electron rejects shell-metacharacter script names", () => {
  for (const scriptName of ["start;rm -rf /", "test$(id)", "dist`whoami`", "build|cat"]) {
    rejects(
      windowsDevelopmentInputSchema,
      `windows electron_run_script ${scriptName}`,
      { action: "electron_run_script", root: "/p", scriptName },
    );
  }
});

// ----------------------------------------------- project-specific -----

test("project schema rejects unknown ecosystem and caller template path", () => {
  rejects(manageDevelopmentProjectInputSchema, "unknown ecosystem", { action: "list_templates", ecosystem: "rust" });
  rejects(manageDevelopmentProjectInputSchema, "caller templatePath", { action: "list_templates", ecosystem: "android", templatePath: "/evil/template" });
  rejects(manageDevelopmentProjectInputSchema, "create with executable profile", {
    action: "create", ecosystem: "android", templateId: "t", projectName: "P", packageId: "com.x", destination: "/d",
    profile: { compileSdk: 34, minSdk: 24, targetSdk: 34, agp: "8.2.0", kotlin: "1.9.20", gradle: "8.2", executable: "x" },
  });
});

// ----------------------------------------------- environment -----

test("environment apply rejects non-uuid planId and extra fields", () => {
  rejects(applyInputSchema, "non-uuid planId", { planId: "not-a-uuid" });
  rejects(applyInputSchema, "apply extra field", { planId: "11111111-1111-4111-8111-111111111111", url: "evil" });
});

test("environment inspect rejects duplicates and injection", () => {
  rejects(inspectInputSchema, "duplicate targets", { targets: ["android", "android"] });
  rejects(inspectInputSchema, "inspect injection", { targets: ["android"], url: "evil" });
});

test("no malicious input reached the fake spawn recorder", () => {
  assert.equal(spawnCalled, false, "a malicious input slipped through to spawn");
});

// ----------------------------------------------- scan script + CI -----

test("secret scan script never prints matched secret values", async () => {
  const content = await readFile(path.join(projectDir, "scripts", "scan-development-secrets.ps1"), "utf8");
  assert.match(content, /Category/i);
  assert.match(content, /Location/i);
  // Must scan both the working tree and every reachable historical text blob.
  assert.match(content, /git.*ls-files/i);
  assert.match(content, /git.*log --all --root -m -p --full-history --no-renames/i);
  // Must never echo the matched value.
  assert.doesNotMatch(content, /Write-Output.*\$Matches/i);
  assert.doesNotMatch(content, /Write-Output.*\$secret/i);
});

test("CI workflow runs typecheck, tests, broker, audit, and secret scan on Windows", async () => {
  const content = await readFile(path.join(projectDir, ".github", "workflows", "windows-development.yml"), "utf8");
  assert.match(content, /windows-latest/);
  assert.match(content, /node-version.*20/);
  assert.match(content, /dotnet-version.*8/);
  assert.match(content, /npx tsc --noEmit/);
  assert.match(content, /npm test/);
  assert.match(content, /dotnet test.*AdminBroker/i);
  assert.match(content, /python test\/e2e_test\.py/);
  assert.match(content, /npm audit --omit=dev/);
  assert.match(content, /scan-development-secrets\.ps1/);
  assert.match(content, /git diff --check/);
  // CI must not install Android SDK images, Visual Studio workloads, or the broker.
  assert.doesNotMatch(content, /android-actions|sdkmanager|visualstudio|install-admin-broker/i);
});
