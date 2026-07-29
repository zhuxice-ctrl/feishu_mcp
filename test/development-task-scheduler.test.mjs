import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.LOG_LEVEL = "error";

const {
  DevelopmentTaskScheduler,
  DevelopmentTaskCancelledError,
  DevelopmentTaskQueueTimeoutError,
} = await import("../dist/development/tasks/scheduler.js");

const tick = () => new Promise((r) => setImmediate(r));

function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("global limit and build limit are enforced with FIFO ordering", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const g1 = gate();
  const g2 = gate();
  const first = scheduler.run("a", "build", ["project:x"], () => g1.promise.then(() => "first"));
  const second = scheduler.run("b", "build", ["project:y"], () => g2.promise.then(() => "second"));
  await tick();
  assert.deepEqual(scheduler.summary(), { active: 2, queued: 0, totalLimit: 4, buildLimit: 2 });
  // third build exceeds build limit 2 -> queued
  const third = scheduler.run("c", "build", ["project:z"], async () => "third");
  await tick();
  assert.deepEqual(scheduler.summary(), { active: 2, queued: 1, totalLimit: 4, buildLimit: 2 });
  g1.resolve();
  // one slot freed -> third starts immediately
  assert.equal(await third, "third");
  g2.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("same-project tasks serialize", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const order = [];
  const g = gate();
  const first = scheduler.run("a", "build", ["project:x"], async () => {
    await g.promise;
    order.push("first");
    return "first";
  });
  const second = scheduler.run("b", "build", ["project:x"], async () => {
    order.push("second");
    return "second";
  });
  await tick();
  assert.equal(scheduler.summary().active, 1);
  assert.equal(scheduler.summary().queued, 1);
  g.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first", "second"]);
});

test("different resources run in parallel", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const g1 = gate();
  const g2 = gate();
  const first = scheduler.run("a", "build", ["project:x"], () => g1.promise.then(() => "first"));
  const second = scheduler.run("b", "build", ["project:y"], () => g2.promise.then(() => "second"));
  await tick();
  assert.equal(scheduler.summary().active, 2);
  assert.equal(scheduler.summary().queued, 0);
  g1.resolve();
  g2.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("privileged tasks are serialized", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const g = gate();
  const first = scheduler.run("a", "privileged", ["env:windows"], () => g.promise.then(() => "first"));
  const second = scheduler.run("b", "privileged", ["env:windows"], async () => "second");
  await tick();
  assert.equal(scheduler.summary().active, 1);
  assert.equal(scheduler.summary().queued, 1);
  g.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("queued cancellation rejects the waiter and frees the slot", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const g = gate();
  const first = scheduler.run("a", "build", ["project:x"], () => g.promise.then(() => "first"));
  const second = scheduler.run("b", "build", ["project:x"], async () => "second");
  await tick();
  assert.equal(scheduler.cancel("b"), true);
  await assert.rejects(() => second, DevelopmentTaskCancelledError);
  assert.equal(scheduler.summary().queued, 0);
  g.resolve();
  assert.equal(await first, "first");
});

test("queue timeout rejects the waiter", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 1, builds: 1, queueTimeoutMs: 20 });
  const g = gate();
  const first = scheduler.run("a", "build", ["project:x"], () => g.promise.then(() => "first"));
  const second = scheduler.run("b", "build", ["project:x"], async () => "second");
  await assert.rejects(() => second, DevelopmentTaskQueueTimeoutError);
  g.resolve();
  await first;
});

test("locks are released after a rejected task", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  const g = gate();
  const first = scheduler.run("a", "build", ["project:x"], async () => {
    await g.promise;
    throw new Error("boom");
  });
  const second = scheduler.run("b", "build", ["project:x"], async () => "second");
  await tick();
  g.resolve();
  await assert.rejects(() => first, /boom/);
  assert.equal(await second, "second");
  assert.equal(scheduler.summary().active, 0);
});

test("adopted work restores capacity and resource locks until it settles", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 2, builds: 1, queueTimeoutMs: 1000 });
  const adoptedGate = gate();
  const adopted = scheduler.adopt(
    "recovered",
    "build",
    ["project:x", "device:emulator-1"],
    () => adoptedGate.promise,
  );
  assert.equal(adopted, true);
  assert.deepEqual(scheduler.summary(), { active: 1, queued: 0, totalLimit: 2, buildLimit: 1 });

  const conflicting = scheduler.run("next", "build", ["project:x"], async () => "next");
  await tick();
  assert.equal(scheduler.summary().queued, 1, "adopted build and project lock must block new work");

  adoptedGate.resolve();
  assert.equal(await conflicting, "next");
  assert.equal(scheduler.summary().active, 0);
});

test("adoption restores privileged occupancy and rejects duplicate task ids", async () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, privileged: 1, queueTimeoutMs: 1000 });
  const adoptedGate = gate();
  assert.equal(scheduler.adopt("recovered", "privileged", ["environment:windows"], () => adoptedGate.promise), true);
  assert.equal(scheduler.adopt("recovered", "privileged", [], async () => {}), false);

  const next = scheduler.run("next", "privileged", ["environment:other"], async () => "next");
  await tick();
  assert.equal(scheduler.summary().queued, 1, "privileged limit must survive recovery");
  adoptedGate.resolve();
  assert.equal(await next, "next");
});

test("summary never exposes task ids or resources", () => {
  const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 1000 });
  scheduler.run("secret-task", "build", ["project:secret"], () => gate().promise);
  const json = JSON.stringify(scheduler.summary());
  assert.doesNotMatch(json, /secret-task|secret/i);
});
