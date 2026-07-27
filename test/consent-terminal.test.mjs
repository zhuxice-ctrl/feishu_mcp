import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { createConsentGate } = await import("../dist/security/consent.js");
const { createTerminal } = await import("../dist/security/terminal.js");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("terminal serializes real prompts until the active answer resolves", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => (rendered += chunk));

  const terminal = createTerminal({ input, output, interactive: true });
  try {
    const first = terminal.prompt({ render: () => "first> ", timeoutMs: 1_000 });
    const second = terminal.prompt({ render: () => "second> ", timeoutMs: 1_000 });
    await tick();
    assert.equal(rendered, "first> ");

    input.write("yes\n");
    assert.deepEqual(await first, { answer: "yes", timedOut: false });
    await tick();
    assert.equal(rendered, "first> second> ");

    input.write("no\n");
    assert.deepEqual(await second, { answer: "no", timedOut: false });
  } finally {
    terminal.close();
  }
});

test("terminal reports EOF as a timed-out denial", async () => {
  const input = new PassThrough();
  const terminal = createTerminal({ input, output: new PassThrough(), interactive: true });
  try {
    const result = terminal.prompt({ render: () => "confirm> ", timeoutMs: 1_000 });
    input.end();
    assert.deepEqual(await result, { answer: null, timedOut: true });
  } finally {
    terminal.close();
  }
});

test("terminal timeout returns a null answer", async () => {
  const terminal = createTerminal({
    input: new PassThrough(),
    output: new PassThrough(),
    interactive: true,
  });
  try {
    assert.deepEqual(
      await terminal.prompt({ render: () => "confirm> ", timeoutMs: 5 }),
      { answer: null, timedOut: true }
    );
  } finally {
    terminal.close();
  }
});

test("consent remembers combined policy kinds and denies confirmations without a TTY", async () => {
  let prompts = 0;
  const answers = ["a", "n"];
  const interactiveTerminal = {
    prompt: async () => {
      prompts += 1;
      return { answer: answers.shift(), timedOut: false };
    },
    isInteractive: () => true,
    write: () => {},
    pending: () => 0,
    close: () => {},
  };
  const options = {
    absolutePathPolicy: "confirm",
    sensitiveFilePolicy: "confirm",
    nonInteractivePolicy: "deny",
    timeoutMs: 10,
  };
  const gate = createConsentGate(interactiveTerminal, options);
  const request = {
    kinds: ["absolute_path", "sensitive_file"],
    tool: "read_file",
    userId: "alice",
    argName: "path",
    raw: "/workspace/.env",
    resolved: "/workspace/.env",
  };
  assert.equal((await gate.request(request)).allowed, true);
  const remembered = await gate.request(request);
  assert.deepEqual(remembered, { allowed: true, source: "remembered" });
  assert.equal(prompts, 1);
  const subset = await gate.request({ ...request, kinds: ["absolute_path"] });
  assert.deepEqual(subset, { allowed: false, source: "operator" });
  assert.equal(prompts, 2);

  const nonInteractiveGate = createConsentGate(
    { ...interactiveTerminal, isInteractive: () => false },
    options
  );
  const fallback = await nonInteractiveGate.request({
    ...request,
    kinds: ["absolute_path"],
  });
  assert.deepEqual(fallback, { allowed: false, source: "non_interactive_policy" });
});
