import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planSignToolSign,
  planSignToolVerify,
  resolveSigningCredential,
  WINDOWS_SIGNING_HELPER_PATH,
} from "../dist/development/windows/signing.js";
import { LocalCredentialStore } from "../dist/development/credentials/dpapiStore.js";

const toolchain = { signtool: "C:\\sdk\\bin\\x64\\signtool.exe" };
const allowHost = (p) => p.startsWith("C:\\authorized\\");
const THUMB = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TS = "http://timestamp.digicert.com";

function storeWithCert(kind = "certificate", fingerprint = THUMB) {
  const store = new LocalCredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "win-sign-")));
  const cert = store.register({ kind, alias: "codesign", fingerprint });
  return { store, cert };
}

function validInspector(thumbprint) {
  return {
    thumbprint, alias: "codesign", subject: "CN=Test, O=Org",
    validFrom: "2025-01-01T00:00:00.000Z", validTo: "2027-12-31T00:00:00.000Z",
    codeSigningEku: true,
  };
}

test("planSignToolSign uses one fixed helper for staged CurrentUser signing", () => {
  const { store, cert } = storeWithCert();
  const r = planSignToolSign(
    toolchain,
    { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\app-signed.exe", credentialId: cert.id, timestampOrigin: TS },
    { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
  );
  assert.equal(r.signCommand.executable, process.execPath);
  assert.equal(r.signCommand.args.includes("-Command"), false);
  assert.equal(r.signCommand.args[0], WINDOWS_SIGNING_HELPER_PATH);
  assert.equal(r.signCommand.args[r.signCommand.args.indexOf("-SignToolPath") + 1], toolchain.signtool);
  assert.equal(r.signCommand.args[r.signCommand.args.indexOf("-InFile") + 1], "C:\\authorized\\app.exe");
  assert.equal(r.signCommand.args.includes("-OutFile"), false, "the worker alone publishes the final output");
  assert.equal(r.signCommand.args[r.signCommand.args.indexOf("-StagingPath") + 1], r.stagingOut);
  assert.equal(r.signCommand.args[r.signCommand.args.indexOf("-Thumbprint") + 1], THUMB);
  assert.equal(r.signCommand.args[r.signCommand.args.indexOf("-TimestampOrigin") + 1], TS);
  assert.notEqual(r.stagingOut, r.outFile);
  assert.equal(path.dirname(r.stagingOut), path.dirname(r.outFile));
  assert.doesNotMatch(r.signCommand.args.join(" "), /password|pfx|private|credentialid/i);
});

test("planSignToolSign rejects unauthorized input and output paths", () => {
  const { store, cert } = storeWithCert();
  for (const [inFile, outFile] of [
    ["C:\\evil\\app.exe", "C:\\authorized\\out.exe"],
    ["C:\\authorized\\app.exe", "C:\\evil\\out.exe"],
  ]) {
    assert.throws(() => planSignToolSign(
      toolchain, { inFile, outFile, credentialId: cert.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ), /host path outside authorized directory/);
  }
});

test("planSignToolSign rejects unknown, non-certificate, and malformed credentials", () => {
  const { store, cert } = storeWithCert();
  assert.throws(() => planSignToolSign(
    toolchain, { inFile: "C:\\authorized\\a.exe", outFile: "C:\\authorized\\b.exe", credentialId: "00000000-0000-0000-0000-000000000000", timestampOrigin: TS },
    { authorizeHostPath: allowHost, credentialStore: store },
  ), /unknown signing credential/);
  const nonCertificate = store.register({ kind: "key", alias: "not-cert", fingerprint: THUMB });
  assert.throws(() => planSignToolSign(
    toolchain, { inFile: "C:\\authorized\\a.exe", outFile: "C:\\authorized\\b.exe", credentialId: nonCertificate.id, timestampOrigin: TS },
    { authorizeHostPath: allowHost, credentialStore: store },
  ), /certificate credential/);
  const malformed = store.register({ kind: "certificate", alias: "bad", fingerprint: "not-a-thumbprint" });
  assert.throws(() => planSignToolSign(
    toolchain, { inFile: "C:\\authorized\\a.exe", outFile: "C:\\authorized\\b.exe", credentialId: malformed.id, timestampOrigin: TS },
    { authorizeHostPath: allowHost, credentialStore: store },
  ), /thumbprint/);
  assert.equal(resolveSigningCredential(store, cert.id).thumbprint, THUMB);
});

test("planSignToolSign enforces timestamp, EKU, and validity", () => {
  const { store, cert } = storeWithCert();
  const request = { inFile: "C:\\authorized\\a.exe", outFile: "C:\\authorized\\b.exe", credentialId: cert.id, timestampOrigin: TS };
  assert.throws(() => planSignToolSign(toolchain, { ...request, timestampOrigin: "http://evil.example.com" }, { authorizeHostPath: allowHost, credentialStore: store }), /timestamp/);
  assert.throws(() => planSignToolSign(toolchain, request, { authorizeHostPath: allowHost, credentialStore: store, certInspector: (t) => ({ ...validInspector(t), codeSigningEku: false }) }), /EKU/);
  assert.throws(() => planSignToolSign(toolchain, request, { authorizeHostPath: allowHost, credentialStore: store, certInspector: (t) => ({ ...validInspector(t), validTo: "2020-01-01T00:00:00.000Z" }) }), /expired/);
});

test("planSignToolVerify builds the fixed verify command and rejects unauthorized paths", () => {
  const r = planSignToolVerify(toolchain, { inFile: "C:\\authorized\\signed.exe" }, { authorizeHostPath: allowHost });
  assert.deepEqual(r.verifyCommand.args, ["verify", "/pa", "/all", "C:\\authorized\\signed.exe"]);
  assert.throws(() => planSignToolVerify(toolchain, { inFile: "C:\\evil\\signed.exe" }, { authorizeHostPath: allowHost }), /host path/);
});
