import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { isBlockedMetadataAddress, validateNetworkTarget } = await import("../dist/security/networkGuard.js");

test("blocks common IPv4 and IPv6 metadata addresses", () => {
  assert.equal(isBlockedMetadataAddress("169.254.169.254"), true);
  assert.equal(isBlockedMetadataAddress("169.254.170.2"), true);
  assert.equal(isBlockedMetadataAddress("100.100.100.200"), true);
  assert.equal(isBlockedMetadataAddress("fe80::1"), true);
  assert.equal(isBlockedMetadataAddress("127.0.0.1"), false);
  assert.equal(isBlockedMetadataAddress("192.168.1.10"), false);
});

test("rejects non-http protocols and URL credentials", async () => {
  await assert.rejects(validateNetworkTarget("file:///etc/passwd"), /Only HTTP and HTTPS/);
  await assert.rejects(validateNetworkTarget("http://user:pass@example.com/"), /credentials/);
});

test("allows localhost after validation while rejecting metadata literals", async () => {
  const localhost = await validateNetworkTarget("http://127.0.0.1:8080/path");
  assert.equal(localhost.origin, "http://127.0.0.1:8080");
  assert.deepEqual(localhost.addresses, [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(validateNetworkTarget("http://169.254.169.254/latest/meta-data"), /metadata/);
});

test("artifact imports require public HTTPS network targets", async () => {
  await assert.rejects(
    validateNetworkTarget("http://8.8.8.8/file", { policy: "artifact_import" }),
    /HTTPS/i,
  );
  await assert.rejects(
    validateNetworkTarget("https://user:pass@8.8.8.8/file", { policy: "artifact_import" }),
    /credentials/i,
  );
  for (const host of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.1", "[::1]", "[fc00::1]", "[fe80::1]"]) {
    await assert.rejects(
      validateNetworkTarget(`https://${host}/file`, { policy: "artifact_import" }),
      /public network|metadata/i,
      host,
    );
  }
  const target = await validateNetworkTarget("https://8.8.8.8/file", { policy: "artifact_import" });
  assert.equal(target.origin, "https://8.8.8.8");
});
