/**
 * Fake `MSBuild.exe` stub for tests. Writes marker output files to simulate a
 * build; exits 0.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const solution = args[0];
const dir = path.dirname(solution);

const targetArg = args.find((a) => a.startsWith("/t:"));
const target = targetArg ? targetArg.slice(3) : "Build";

if (target === "Build" || target === "Rebuild") {
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "App.exe"), "fake-msbuild-output");
  process.exit(0);
}

if (target === "Test") {
  mkdirSync(path.join(dir, "TestResults"), { recursive: true });
  writeFileSync(path.join(dir, "TestResults", "results.trx"), "<trx/>");
  process.exit(0);
}

process.exit(0);
