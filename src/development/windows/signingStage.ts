/** Fixed Windows signing staging helper. Produces a verified sibling stage. */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { safeRuntimeEnvironment } from "../tasks/runtimeEnvironment.js";
import { CERT_THUMBPRINT_REGEX, TIMESTAMP_ORIGIN_REGEX } from "./types.js";

export interface WindowsSigningStageRequest {
  signToolPath: string;
  inFile: string;
  stagingPath: string;
  thumbprint: string;
  timestampOrigin: string;
}

export interface WindowsSigningStageCommandResult {
  status: number | null;
  stdout?: Buffer | Uint8Array | string | null;
  stderr?: Buffer | Uint8Array | string | null;
  error?: Error;
}

export type WindowsSigningStageRunner = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    shell: false;
    windowsHide: true;
    timeout: number;
    maxBuffer: number;
    encoding: "buffer";
  },
) => WindowsSigningStageCommandResult;

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function asBuffer(value: WindowsSigningStageCommandResult["stdout"]): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function assertRegularFile(file: string): string {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("signing input unavailable");
  return resolved;
}

function assertRealDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("signing directory unavailable");
  return fs.realpathSync.native(resolved);
}

function runStep(
  executable: string,
  args: readonly string[],
  runner: WindowsSigningStageRunner,
): void {
  const result = runner(executable, args, {
    env: safeRuntimeEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "buffer",
  });
  const stdout = asBuffer(result.stdout);
  const stderr = asBuffer(result.stderr);
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  if (result.error || result.status !== 0) throw new Error("signing step failed");
}

export function runWindowsSigningStage(
  request: WindowsSigningStageRequest,
  runner: WindowsSigningStageRunner = spawnSync as WindowsSigningStageRunner,
): void {
  if (!CERT_THUMBPRINT_REGEX.test(request.thumbprint)) throw new Error("invalid certificate thumbprint");
  if (!TIMESTAMP_ORIGIN_REGEX.test(request.timestampOrigin)) throw new Error("invalid timestamp origin");
  const signTool = assertRegularFile(request.signToolPath);
  const input = assertRegularFile(request.inFile);
  assertRealDirectory(path.dirname(input));
  const staging = path.resolve(request.stagingPath);
  assertRealDirectory(path.dirname(staging));
  if (staging === input || fs.existsSync(staging)) {
    throw new Error("invalid signing staging path");
  }

  let verified = false;
  try {
    fs.copyFileSync(input, staging, fs.constants.COPYFILE_EXCL);
    const staged = assertRegularFile(staging);
    runStep(signTool, [
      "sign", "/fd", "sha256", "/td", "sha256",
      "/tr", request.timestampOrigin, "/sha1", request.thumbprint, staged,
    ], runner);
    runStep(signTool, ["verify", "/pa", "/all", staged], runner);
    assertRegularFile(staged);
    verified = true;
  } finally {
    if (!verified) {
      try { fs.rmSync(staging, { force: true }); } catch {}
    }
  }
}

function parseArgs(args: readonly string[]): WindowsSigningStageRequest {
  const expected = ["-SignToolPath", "-InFile", "-StagingPath", "-Thumbprint", "-TimestampOrigin"] as const;
  if (args.length !== expected.length * 2) throw new Error("invalid signing helper arguments");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!expected.includes(args[index] as (typeof expected)[number]) || values.has(args[index])) {
      throw new Error("invalid signing helper arguments");
    }
    values.set(args[index], args[index + 1]);
  }
  return {
    signToolPath: values.get("-SignToolPath")!,
    inFile: values.get("-InFile")!,
    stagingPath: values.get("-StagingPath")!,
    thumbprint: values.get("-Thumbprint")!,
    timestampOrigin: values.get("-TimestampOrigin")!,
  };
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedAsScript) {
  try {
    runWindowsSigningStage(parseArgs(process.argv.slice(2)));
  } catch {
    process.exitCode = 1;
  }
}
