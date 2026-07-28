import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-approval-flow-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "abcdef0123456789abcdef0123456789";
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

function request(key) {
  return {
    tool: "execute_command",
    userId: "alice",
    subject: { kind: "command", key, display: "[command]" },
    argsDigest: digestArguments({ command: key }),
    reasons: ["state changing"],
  };
}

test.after(async () => rm(root, { recursive: true, force: true }));

test("approval flow emits input_required then accepts once and blocks replay", async () => {
  const initial = await requestApproval(context(), request("once"));
  assert.equal(initial.resultType, "input_required");
  assert.ok(initial.inputRequests.approval);
  const state = await approvalStateCodec.verify(initial.requestState, context());
  assert.equal(await requestApproval(context({ state, decision: "allow_once" }), request("once")), true);
  const replay = await requestApproval(context({ state, decision: "allow_once" }), request("once"));
  assert.equal(replay.isError, true);
  assert.equal(JSON.parse(replay.content[0].text).code, "APPROVAL_DENIED");
});

test("approval state cannot authorize changed arguments", async () => {
  const initial = await requestApproval(context(), request("original"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  const changed = await requestApproval(
    context({ state, decision: "allow_once" }),
    request("changed"),
  );
  assert.equal(JSON.parse(changed.content[0].text).code, "APPROVAL_DENIED");
});

test("session approval applies only to the same exact subject", async () => {
  const initial = await requestApproval(context(), request("session"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  assert.equal(await requestApproval(context({ state, decision: "allow_session" }), request("session")), true);
  assert.equal(await requestApproval(context(), request("session")), true);
  const other = await requestApproval(context(), request("different"));
  assert.equal(other.resultType, "input_required");
});

test("deny returns a structured non-retryable error", async () => {
  const initial = await requestApproval(context(), request("deny"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  const denied = await requestApproval(context({ state, decision: "deny" }), request("deny"));
  assert.deepEqual(JSON.parse(denied.content[0].text), {
    ok: false,
    code: "APPROVAL_DENIED",
    message: "The user denied this operation.",
    retryable: false,
  });
});

test("permanent approval survives a fresh approval store instance", async () => {
  const initial = await requestApproval(context(), request("permanent"));
  const state = await approvalStateCodec.verify(initial.requestState, context());
  assert.equal(
    await requestApproval(context({ state, decision: "allow_permanent" }), request("permanent")),
    true,
  );
  const { ApprovalStore } = await import("../dist/security/approvalStore.js");
  const reloaded = new ApprovalStore(root);
  assert.equal(reloaded.has("alice", "execute_command", "permanent"), true);
});

test("a legacy request without elicitation support is denied without terminal fallback", async () => {
  const unsupported = await requestApproval(
    { mcpReq: { requestState: () => undefined, inputResponses: undefined } },
    request("legacy"),
  );
  assert.equal(JSON.parse(unsupported.content[0].text).code, "CLIENT_ELICITATION_UNSUPPORTED");
});
