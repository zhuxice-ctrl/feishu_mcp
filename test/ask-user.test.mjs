import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "feishu-ask-user-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = stateDir;
process.env.APPROVAL_STATE_SECRET = "aabbccddeeff00112233445566778899";
process.env.LOG_LEVEL = "error";

const { askUser } = await import("../dist/tools/askUser.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");

function context({ state, response, supported = true } = {}) {
  return {
    mcpReq: {
      envelope: supported ? {} : undefined,
      requestState: () => state,
      inputResponses: response ? { answer: response } : undefined,
    },
  };
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

async function begin(args) {
  const initial = await askUser(args, context());
  assert.equal(initial.resultType, "input_required");
  return { initial, state: await approvalStateCodec.verify(initial.requestState, context()) };
}

test.after(async () => rm(stateDir, { recursive: true, force: true }));

test("asks free-text questions with a single string input and returns the answer", async () => {
  const args = { question: "What should we build?", context: "One sentence." };
  const { initial, state } = await begin(args);
  const request = initial.inputRequests.answer;
  assert.deepEqual(request.params.requestedSchema.properties.answer, {
    type: "string", title: "Your answer", minLength: 1, maxLength: 4000,
  });
  const result = body(await askUser(args, context({ state, response: {
    action: "accept", content: { answer: "A local-first tool." },
  } })));
  assert.deepEqual(result, { ok: true, answered: true, answer: "A local-first tool." });
});

test("asks numbered choices with an enum and reports the selected index", async () => {
  const args = { question: "Choose", options: ["one", "two", "three"] };
  const { initial, state } = await begin(args);
  assert.deepEqual(initial.inputRequests.answer.params.requestedSchema.properties.answer.enum, args.options);
  const result = body(await askUser(args, context({ state, response: {
    action: "accept", content: { answer: "two" },
  } })));
  assert.deepEqual(result, {
    ok: true, answered: true, answer: "two", selectedIndex: 1,
  });
});

test("reports declined, cancelled, and timed-out question rounds", async () => {
  for (const [response, reason] of [
    [{ action: "decline" }, "declined"],
    [{ action: "cancel" }, "cancelled"],
    [undefined, "timeout"],
  ]) {
    const args = { question: `Outcome ${reason}` };
    const { state } = await begin(args);
    const result = body(await askUser(args, context({ state, response })));
    assert.deepEqual(result, { ok: true, answered: false, reason });
  }
});

test("does not fall back to stdin when elicitation is unsupported", async () => {
  const result = body(await askUser({ question: "Unsupported?" }, context({ supported: false })));
  assert.deepEqual(result, {
    ok: false,
    code: "CLIENT_ELICITATION_UNSUPPORTED",
    message: "This MCP client cannot display a supplemental-information form.",
    retryable: false,
  });
});

test("question and option changes invalidate request state", async () => {
  const args = { question: "Original", options: ["yes", "no"] };
  for (const changedArgs of [
    { question: "Changed", options: ["yes", "no"] },
    { question: "Original", options: ["yes", "maybe"] },
  ]) {
    const { state } = await begin(args);
    const result = body(await askUser(changedArgs, context({
      state,
      response: { action: "accept", content: { answer: "yes" } },
    })));
    assert.equal(result.code, "APPROVAL_DENIED");
  }
});

test("a signed question state cannot be replayed", async () => {
  const args = { question: "Only once" };
  const { state } = await begin(args);
  const first = body(await askUser(args, context({ state, response: {
    action: "accept", content: { answer: "answered" },
  } })));
  assert.equal(first.answered, true);
  const replay = body(await askUser(args, context({ state, response: {
    action: "accept", content: { answer: "answered" },
  } })));
  assert.equal(replay.code, "APPROVAL_DENIED");
});
