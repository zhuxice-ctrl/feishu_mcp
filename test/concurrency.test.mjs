import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { Semaphore, concurrencySummary, withConcurrency } = await import(
  "../dist/tools/concurrency.js"
);

test("semaphore rejects a queued waiter after its timeout", async () => {
  const gate = new Semaphore(1, "commands");
  const release = await gate.acquire(100);

  await assert.rejects(gate.acquire(5), /commands.*queue timeout/i);
  release();
});

test("semaphore grants waiters in FIFO order", async () => {
  const gate = new Semaphore(1, "fifo");
  const events = [];
  const releaseFirst = await gate.acquire(100);
  const second = gate.acquire(100).then((release) => {
    events.push("second");
    return release;
  });
  const third = gate.acquire(100).then((release) => {
    events.push("third");
    return release;
  });

  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(events, ["second"]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(events, ["second", "third"]);
  releaseThird();
});

test("withConcurrency releases slots after exceptions", async () => {
  await assert.rejects(
    withConcurrency("command", async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  assert.equal(await withConcurrency("command", async () => "available"), "available");
});

test("concurrency summary separates global and resource gate statistics", () => {
  const summary = concurrencySummary();

  assert.deepEqual(Object.keys(summary).sort(), ["command", "fetch", "global", "search"]);
  for (const stats of Object.values(summary)) {
    assert.equal(typeof stats.active, "number");
    assert.equal(typeof stats.queued, "number");
    assert.equal(typeof stats.limit, "number");
  }
});
