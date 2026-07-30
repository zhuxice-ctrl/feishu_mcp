import { test } from "node:test";
import assert from "node:assert/strict";

import { planApksignerSign, planApksignerVerify } from "../dist/development/android/signing.js";
import { LocalCredentialStore, InMemoryCredentialResolver } from "../dist/development/credentials/dpapiStore.js";
import { resolveAndroidToolchain } from "../dist/development/android/toolchain.js";

function readySnapshot() {
  return {
    version: 1, catalogDigest: "d", digest: "x", createdAt: "2026-07-30T00:00:00.000Z",
    components: [
      { componentId: "microsoft.openjdk.17", target: "android", state: "ready", realPath: "C:\\jdk\\java.exe", fileIdentity: "i", version: "17" },
      { componentId: "org.gradle.distribution", target: "android", state: "ready", realPath: "C:\\gradle\\gradle.bat", fileIdentity: "i", version: "8.9" },
      { componentId: "google.android.commandlinetools", target: "android", state: "ready", realPath: "C:\\sdk\\cmdline\\sdkmanager.bat", fileIdentity: "i", version: "11" },
      { componentId: "google.android.platform-tools", target: "android", state: "ready", realPath: "C:\\sdk\\adb.exe", fileIdentity: "i", version: "35" },
      { componentId: "google.android.emulator", target: "android", state: "ready", realPath: "C:\\sdk\\emulator.exe", fileIdentity: "i", version: "35" },
      { componentId: "google.android.build-tools.35", target: "android", state: "ready", realPath: "C:\\sdk\\apksigner.bat", fileIdentity: "i", version: "35" },
    ],
  };
}
const toolchain = resolveAndroidToolchain(readySnapshot()).toolchain;
const allowHost = (p) => p.startsWith("C:\\authorized\\");

function storeWithCreds() {
  const store = new LocalCredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "sign-creds-")));
  const ks = store.register({ kind: "keystore", alias: "release", fingerprint: "ab:cd" });
  const key = store.register({ kind: "key", alias: "release", fingerprint: "ef:12" });
  return { store, ks, key };
}

test("planApksignerSign binds env credential refs and staging output", () => {
  const { store, ks, key } = storeWithCreds();
  const r = planApksignerSign(
    toolchain,
    {
      inApk: "C:\\authorized\\app-debug-unsigned.apk",
      outApk: "C:\\authorized\\app-debug.apk",
      keystore: "C:\\authorized\\release.jks",
      ksAlias: "release",
      ksCredentialId: ks.id,
      keyCredentialId: key.id,
    },
    { authorizeHostPath: allowHost, credentialStore: store },
  );
  assert.ok(r.signPlan.args.includes("sign"));
  assert.ok(r.signPlan.args.includes("env:FEISHU_MCP_KS_PASS"));
  assert.ok(r.signPlan.args.includes("env:FEISHU_MCP_KEY_PASS"));
  assert.deepEqual(r.secretEnvRefs, {
    FEISHU_MCP_KS_PASS: ks.id,
    FEISHU_MCP_KEY_PASS: key.id,
  });
  // staging output is derived, not the final outApk, so verify+move is atomic
  assert.notEqual(r.stagingOut, r.outApk);
  assert.equal(r.outApk, "C:\\authorized\\app-debug.apk");
});

test("planApksignerSign rejects unauthorized keystore path", () => {
  const { store, ks, key } = storeWithCreds();
  assert.throws(
    () =>
      planApksignerSign(
        toolchain,
        {
          inApk: "C:\\authorized\\app.apk",
          outApk: "C:\\authorized\\out.apk",
          keystore: "C:\\evil\\release.jks",
          ksAlias: "release",
          ksCredentialId: ks.id,
          keyCredentialId: key.id,
        },
        { authorizeHostPath: allowHost, credentialStore: store },
      ),
    /authorized|outside/i,
  );
});

test("planApksignerSign rejects unknown credential id", () => {
  const { store } = storeWithCreds();
  assert.throws(
    () =>
      planApksignerSign(
        toolchain,
        {
          inApk: "C:\\authorized\\app.apk",
          outApk: "C:\\authorized\\out.apk",
          keystore: "C:\\authorized\\release.jks",
          ksAlias: "release",
          ksCredentialId: "missing",
          keyCredentialId: "missing",
        },
        { authorizeHostPath: allowHost, credentialStore: store },
      ),
    /credential/i,
  );
});

test("planApksignerSign never puts a literal secret in args", () => {
  const { store, ks, key } = storeWithCreds();
  const r = planApksignerSign(
    toolchain,
    {
      inApk: "C:\\authorized\\app-debug-unsigned.apk",
      outApk: "C:\\authorized\\app-debug.apk",
      keystore: "C:\\authorized\\release.jks",
      ksAlias: "release",
      ksCredentialId: ks.id,
      keyCredentialId: key.id,
    },
    { authorizeHostPath: allowHost, credentialStore: store },
  );
  const joined = r.signPlan.args.join(" ");
  assert.ok(!/password|hunter2|supersecret/i.test(joined));
});

test("planApksignerVerify builds fixed verify command", () => {
  const r = planApksignerVerify(toolchain, { inApk: "C:\\authorized\\app-debug.apk" }, { authorizeHostPath: allowHost });
  assert.ok(r.args.includes("verify"));
  assert.ok(r.args.includes("--verbose"));
  assert.ok(r.args.includes("--print-certs"));
  assert.ok(r.args.includes("C:\\authorized\\app-debug.apk"));
});

test("certificate summary is derivable from credential fingerprint", () => {
  const { store, ks } = storeWithCreds();
  const meta = store.list().find((m) => m.id === ks.id);
  assert.ok(meta.fingerprint);
  assert.ok(meta.fingerprint.includes(":"));
});
