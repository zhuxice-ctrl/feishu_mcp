/**
 * Tests for immutable signed environment plans.
 *
 * A plan is a versioned, HMAC-signed body bound to an owner, a catalog
 * digest, and an environment digest. It expires after 30 minutes, can be
 * claimed exactly once, and any mutation to a component/version/source field
 * invalidates the signature. The store never accepts a plan whose body does
 * not re-verify under the shared approval secret.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_STATE_SECRET = "plan-test-secret-0123456789abcdef";
process.env.LOG_LEVEL = "error";

const { loadDevelopmentCatalog, catalogDigest } =
  await import("../dist/development/environment/catalog.js");
const { PlanPlanner, PLAN_LIFETIME_MS } =
  await import("../dist/development/environment/planner.js");
const { PlanStore } = await import("../dist/development/environment/planStore.js");

const REPO_CATALOG = path.resolve("config/development-package-catalog.json");
const dataRoot = await mkdtemp(path.join(tmpdir(), "feishu-plan-"));
test.after(async () => rm(dataRoot, { recursive: true, force: true }));

const catalog = loadDevelopmentCatalog(REPO_CATALOG);
const planner = new PlanPlanner({ catalog });
const snapshot = {
  version: 1,
  catalogDigest: catalogDigest(catalog),
  digest: "snapshot-digest-abc",
  createdAt: "2026-07-30T00:00:00.000Z",
  components: [],
};

function makePlan(overrides = {}) {
  return planner.create({
    ownerKey: "owner-key-1",
    targets: ["android"],
    requested: ["google.android.commandlinetools", "google.android.platform-tools"],
    snapshot,
    ...overrides,
  });
}

test("plan is version 1 and bound to environment + catalog digests", () => {
  const plan = makePlan();
  assert.equal(plan.version, 1);
  assert.equal(plan.environmentDigest, snapshot.digest);
  assert.equal(plan.catalogDigest, catalogDigest(catalog));
  assert.equal(plan.ownerKey, "owner-key-1");
  assert.match(plan.hmac, /^[0-9a-f]{64}$/);
  assert.equal(plan.status, "planned");
});

test("operations are dependency-ordered", () => {
  const plan = makePlan();
  const ids = plan.operations.map((op) => op.componentId);
  const cmdIdx = ids.indexOf("google.android.commandlinetools");
  const ptIdx = ids.indexOf("google.android.platform-tools");
  assert(cmdIdx !== -1 && ptIdx !== -1);
  assert.ok(cmdIdx < ptIdx, "commandlinetools must precede platform-tools");
  assert.equal(ids.length, 2);
});

test("operations carry exact catalog component/version/source", () => {
  const plan = makePlan();
  for (const op of plan.operations) {
    const comp = catalog.components.find((c) => c.id === op.componentId);
    assert(comp, `unknown component ${op.componentId}`);
    assert.deepEqual(op.install, comp.install);
    assert.deepEqual(op.versions, comp.versions);
  }
});

test("plan includes size summaries and privilege/reboot flags", () => {
  const plan = makePlan();
  assert.ok(typeof plan.estimatedDownloadBytes === "number");
  assert.ok(typeof plan.estimatedDiskBytes === "number");
  assert.ok(plan.estimatedDiskBytes >= 0);
  for (const op of plan.operations) {
    assert.ok(typeof op.privilege === "boolean");
    assert.ok(typeof op.reboot === "boolean");
  }
});

test("plan expires after 30 minutes", () => {
  const created = new Date("2026-07-30T00:00:00.000Z");
  const plan = planner.create({
    ownerKey: "owner-key-1",
    targets: ["android"],
    requested: ["google.android.platform-tools"],
    snapshot,
    clock: () => created,
  });
  assert.equal(plan.expiryAt, new Date(created.getTime() + PLAN_LIFETIME_MS).toISOString());
  assert.equal(PLAN_LIFETIME_MS, 30 * 60 * 1000);
});

test("claim is atomic and single-use", () => {
  const store = new PlanStore(path.join(dataRoot, "a"));
  const plan = makePlan();
  store.save(plan);
  const first = store.claim(plan.id, "owner-key-1", snapshot.digest);
  assert.equal(first.status, "claimed");
  const second = store.claim(plan.id, "owner-key-1", snapshot.digest);
  assert.equal(second.status, "already_used");
});

test("claim rejects a mutated component version", async () => {
  const store = new PlanStore(path.join(dataRoot, "b"));
  const plan = makePlan();
  store.save(plan);
  const file = path.join(dataRoot, "b", `${plan.id}.json`);
  const tampered = JSON.parse(await readFile(file, "utf8"));
  tampered.operations[0].versions = ["9.9.9"];
  await writeFile(file, JSON.stringify(tampered));
  const result = store.claim(plan.id, "owner-key-1", snapshot.digest);
  assert.equal(result.status, "invalid");
});

test("claim rejects a mutated install source", async () => {
  const store = new PlanStore(path.join(dataRoot, "c"));
  const plan = makePlan();
  store.save(plan);
  const file = path.join(dataRoot, "c", `${plan.id}.json`);
  const tampered = JSON.parse(await readFile(file, "utf8"));
  tampered.operations[0].install = { kind: "winget", packageId: "Evil.Package", source: "winget" };
  await writeFile(file, JSON.stringify(tampered));
  const result = store.claim(plan.id, "owner-key-1", snapshot.digest);
  assert.equal(result.status, "invalid");
});

test("claim rejects a wrong owner", () => {
  const store = new PlanStore(path.join(dataRoot, "d"));
  const plan = makePlan();
  store.save(plan);
  const result = store.claim(plan.id, "other-owner", snapshot.digest);
  assert.equal(result.status, "forbidden");
});

test("claim rejects a stale environment digest", () => {
  const store = new PlanStore(path.join(dataRoot, "e"));
  const plan = makePlan();
  store.save(plan);
  const result = store.claim(plan.id, "owner-key-1", "different-digest");
  assert.equal(result.status, "stale");
});

test("claim rejects an expired plan", () => {
  const store = new PlanStore(path.join(dataRoot, "f"), { clock: () => new Date("2026-07-30T01:00:00.000Z") });
  const plan = planner.create({
    ownerKey: "owner-key-1",
    targets: ["android"],
    requested: ["google.android.platform-tools"],
    snapshot,
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  store.save(plan);
  const result = store.claim(plan.id, "owner-key-1", snapshot.digest);
  assert.equal(result.status, "expired");
});

test("requesting an unknown component fails", () => {
  assert.throws(() =>
    planner.create({
      ownerKey: "owner-key-1",
      targets: ["android"],
      requested: ["does.not.exist"],
      snapshot,
    }),
  );
});

test("requesting a component outside the requested targets fails", () => {
  assert.throws(() =>
    planner.create({
      ownerKey: "owner-key-1",
      targets: ["android"],
      requested: ["microsoft.dotnet.sdk.8"],
      snapshot,
    }),
  );
});
