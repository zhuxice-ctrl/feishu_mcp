import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "feishu-web-fetch-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = dataDir;
process.env.APPROVAL_STATE_SECRET = "55667788990011223344aabbccddeeff";
process.env.FETCH_MAX_BYTES = "64";
process.env.LOG_LEVEL = "error";

const { webFetch } = await import("../dist/tools/webFetch.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");
const { htmlToMarkdown, htmlToText } = await import("../dist/tools/html.js");

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function context({ state, decision } = {}) {
  return {
    mcpReq: {
      envelope: {},
      requestState: () => state,
      inputResponses: decision ? { approval: { action: "accept", content: { decision } } } : undefined,
      signal: new AbortController().signal,
    },
  };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test.after(async () => rm(dataDir, { recursive: true, force: true }));

test("converts HTML to text and markdown without scripts", () => {
  const html = "<h1>Title</h1><p>Hello <a href='https://example.com'>site</a></p><script>secret()</script>";
  assert.doesNotMatch(htmlToText(html), /secret/);
  assert.match(htmlToText(html), /Title/);
  assert.match(htmlToMarkdown(html), /#Title/);
  assert.match(htmlToMarkdown(html), /\[site\]\(https:\/\/example\.com\)/);
});

test("completes an approval round and fetches HTML", async () => {
  const item = await listen((_req, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<h1>Hello</h1><p>world</p>");
  });
  try {
    const args = { url: `${item.origin}/page`, format: "text" };
    const initial = await webFetch(args, context());
    assert.equal(initial.resultType, "input_required");
    const state = await approvalStateCodec.verify(initial.requestState, context());
    const result = await webFetch(args, context({ state, decision: "allow_once" }));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 200);
    assert.match(body.content, /Hello/);
    assert.doesNotMatch(body.content, /<h1>/);
  } finally { await close(item.server); }
});

test("requires a separately signed approval for a cross-origin redirect", async () => {
  const destination = await listen((_req, response) => response.end("destination"));
  const source = await listen((_req, response) => {
    response.statusCode = 302;
    response.setHeader("location", `${destination.origin}/final`);
    response.end();
  });
  try {
    const args = { url: `${source.origin}/start` };
    const first = await webFetch(args, context());
    const firstState = await approvalStateCodec.verify(first.requestState, context());
    const second = await webFetch(args, context({ state: firstState, decision: "allow_once" }));
    assert.equal(second.resultType, "input_required");
    const secondState = await approvalStateCodec.verify(second.requestState, context());
    assert.ok(secondState.priorSubjectKeys.includes(source.origin));
    const result = await webFetch(args, context({ state: secondState, decision: "allow_once" }));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.content, "destination");
    assert.equal(body.redirects.length, 1);
    assert.equal(body.finalUrl, `${destination.origin}/final`);
  } finally {
    await close(source.server);
    await close(destination.server);
  }
});

test("truncates oversized responses and times out slow responses", async () => {
  const item = await listen((request, response) => {
    if (request.url === "/slow") setTimeout(() => response.end("late"), 200);
    else response.end("x".repeat(256));
  });
  try {
    const { approvalStore } = await import("../dist/security/approvalStore.js");
    approvalStore.rememberSession(null, "web_fetch", item.origin);
    const large = JSON.parse((await webFetch({ url: `${item.origin}/large` }, context())).content[0].text);
    assert.equal(large.bytes, 64);
    assert.equal(large.truncated, true);
    const slow = await webFetch({ url: `${item.origin}/slow`, timeout: 50 }, context());
    assert.equal(slow.isError, true);
    assert.match(slow.content[0].text, /timed out|aborted/i);
  } finally { await close(item.server); }
});
