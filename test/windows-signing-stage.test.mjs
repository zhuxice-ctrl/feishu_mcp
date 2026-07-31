import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runWindowsSigningStage } from "../dist/development/windows/signingStage.js";

const THUMB = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TS = "http://timestamp.digicert.com";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "win-sign-stage-"));
  const signToolPath = path.join(root, "signtool.exe");
  const inFile = path.join(root, "input.exe");
  const stagingPath = path.join(root, ".output.0123456789ab.exe");
  await writeFile(signToolPath, "fake");
  await writeFile(inFile, "unsigned-input");
  return { root, signToolPath, inFile, stagingPath, thumbprint: THUMB, timestampOrigin: TS };
}

test("signing stage executes fixed sign then verify with shell false and no secret material", async () => {
  const item = await fixture();
  const calls = [];
  try {
    runWindowsSigningStage(item, (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      if (args[0] === "sign") {
        const staged = args.at(-1);
        assert.equal(path.resolve(staged), path.resolve(item.stagingPath));
      }
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    assert.equal(await readFile(item.stagingPath, "utf8"), "unsigned-input");
    assert.deepEqual(calls.map((call) => call.args[0]), ["sign", "verify"]);
    assert.deepEqual(calls[0].args.slice(0, 9), ["sign", "/fd", "sha256", "/td", "sha256", "/tr", TS, "/sha1", THUMB]);
    assert.deepEqual(calls[1].args.slice(0, 4), ["verify", "/pa", "/all", item.stagingPath]);
    for (const call of calls) {
      assert.equal(call.executable, item.signToolPath);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.env.MCP_AUTH_TOKEN, undefined);
      assert.doesNotMatch(call.args.join(" "), /password|pfx|private|credentialid/i);
    }
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("signing stage removes staging after sign or verify failure", async () => {
  for (const failStep of ["sign", "verify"]) {
    const item = await fixture();
    try {
      assert.throws(() => runWindowsSigningStage(item, (_executable, args) => ({
        status: args[0] === failStep ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      })), /signing step failed/);
      await assert.rejects(readFile(item.stagingPath), /ENOENT/);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
});

test("signing stage rejects caller staging and timestamp injection before spawn", async () => {
  const item = await fixture();
  let spawned = false;
  try {
    assert.throws(() => runWindowsSigningStage({ ...item, timestampOrigin: "http://evil.example.com" }, () => { spawned = true; return { status: 0 }; }), /timestamp/);
    assert.throws(() => runWindowsSigningStage({ ...item, stagingPath: item.inFile }, () => { spawned = true; return { status: 0 }; }), /staging/);
    assert.equal(spawned, false);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
