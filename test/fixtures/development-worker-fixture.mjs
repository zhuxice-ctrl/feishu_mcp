// Test fixture for the development worker.
//
// Flags:
//   --sleep <ms>        sleep before exiting
//   --exit <code>       exit code (default 0)
//   --stdout <text>     write to stdout
//   --stdout-hex <hex>  write exact binary bytes to stdout
//   --stderr <text>     write to stderr
//   --artifact <path>   touch an artifact file at the given path
//   --write-file <path> write fixed bytes without an artifact manifest
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
const stdoutHex = flag("--stdout-hex");
const err = flag("--stderr");
const artifact = flag("--artifact");
const writeFile = flag("--write-file");
const envEcho = flag("--env-echo");
const envEchoBothSplit = flag("--env-echo-both-split");

if (out) process.stdout.write(out + "\n");
if (stdoutHex) process.stdout.write(Buffer.from(stdoutHex, "hex"));
if (err) process.stderr.write(err + "\n");
if (envEcho && process.env[envEcho]) process.stdout.write(process.env[envEcho] + "\n");
if (envEchoBothSplit && process.env[envEchoBothSplit]) {
  const value = process.env[envEchoBothSplit];
  const split = Math.max(1, Math.floor(value.length / 2));
  process.stdout.write(value.slice(0, split));
  process.stderr.write(value.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.stdout.write(value.slice(split) + "\n");
  process.stderr.write(value.slice(split) + "\n");
}

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
if (writeFile) {
  fs.mkdirSync(path.dirname(writeFile), { recursive: true });
  fs.writeFileSync(writeFile, "verified-signed-output\n");
}

if (sleep) {
  await new Promise((r) => setTimeout(r, Number(sleep)));
}

process.exit(exitCode);
