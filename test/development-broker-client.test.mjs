/**
 * Tests for the administrator-broker client.
 *
 * A temporary mock Unix-domain-socket server stands in for the Windows named
 * pipe.  The tests assert:
 *  - the request frame is length-capped at 64 KiB;
 *  - the canonical fields are HMAC-signed and the server can verify them;
 *  - a non-responding server triggers a timeout (mapped to BROKER_UNAVAILABLE);
 *  - a protocol error response is mapped to the correct MCP error code;
 *  - an early disconnect is mapped to BROKER_UNAVAILABLE;
 *  - error messages never expose the pipe path, key, or hex nonce/hmac.
 */

import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

function cleanupSocket(sockPath) {
  try { fs.rmSync(sockPath, { force: true }); } catch { /* already gone */ }
}

process.env.AUTH_MODE = "none";
process.env.LOG_LEVEL = "error";

const { BrokerClient, BrokerClientError, BROKER_MAX_FRAME_BYTES, BROKER_PROTOCOL_VERSION } =
  await import("../dist/development/environment/brokerClient.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY = randomBytes(32);
const OWNER_SID = "S-1-5-21-1234567890-123456789-123456789-1001";
const CATALOG_DIGEST = "45f6d3516f44418d396ff68cf2ae14dacf9b3458cdfb1ee6d9404d78f65dc533";

function canonical(fields) {
  return [
    fields.protocolVersion,
    fields.requestId,
    fields.planId,
    fields.operationId,
    fields.componentId,
    fields.version,
    fields.catalogDigest,
    fields.ownerSid,
    fields.timestamp,
    fields.nonce,
  ].join("\n");
}

function expectedHmac(fields) {
  return createHmac("sha256", KEY).update(canonical(fields), "utf8").digest("hex");
}

/** Start a mock server that receives one connection and calls `handler(socket, request)`. */
function startMockServer(handler) {
  return new Promise((resolve) => {
    const sockPath = path.join(os.tmpdir(), `broker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = net.createServer((socket) => {
      readFrame(socket, BROKER_MAX_FRAME_BYTES)
        .then((body) => {
          const req = JSON.parse(body.toString("utf8"));
          handler(socket, req);
        })
        .catch(() => socket.destroy());
    });
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
}

function readFrame(socket, maxBytes) {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let readingBody = false;
    let expected = 0;
    const onData = (chunk) => {
      let buf = chunk;
      while (buf.length > 0) {
        if (!readingBody) {
          const remaining = 4 - header.length;
          const take = Math.min(remaining, buf.length);
          header = Buffer.concat([header, buf.subarray(0, take)]);
          buf = buf.subarray(take);
          if (header.length === 4) {
            expected = header.readUInt32BE(0);
            if (expected === 0 || expected > maxBytes) {
              socket.off("data", onData);
              reject(new Error("frame too large"));
              return;
            }
            readingBody = true;
            body = Buffer.alloc(0);
          }
        } else {
          const remaining = expected - body.length;
          const take = Math.min(remaining, buf.length);
          body = Buffer.concat([body, buf.subarray(0, take)]);
          buf = buf.subarray(take);
          if (body.length === expected) {
            socket.off("data", onData);
            resolve(body);
            return;
          }
        }
      }
    };
    socket.on("data", onData);
    socket.on("end", () => reject(new Error("disconnected")));
  });
}

function writeFrame(socket, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  socket.write(header);
  socket.write(body);
}

function makeClient(sockPath, overrides = {}) {
  return new BrokerClient({
    pipePath: sockPath,
    key: KEY,
    ownerSid: OWNER_SID,
    catalogDigest: CATALOG_DIGEST,
    connectTimeoutMs: overrides.connectTimeoutMs ?? 2_000,
    clock: overrides.clock ?? (() => new Date(0)),
    nonceGen: overrides.nonceGen ?? (() => "fixed-nonce-1234"),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("signs canonical fields with HMAC and server can verify", async () => {
  const { server, sockPath } = await startMockServer((socket, req) => {
    // Verify the HMAC the client sent
    const { hmac, ...fields } = req;
    assert.equal(hmac, expectedHmac(fields));
    assert.equal(fields.protocolVersion, BROKER_PROTOCOL_VERSION);
    assert.equal(fields.ownerSid, OWNER_SID);
    assert.equal(fields.catalogDigest, CATALOG_DIGEST);
    writeFrame(socket, { accepted: true, exitCode: 0, stage: "complete" });
  });
  const client = makeClient(sockPath);
  const result = await client.apply({
    operationId: "winget",
    planId: "11111111-2222-3333-4444-555555555555",
    componentId: "microsoft.openjdk.17",
    version: "17.0.9",
  });
  assert.equal(result.accepted, true);
  assert.equal(result.exitCode, 0);
  server.close();
  cleanupSocket(sockPath);
});

test("rejects request exceeding 64 KiB frame cap", async () => {
  // No server needed — the client rejects before connecting
  const client = makeClient("/nonexistent/path");
  // Build an input whose JSON serialization exceeds 64 KiB
  const hugeVersion = "x".repeat(BROKER_MAX_FRAME_BYTES + 100);
  await assert.rejects(
    () => client.apply({
      operationId: "winget",
      planId: "11111111-2222-3333-4444-555555555555",
      componentId: "test",
      version: hugeVersion,
    }),
    (err) => {
      assert.ok(err instanceof BrokerClientError);
      assert.equal(err.code, "BROKER_REQUEST_TOO_LARGE");
      return true;
    },
  );
});

test("maps broker protocol error to MCP error code", async () => {
  const { server, sockPath } = await startMockServer((socket, _req) => {
    writeFrame(socket, { accepted: false, error: "InvalidHmac" });
  });
  const client = makeClient(sockPath);
  const result = await client.apply({
    operationId: "winget",
    planId: "11111111-2222-3333-4444-555555555555",
    componentId: "test",
    version: "1.0",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.error, "BROKER_AUTH");
  server.close();
  cleanupSocket(sockPath);
});

test("maps AlreadyApplied error", async () => {
  const { server, sockPath } = await startMockServer((socket, _req) => {
    writeFrame(socket, { accepted: false, error: "AlreadyApplied" });
  });
  const client = makeClient(sockPath);
  const result = await client.apply({
    operationId: "vs_workload",
    planId: "11111111-2222-3333-4444-555555555555",
    componentId: "test",
    version: "1.0",
  });
  assert.equal(result.error, "BROKER_ALREADY_APPLIED");
  server.close();
  cleanupSocket(sockPath);
});

test("timeout when server does not respond", async () => {
  const { server, sockPath } = await startMockServer((_socket, _req) => {
    // intentionally never respond
  });
  const client = makeClient(sockPath, { connectTimeoutMs: 500 });
  await assert.rejects(
    () => client.apply({
      operationId: "winget",
      planId: "11111111-2222-3333-4444-555555555555",
      componentId: "test",
      version: "1.0",
    }),
    (err) => {
      assert.ok(err instanceof BrokerClientError);
      assert.equal(err.code, "BROKER_UNAVAILABLE");
      return true;
    },
  );
  server.close();
  cleanupSocket(sockPath);
});

test("early disconnect mapped to BROKER_UNAVAILABLE", async () => {
  const { server, sockPath } = await startMockServer((socket, _req) => {
    socket.destroy(); // disconnect immediately
  });
  const client = makeClient(sockPath);
  await assert.rejects(
    () => client.apply({
      operationId: "winget",
      planId: "11111111-2222-3333-4444-555555555555",
      componentId: "test",
      version: "1.0",
    }),
    (err) => {
      assert.ok(err instanceof BrokerClientError);
      assert.equal(err.code, "BROKER_UNAVAILABLE");
      return true;
    },
  );
  server.close();
  cleanupSocket(sockPath);
});

test("error messages never expose pipe path or hex strings", async () => {
  const pipePath = path.join(os.tmpdir(), `broker-test-leak-${Date.now()}.sock`);
  // Connect to a non-listening path to get a connection error
  const client = new BrokerClient({
    pipePath,
    key: KEY,
    ownerSid: OWNER_SID,
    catalogDigest: CATALOG_DIGEST,
    connectTimeoutMs: 500,
  });
  await assert.rejects(
    () => client.apply({
      operationId: "winget",
      planId: "11111111-2222-3333-4444-555555555555",
      componentId: "test",
      version: "1.0",
    }),
    (err) => {
      assert.ok(err instanceof BrokerClientError);
      const msg = err.message;
      // pipe path should be redacted
      assert.doesNotMatch(msg, /broker-test-leak/);
      // any 32+ hex string should be redacted
      assert.doesNotMatch(msg, /[0-9a-f]{32,}/i);
      return true;
    },
  );
});
