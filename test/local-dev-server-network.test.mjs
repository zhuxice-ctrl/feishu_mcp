import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { assertPermittedPort, assertPortAvailable, waitForServerReady, publicServerUrls } = await import("../dist/development/servers/network.js");

test("port policy and availability reject unsafe or occupied ports", async () => {
  assert.doesNotThrow(() => assertPermittedPort(5173, { min: 5173, max: 5179 }, { min: 1024, max: 9999 }));
  assert.throws(() => assertPermittedPort(80, { min: 5173, max: 5179 }, { min: 1024, max: 9999 }));
  const server = http.createServer((_, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await assert.rejects(() => assertPortAvailable(port), /unavailable/);
  await new Promise((resolve) => server.close(resolve));
  await assert.doesNotReject(() => assertPortAvailable(port));
});

test("readiness always probes loopback and public URLs omit loopback from LAN", async () => {
  const server = http.createServer((request, response) => { assert.equal(request.url, "/ready"); response.end("ok"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await waitForServerReady(port, "/ready", 1_000);
  await assert.rejects(() => waitForServerReady(port, "https://host/", 1), /invalid health path/);
  await new Promise((resolve) => server.close(resolve));
  const local = publicServerUrls(5173, "local");
  assert.deepEqual(local, { localUrl: "http://127.0.0.1:5173", lanUrls: [] });
  assert.equal(publicServerUrls(5173, "lan").lanUrls.every((url) => !url.includes("127.0.0.1")), true);
});
