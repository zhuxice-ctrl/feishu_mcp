import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-single-use-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "single-use-secret-0123456789abcdef";
process.env.LOG_LEVEL = "error";

const { requestApproval, digestArguments } = await import("../dist/security/approval.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");

function context({ state, decision } = {}) {
  return {
    mcpReq: {
      envelope: {},
      requestState: () => state,
      inputResponses: decision
        ? { approval: { action: "accept", content: { decision } } }
        : undefined,
    },
  };
}

function request(key, decisionMode) {
  return {
    tool: "android_development",
    userId: "alice",
    subject: { kind: "development", key, display: "[development]" },
    argsDigest: digestArguments({ action: key }),
    reasons: ["state changing"],
    ...(decisionMode ? { decisionMode } : {}),
  };
}

/** Recursively locate the elicitation decision enum regardless of wrapper shape. */
function findDecisionEnum(obj, seen = new WeakSet()) {
  if (!obj || typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);
  const decision = obj.decision;
  if (decision && Array.isArray(decision.enum)) return decision.enum;
  for (const value of Object.values(obj)) {
    const found = findDecisionEnum(value, seen);
    if (found) return found;
  }
  return null;
}

test.after(async () => rm(root, { recursive: true, force: true }));

test("single-use approval elicits only allow_once and deny", async () => {
  const initial = await requestApproval(context(), request("single-enum", "single_use"));
  assert.equal(initial.resultType, "input_required");
  assert.deepEqual(findDecisionEnum(initial.inputRequests.approval), ["allow_once", "deny"]);
});

test("single-use approval rejects an injected allow_session decision", async () => {
  const initial = await requestApproval(context(), request("single-session", "single_use"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  const result = await requestApproval(
    context({ state, decision: "allow_session" }),
    request("single-session", "single_use"),
  );
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.code, "APPROVAL_DENIED");
  assert.equal(body.message, "This operation requires a single-use decision.");
});

test("single-use approval rejects an injected allow_permanent decision", async () => {
  const initial = await requestApproval(context(), request("single-permanent", "single_use"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  const result = await requestApproval(
    context({ state, decision: "allow_permanent" }),
    request("single-permanent", "single_use"),
  );
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.code, "APPROVAL_DENIED");
  assert.equal(body.message, "This operation requires a single-use decision.");
});

test("single-use allow_once completes without persisting a session grant", async () => {
  const initial = await requestApproval(context(), request("single-once", "single_use"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  assert.equal(
    await requestApproval(context({ state, decision: "allow_once" }), request("single-once", "single_use")),
    true,
  );
  const replay = await requestApproval(context(), request("single-once", "single_use"));
  assert.equal(replay.resultType, "input_required");
});

test("standard approvals still elicit all four choices", async () => {
  const initial = await requestApproval(context(), request("standard-enum", "standard"));
  assert.deepEqual(findDecisionEnum(initial.inputRequests.approval), [
    "allow_once",
    "allow_session",
    "allow_permanent",
    "deny",
  ]);
});
