import assert from "node:assert/strict";
import test from "node:test";

const { toolError, toolJson } = await import("../dist/tools/results.js");

test("toolError exposes stable machine-readable fields", () => {
  const result = toolError("QUEUE_TIMEOUT", "busy", true);

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: "QUEUE_TIMEOUT",
    message: "busy",
    retryable: true,
  });
  assert.deepEqual(result.structuredContent, {
    ok: false,
    code: "QUEUE_TIMEOUT",
    message: "busy",
    retryable: true,
  });
});

test("toolJson returns matching text and structured content", () => {
  const body = { ok: true, result: ["one", "two"] };
  const result = toolJson(body);

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), body);
  assert.deepEqual(result.structuredContent, body);
});
