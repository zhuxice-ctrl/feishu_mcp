// Test fixture for the development worker.
//
// Flags:
//   --sleep <ms>        sleep before exiting
//   --exit <code>       exit code (default 0)
//   --stdout <text>     write to stdout
//   --stderr <text>     write to stderr
//   --artifact <path>   touch an artifact file at the given path
//   --env-echo <name>   print the value of the named env var to stdout

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

const sleep = flag("--sleep");
const exitCode = Number(flag("--exit") ?? "0");
const out = flag("--stdout");
const err = flag("--stderr");
const artifact = flag("--artifact");
const envEcho = flag("--env-echo");

if (out) process.stdout.write(out + "\n");
if (err) process.stderr.write(err + "\n");
if (envEcho && process.env[envEcho]) process.stdout.write(process.env[envEcho] + "\n");

if (artifact) {
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, "artifact\n");
  const manifest = process.env.FEISHU_MCP_ARTIFACT_MANIFEST;
  if (manifest) {
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      artifacts: [{ name: path.basename(artifact), path: artifact, kind: "fixture" }],
    }));
  }
}

if (sleep) {
  await new Promise((r) => setTimeout(r, Number(sleep)));
}

process.exit(exitCode);
