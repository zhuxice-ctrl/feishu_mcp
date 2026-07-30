import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectRegistry } from "../dist/development/projects/registry.js";
import {
  DotnetProjectProvider,
  DOTNET_APPROVED_SHORT_NAMES,
} from "../dist/development/windows/dotnetProjectProvider.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "feishu-win-dotnet-"));
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

// synchronous fake dotnet runner for tests
import { writeFileSync } from "node:fs";
function makeRunnerV2(installed, { failCreate = false } = {}) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[0] === "new" && args[1] === "list") {
        return {
          stdout: JSON.stringify({ templates: installed.map((s) => ({ shortName: s })) }),
          exitCode: 0,
        };
      }
      if (args[0] === "new" && args[1] !== "list" && !failCreate) {
        const outIdx = args.indexOf("--output");
        const outDir = args[outIdx + 1];
        const nameIdx = args.indexOf("--name");
        const name = args[nameIdx + 1];
        const shortName = args[2];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, `${name}.csproj`), `<Project Sdk="${shortName}"/>`);
        return { stdout: "", exitCode: 0 };
      }
      if (args[0] === "new" && args[1] !== "list" && failCreate) return { stdout: "", exitCode: 1 };
      return { stdout: "", exitCode: 0 };
    },
  };
}

test("enumerates only installed approved templates", () => {
  const runner = makeRunnerV2(["console", "classlib", "xunit"]);
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const ids = p.templates().map((t) => t.id);
  assert.deepEqual(ids, ["console", "classlib", "xunit"]);
});

test("rejects unapproved short names even if installed", () => {
  const runner = makeRunnerV2(["console", "malicious"]);
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const ids = p.templates().map((t) => t.id);
  assert.deepEqual(ids, ["console"]);
});

test("create invokes dotnet new with fixed args and no caller switches", async () => {
  const runner = makeRunnerV2(["console"]);
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  const result = await p.create(
    {
      templateId: "console",
      projectName: "App",
      packageId: "com.example.app",
      destination: dest,
      profile: { framework: "net8.0" },
    },
    staging,
  );
  assert.equal(result.root, dest);
  const lastCall = runner.calls[runner.calls.length - 1];
  assert.deepEqual(lastCall, [
    "new", "console", "--name", "App", "--output", expectDir(lastCall),
    "--framework", "net8.0",
  ]);
  // No arbitrary switches leaked through.
  assert.ok(!lastCall.some((a) => a.startsWith("--") && ![
    "--name", "--output", "--framework",
  ].includes(a)));
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

function expectDir(call) {
  return call[call.indexOf("--output") + 1];
}

test("create fails explicitly when the template is not installed", async () => {
  const runner = makeRunnerV2([]); // nothing installed
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await assert.rejects(
    () => p.create(
      { templateId: "winui", projectName: "App", packageId: "x", destination: dest, profile: {} },
      staging,
    ),
    /not installed/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rolls back staging on dotnet new failure", async () => {
  const runner = makeRunnerV2(["console"], { failCreate: true });
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const staging = tmpDir();
  const dest = path.join(tmpDir(), "App");
  await assert.rejects(
    () => p.create(
      { templateId: "console", projectName: "App", packageId: "x", destination: dest, profile: {} },
      staging,
    ),
    /dotnet new failed/,
  );
  assert.ok(!existsSync(dest));
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("create rejects a nonempty destination", async () => {
  const runner = makeRunnerV2(["console"]);
  const p = new DotnetProjectProvider({ runDotnet: runner.run });
  const staging = tmpDir();
  const dest = tmpDir();
  writeFileSync(path.join(dest, "preexisting.txt"), "x");
  await assert.rejects(
    () => p.create(
      { templateId: "console", projectName: "App", packageId: "x", destination: dest, profile: {} },
      staging,
    ),
    /not empty/,
  );
  rmSync(dest, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

test("provider registers under the dotnet ecosystem", () => {
  const runner = makeRunnerV2(["console"]);
  const reg = new ProjectRegistry();
  reg.register(new DotnetProjectProvider({ runDotnet: runner.run }));
  assert.equal(reg.get("dotnet").ecosystem, "dotnet");
  assert.ok(reg.has("dotnet"));
});

test("approved short names include console and classlib", () => {
  assert.ok(DOTNET_APPROVED_SHORT_NAMES.includes("console"));
  assert.ok(DOTNET_APPROVED_SHORT_NAMES.includes("classlib"));
});
