import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ProjectRegistry } from "../dist/development/projects/registry.js";
import { AndroidProjectProvider } from "../dist/development/android/projectProvider.js";

/**
 * Fake wrapper generator: writes text-only gradle wrapper files (no JAR) and
 * returns the catalog checksum to embed in gradle-wrapper.properties. Mirrors
 * what the real `gradle wrapper` step produces, minus the binary.
 */
function fakeWrapperGenerator(stagingDir, gradleVersion) {
  const wrapperDir = path.join(stagingDir, "gradle", "wrapper");
  fs.mkdirSync(wrapperDir, { recursive: true });
  const sha256 = "a".repeat(64);
  fs.writeFileSync(
    path.join(wrapperDir, "gradle-wrapper.properties"),
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip\n` +
      `distributionSha256Sum=${sha256}\n`,
  );
  fs.writeFileSync(path.join(stagingDir, "gradlew"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(stagingDir, "gradlew.bat"), "@echo off\n");
  return { distributionSha256Sum: sha256 };
}

function makeProvider() {
  return new AndroidProjectProvider({ generateWrapper: fakeWrapperGenerator });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "android-proj-"));
}

const profile = {
  compileSdk: 35,
  minSdk: 24,
  targetSdk: 35,
  agp: "8.5.0",
  kotlin: "1.9.24",
  gradle: "8.9",
  composeCompiler: "1.5.14",
};

test("registry rejects duplicate ecosystem keys", () => {
  const reg = new ProjectRegistry();
  reg.register(makeProvider());
  assert.throws(() => reg.register(makeProvider()), /android/i);
});

test("registry lookup returns the registered provider", () => {
  const reg = new ProjectRegistry();
  const p = makeProvider();
  reg.register(p);
  assert.equal(reg.get("android"), p);
});

test("registry rejects unknown ecosystem lookup", () => {
  const reg = new ProjectRegistry();
  assert.throws(() => reg.get("nope"), /nope/i);
});

test("templates enumerate kotlin-basic and compose-basic", () => {
  const p = makeProvider();
  const ids = p.templates().map((t) => t.id).sort();
  assert.deepEqual(ids, ["compose-basic", "kotlin-basic"]);
  for (const t of p.templates()) {
    assert.ok(t.displayName);
    assert.ok(t.description);
  }
});

test("create kotlin-basic project stages exact file inventory", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  const result = await p.create(
    {
      templateId: "kotlin-basic",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  assert.equal(result.root, dest);
  const files = walk(dest).map((f) => path.relative(dest, f).replace(/\\/g, "/")).sort();
  assert.ok(files.includes("settings.gradle.kts"));
  assert.ok(files.includes("build.gradle.kts"));
  assert.ok(files.includes("app/build.gradle.kts"));
  assert.ok(files.includes("app/src/main/AndroidManifest.xml"));
  assert.ok(
    files.includes("app/src/main/java/com/example/app/MainActivity.kt"),
  );
  assert.ok(files.includes("gradle/wrapper/gradle-wrapper.properties"));
  assert.ok(files.includes("gradlew"));
  assert.ok(files.includes("gradlew.bat"));
  // no binary wrapper JAR
  assert.ok(!files.some((f) => f.endsWith(".jar")));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("create compose-basic project stages MainActivity with compose", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "ComposeApp");
  await p.create(
    {
      templateId: "compose-basic",
      projectName: "ComposeApp",
      packageId: "com.example.composeapp",
      destination: dest,
      profile,
    },
    staging,
  );
  const kt = fs.readFileSync(
    path.join(dest, "app/src/main/java/com/example/composeapp/MainActivity.kt"),
    "utf8",
  );
  assert.ok(kt.includes("androidx.compose"));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("no unresolved template tokens remain", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await p.create(
    {
      templateId: "kotlin-basic",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  for (const f of walk(dest)) {
    if (f.endsWith(".jar")) continue;
    const content = fs.readFileSync(f, "utf8");
    assert.ok(
      !/__\w+__/.test(content),
      `unresolved token in ${path.relative(dest, f)}: ${content.match(/__\w+__/g)}`,
    );
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("token replacement substitutes project name, package, sdk versions", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await p.create(
    {
      templateId: "kotlin-basic",
      projectName: "MyApp",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  const settings = fs.readFileSync(path.join(dest, "settings.gradle.kts"), "utf8");
  assert.ok(settings.includes("MyApp"));
  const appGradle = fs.readFileSync(path.join(dest, "app/build.gradle.kts"), "utf8");
  assert.ok(appGradle.includes("compileSdk = 35"));
  assert.ok(appGradle.includes("minSdk = 24"));
  assert.ok(appGradle.includes("targetSdk = 35"));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("gradle-wrapper.properties carries distributionSha256Sum", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await p.create(
    {
      templateId: "kotlin-basic",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  const props = fs.readFileSync(
    path.join(dest, "gradle/wrapper/gradle-wrapper.properties"),
    "utf8",
  );
  assert.ok(props.includes("distributionSha256Sum="));
  assert.ok(props.includes("gradle-8.9-bin.zip"));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("refuses to overwrite nonempty destination", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "leftover.txt"), "x");
  await assert.rejects(
    async () => {
      await p.create(
        {
          templateId: "kotlin-basic",
          projectName: "App",
          packageId: "com.example.app",
          destination: dest,
          profile,
        },
        staging,
      );
    },
    /nonempty|not empty|exists/i,
  );
  // destination untouched
  assert.ok(fs.existsSync(path.join(dest, "leftover.txt")));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("atomic rollback on wrapper failure leaves destination untouched", async () => {
  const failProvider = new AndroidProjectProvider({
    generateWrapper: () => {
      throw new Error("wrapper boom");
    },
  });
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await assert.rejects(
    async () => {
      await failProvider.create(
        {
          templateId: "kotlin-basic",
          projectName: "App",
          packageId: "com.example.app",
          destination: dest,
          profile,
        },
        staging,
      );
    },
    /wrapper boom/,
  );
  assert.ok(!fs.existsSync(dest), "destination must not exist after rollback");
  fs.rmSync(staging, { recursive: true, force: true });
});

test("invalid package id rejected", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await assert.rejects(
    async () => {
      await p.create(
        {
          templateId: "kotlin-basic",
          projectName: "App",
          packageId: "com..bad",
          destination: dest,
          profile,
        },
        staging,
      );
    },
    /package/i,
  );
  fs.rmSync(staging, { recursive: true, force: true });
});

test("unknown template id rejected", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await assert.rejects(
    async () => {
      await p.create(
        {
          templateId: "rust-basic",
          projectName: "App",
          packageId: "com.example.app",
          destination: dest,
          profile,
        },
        staging,
      );
    },
    /template/i,
  );
  fs.rmSync(staging, { recursive: true, force: true });
});

test("inspect reads an existing project root", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await p.create(
    {
      templateId: "kotlin-basic",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  const inspection = await p.inspect(dest);
  assert.equal(inspection.ecosystem, "android");
  assert.ok(inspection.gradleFiles.length > 0);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("templates contain no remote scripts, credentials, or local paths", async () => {
  const p = makeProvider();
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await p.create(
    {
      templateId: "compose-basic",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile,
    },
    staging,
  );
  for (const f of walk(dest)) {
    if (f.endsWith(".jar")) continue;
    const content = fs.readFileSync(f, "utf8");
    assert.ok(!/curl |wget |Invoke-WebRequest/i.test(content), `remote script in ${f}`);
    assert.ok(!/password|secret|api[_-]?key/i.test(content), `credential in ${f}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test("provider registered under ecosystem key android", () => {
  const reg = new ProjectRegistry();
  const p = makeProvider();
  reg.register(p);
  assert.equal(reg.get("android").ecosystem, "android");
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
