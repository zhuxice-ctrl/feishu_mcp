import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planSignToolSign,
  planPfxSign,
  planSignToolVerify,
  resolveSigningCredential,
} from "../dist/development/windows/signing.js";
import { LocalCredentialStore } from "../dist/development/credentials/dpapiStore.js";

const toolchain = { signtool: "C:\\sdk\\bin\\x64\\signtool.exe" };
const allowHost = (p) => p.startsWith("C:\\authorized\\");
const THUMB = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TS = "http://timestamp.digicert.com";
const HELPER = "C:\\helper\\import-development-signing-credential.ps1";

function storeWithCert() {
  const store = new LocalCredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "win-sign-")));
  const cert = store.register({ kind: "key", alias: "codesign", fingerprint: THUMB });
  return { store, cert };
}

function validInspector(thumbprint) {
  return {
    thumbprint,
    alias: "codesign",
    subject: "CN=Test, O=Org",
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: "2027-12-31T00:00:00.000Z",
    codeSigningEku: true,
  };
}

test("planSignToolSign builds /sha1 thumbprint command with staging", () => {
  const { store, cert } = storeWithCert();
  const r = planSignToolSign(
    toolchain,
    { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\app-signed.exe", credentialId: cert.id, timestampOrigin: TS },
    { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
  );
  assert.equal(r.signCommand.executable, "C:\\sdk\\bin\\x64\\signtool.exe");
  assert.deepEqual(r.signCommand.args, [
    "sign", "/fd", "sha256", "/td", "sha256", "/tr", TS,
    "/sha1", THUMB, r.stagingOut,
  ]);
  assert.deepEqual(r.verifyCommand.args, ["verify", "/pa", "/all", r.stagingOut]);
  assert.equal(r.stageCopy.src, "C:\\authorized\\app.exe");
  assert.equal(r.stageCopy.dest, r.stagingOut);
  assert.notEqual(r.stagingOut, r.outFile);
  assert.equal(r.outFile, "C:\\authorized\\app-signed.exe");
  assert.equal(r.certificate.thumbprint, THUMB);
  assert.equal(r.certificate.alias, "codesign");
  assert.ok(!r.importStep && !r.cleanupStep, "cert-store path has no import/cleanup");
});

test("planSignToolSign rejects unauthorized input path", () => {
  const { store, cert } = storeWithCert();
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\evil\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: cert.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ),
    /host path outside authorized directory/,
  );
});

test("planSignToolSign rejects unauthorized output path", () => {
  const { store, cert } = storeWithCert();
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\evil\\out.exe", credentialId: cert.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ),
    /host path outside authorized directory/,
  );
});

test("planSignToolSign rejects unknown credential id", () => {
  const { store } = storeWithCert();
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: "00000000-0000-0000-0000-000000000000", timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ),
    /unknown signing credential id/,
  );
});

test("planSignToolSign rejects untrusted timestamp origin", () => {
  const { store, cert } = storeWithCert();
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: cert.id, timestampOrigin: "http://evil.example.com" },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ),
    /untrusted timestamp origin/,
  );
});

test("planSignToolSign rejects cert without code-signing EKU", () => {
  const { store, cert } = storeWithCert();
  const noEku = (t) => ({ ...validInspector(t), codeSigningEku: false });
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: cert.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: noEku },
    ),
    /code-signing EKU/,
  );
});

test("planSignToolSign rejects expired certificate", () => {
  const { store, cert } = storeWithCert();
  const expired = (t) => ({ ...validInspector(t), validTo: "2020-01-01T00:00:00.000Z" });
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: cert.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: expired },
    ),
    /certificate expired/,
  );
});

test("planSignToolSign rejects invalid thumbprint fingerprint", () => {
  const store = new LocalCredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "win-sign-")));
  const bad = store.register({ kind: "key", alias: "bad", fingerprint: "not-a-thumbprint" });
  assert.throws(
    () => planSignToolSign(
      toolchain,
      { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: bad.id, timestampOrigin: TS },
      { authorizeHostPath: allowHost, credentialStore: store },
    ),
    /invalid certificate thumbprint/,
  );
});

test("planPfxSign includes import + cleanup steps without password argument", () => {
  const { store, cert } = storeWithCert();
  const r = planPfxSign(
    toolchain,
    { inFile: "C:\\authorized\\app.exe", outFile: "C:\\authorized\\app-signed.exe", credentialId: cert.id, timestampOrigin: TS, helperPath: HELPER },
    { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
  );
  // import step uses the helper, no password arg
  assert.ok(r.importStep);
  assert.equal(r.importStep.executable, "powershell.exe");
  assert.ok(r.importStep.args.includes("-File"));
  assert.ok(r.importStep.args.includes(HELPER));
  assert.ok(r.importStep.args.includes("-CredentialId"));
  assert.ok(r.importStep.args.includes(cert.id));
  assert.ok(r.importStep.args.includes("-TempStoreName"));
  const tempStore = r.importStep.args[r.importStep.args.indexOf("-TempStoreName") + 1];
  assert.match(tempStore, /^FeishuMcpTemp[0-9a-f]+$/);
  // NO password / pin / secret argument anywhere in import
  const importJoined = r.importStep.args.join(" ").toLowerCase();
  assert.ok(!importJoined.includes("password") && !importJoined.includes("-pin") && !importJoined.includes("secret"));

  // sign command references the temp store + thumbprint
  assert.ok(r.signCommand.args.includes("/s"));
  assert.ok(r.signCommand.args.includes(tempStore));
  assert.ok(r.signCommand.args.includes("/sha1"));
  assert.ok(r.signCommand.args.includes(THUMB));

  // cleanup step removes the temp store
  assert.ok(r.cleanupStep);
  assert.ok(r.cleanupStep.args.includes("-Cleanup"));
  assert.ok(r.cleanupStep.args.includes(tempStore));
});

test("planPfxSign rejects unauthorized paths", () => {
  const { store, cert } = storeWithCert();
  assert.throws(
    () => planPfxSign(
      toolchain,
      { inFile: "C:\\evil\\app.exe", outFile: "C:\\authorized\\out.exe", credentialId: cert.id, timestampOrigin: TS, helperPath: HELPER },
      { authorizeHostPath: allowHost, credentialStore: store, certInspector: validInspector },
    ),
    /host path outside authorized directory/,
  );
});

test("planSignToolVerify builds verify command", () => {
  const r = planSignToolVerify(
    toolchain,
    { inFile: "C:\\authorized\\app-signed.exe" },
    { authorizeHostPath: allowHost },
  );
  assert.equal(r.verifyCommand.executable, "C:\\sdk\\bin\\x64\\signtool.exe");
  assert.deepEqual(r.verifyCommand.args, ["verify", "/pa", "/all", "C:\\authorized\\app-signed.exe"]);
});

test("planSignToolVerify rejects unauthorized path", () => {
  assert.throws(
    () => planSignToolVerify(
      toolchain,
      { inFile: "C:\\evil\\app.exe" },
      { authorizeHostPath: allowHost },
    ),
    /host path outside authorized directory/,
  );
});

test("resolveSigningCredential returns thumbprint without inspector", () => {
  const { store, cert } = storeWithCert();
  const r = resolveSigningCredential(store, cert.id);
  assert.equal(r.thumbprint, THUMB);
  assert.equal(r.alias, "codesign");
  assert.ok(!r.metadata);
});

test("resolveSigningCredential throws on unknown id", () => {
  const { store } = storeWithCert();
  assert.throws(
    () => resolveSigningCredential(store, "00000000-0000-0000-0000-000000000000"),
    /unknown signing credential id/,
  );
});
