import assert from "node:assert/strict";
import test from "node:test";

// Import the built module (restart.ts registers nothing on import).
const mod = await import("../dist/tools/restart.js");

test("restartBlockedReason refuses without the managed-launch marker", () => {
  assert.match(mod.restartBlockedReason({}), /RESTART_NOT_MANAGED/);
  assert.match(
    mod.restartBlockedReason({ FEISHU_MCP_MANAGED_LAUNCH: "0" }),
    /RESTART_NOT_MANAGED/,
  );
});

test("restartBlockedReason allows with the managed-launch marker", () => {
  assert.equal(mod.restartBlockedReason({ FEISHU_MCP_MANAGED_LAUNCH: "1" }), null);
});

test("tailLines keeps only the last non-empty lines", () => {
  assert.equal(mod.tailLines("a\n\nb\r\nc\nd\n", 2), "c\nd");
  assert.equal(mod.tailLines("", 3), "");
  assert.equal(mod.tailLines("only", 5), "only");
});
