/**
 * Fake `dotnet` executable stub for tests. Writes a marker file into the
 * project directory to simulate build output; exits 0.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const verb = args[0];

if (verb === "new" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ templates: [{ shortName: "console" }, { shortName: "classlib" }] }));
  process.exit(0);
}

if (verb === "build" || verb === "publish" || verb === "pack") {
  const projIdx = args.indexOf(args[1]);
  const project = args[1];
  const dir = path.dirname(project);
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "App.dll"), "fake-dotnet-output");
  process.exit(0);
}

if (verb === "test") {
  const project = args[1];
  const dir = path.dirname(project);
  mkdirSync(path.join(dir, "TestResults"), { recursive: true });
  writeFileSync(path.join(dir, "TestResults", "results.trx"), "< trx/>");
  process.exit(0);
}

if (verb === "restore" || verb === "generate_dependency_lock") {
  process.exit(0);
}

process.exit(0);
