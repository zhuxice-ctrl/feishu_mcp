import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.LOG_LEVEL = "error";

const { todoRead, todoWrite } = await import("../dist/tools/todo.js");
const { runWithRequestContext } = await import("../dist/security/requestContext.js");
const execFileAsync = promisify(execFile);

function asUser(userId, fn) {
  return runWithRequestContext({ token: "", userId, email: null }, fn);
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

test("todo lists are isolated per user and writes replace the whole list", async () => {
  const alice = await asUser("todo-alice", () => todoWrite([
    { id: "first", content: "Plan", status: "pending", priority: "high" },
    { content: "Build", status: "in_progress" },
  ]));
  assert.deepEqual(body(alice).counts, { total: 2, pending: 1, in_progress: 1, completed: 0 });

  await asUser("todo-bob", () => todoWrite([{ content: "Independent" }]));
  assert.equal(body(await asUser("todo-bob", todoRead)).todos.length, 1);

  const replacement = body(await asUser("todo-alice", () => todoWrite([
    { content: "Done", status: "completed", priority: "low" },
  ])));
  assert.deepEqual(replacement.counts, { total: 1, pending: 0, in_progress: 0, completed: 1 });
  assert.equal(body(await asUser("todo-alice", todoRead)).todos[0].content, "Done");
});

test("todo validation enforces statuses, priorities, item and content limits", async () => {
  for (const todos of [
    [{ content: "Bad status", status: "blocked" }],
    [{ content: "Bad priority", priority: "urgent" }],
    Array.from({ length: 101 }, (_, index) => ({ content: `Task ${index}` })),
    [{ content: "x".repeat(501) }],
    "not a list",
  ]) {
    const result = await asUser("todo-invalid", () => todoWrite(todos));
    assert.deepEqual(body(result), {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "Todos must be a list of at most 100 valid todo items.",
      retryable: false,
    });
  }
});

test("multiple in-progress todos are accepted with a warning", async () => {
  const result = body(await asUser("todo-warning", () => todoWrite([
    { content: "First", status: "in_progress" },
    { content: "Second", status: "in_progress" },
  ])));
  assert.equal(result.counts.in_progress, 2);
  assert.match(result.warning, /2 items are in progress/i);
});

test("todo data is volatile across a process restart", async () => {
  await asUser("todo-restart", () => todoWrite([{ content: "Not persisted" }]));
  const source = [
    "import { todoRead } from './dist/tools/todo.js';",
    "import { runWithRequestContext } from './dist/security/requestContext.js';",
    "const result = await runWithRequestContext({ token: '', userId: 'todo-restart', email: null }, todoRead);",
    "process.stdout.write(result.content[0].text);",
  ].join(" ");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    todos: [],
    counts: { total: 0, pending: 0, in_progress: 0, completed: 0 },
  });
});
