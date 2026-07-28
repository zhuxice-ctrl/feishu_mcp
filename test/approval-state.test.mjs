import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-approval-state-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "0123456789abcdef0123456789abcdef";

const { runWithRequestContext } = await import("../dist/security/requestContext.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const { createRequestStateCodec } = await import("@modelcontextprotocol/server");

const payload = {
  version: 1,
  tool: "execute_command",
  userId: "alice",
  subjectKey: "subject",
  argsDigest: "digest",
  nonce: "nonce",
};

test.after(async () => rm(root, { recursive: true, force: true }));

test("request state verifies for the same request identity", async () => {
  const wire = await runWithRequestContext(
    { token: "", userId: "alice", email: null },
    () => approvalStateCodec.mint(payload, {}),
  );
  const decoded = await runWithRequestContext(
    { token: "", userId: "alice", email: null },
    () => approvalStateCodec.verify(wire, {}),
  );
  assert.deepEqual(decoded, payload);
});

test("request state rejects tampering and a different user", async () => {
  const wire = await runWithRequestContext(
    { token: "", userId: "alice", email: null },
    () => approvalStateCodec.mint(payload, {}),
  );
  const tampered = `${wire.slice(0, -1)}${wire.endsWith("x") ? "y" : "x"}`;
  await assert.rejects(
    runWithRequestContext(
      { token: "", userId: "alice", email: null },
      () => approvalStateCodec.verify(tampered, {}),
    ),
  );
  await assert.rejects(
    runWithRequestContext(
      { token: "", userId: "bob", email: null },
      () => approvalStateCodec.verify(wire, {}),
    ),
  );
});

test("request state expires", async () => {
  const shortLived = createRequestStateCodec({
    key: "fedcba9876543210fedcba9876543210",
    ttlSeconds: 1,
  });
  const wire = await shortLived.mint({ value: "short" });
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  await assert.rejects(shortLived.verify(wire, {}));
});
