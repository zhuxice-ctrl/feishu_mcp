import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(
  os.tmpdir(),
  `directory-grant-singleton-${process.pid}`,
);
const { DirectoryGrantStore } = await import("../dist/security/directoryGrantStore.js");

function makeScope(dataDir, name) {
  return {
    logicalRoot: path.join(dataDir, name),
    physicalRoot: path.join(dataDir, name),
  };
}

test("effective roots combine global, owner, session and permanent sources by user", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-"));
  try {
    const store = new DirectoryGrantStore({
      dataDir,
      staticRoots: [makeScope(dataDir, "static")],
      ownerUserId: "owner",
      ownerRoots: [makeScope(dataDir, "owner")],
    });
    store.rememberSessionBatch("owner", [makeScope(dataDir, "session")]);
    store.rememberPermanentBatch("owner", [makeScope(dataDir, "permanent")]);

    assert.deepEqual(
      store.effectiveRoots("owner").map((item) => item.source),
      ["static", "owner_default", "session", "permanent"],
    );
    assert.deepEqual(
      store.effectiveRoots("other").map((item) => item.source),
      ["static"],
    );
    assert.deepEqual(
      store.effectiveRoots(null).map((item) => item.source),
      ["static"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("permanent grants reload and revoke by id without leaking across users", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-reload-"));
  try {
    const projectRoot = makeScope(dataDir, "project");
    const projectFile = path.join(projectRoot.physicalRoot, "file.txt");
    const options = {
      dataDir,
      staticRoots: [],
      ownerUserId: "owner",
      ownerRoots: [],
    };
    const store = new DirectoryGrantStore(options);
    const [record] = store.rememberPermanentBatch("owner", [projectRoot]);
    const reloaded = new DirectoryGrantStore(options);
    assert.equal(reloaded.hasAccess("owner", projectFile), true);
    assert.equal(reloaded.hasAccess("other", projectFile), false);
    assert.equal(reloaded.revoke(record.id), true);
    assert.equal(reloaded.hasAccess("owner", projectFile), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("permanent batches commit together and invalid batches preserve old JSON bytes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-atomic-"));
  try {
    const store = new DirectoryGrantStore({ dataDir });
    const [first, second] = store.rememberPermanentBatch("alice", [
      makeScope(dataDir, "one"),
      makeScope(dataDir, "two"),
    ]);
    assert.equal(store.listForUser("alice").length, 2);
    assert.ok(first.id);
    assert.ok(second.id);

    const filePath = path.join(dataDir, "directory-grants.json");
    const before = await readFile(filePath);
    assert.throws(
      () => store.rememberPermanentBatch("alice", [
        makeScope(dataDir, "three"),
        { logicalRoot: "relative", physicalRoot: path.join(dataDir, "four") },
      ]),
      /absolute/,
    );
    const after = await readFile(filePath);
    assert.deepEqual(after, before);
    assert.equal(store.listForUser("alice").length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("session batches become visible only after every root validates and do not reload", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-session-"));
  try {
    const options = { dataDir };
    const store = new DirectoryGrantStore(options);
    assert.throws(
      () => store.rememberSessionBatch("alice", [
        makeScope(dataDir, "one"),
        { logicalRoot: path.join(dataDir, "two"), physicalRoot: "relative" },
      ]),
      /absolute/,
    );
    assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
    assert.equal(store.hasAccess("alice", path.join(dataDir, "one", "file.txt")), false);

    store.rememberSessionBatch("alice", [makeScope(dataDir, "one")]);
    assert.equal(store.hasAccess("alice", path.join(dataDir, "one", "file.txt")), true);
    assert.deepEqual(new DirectoryGrantStore(options).summary(), { session: 0, permanent: 0 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicates collapse by physical root within each user and source", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-duplicates-"));
  try {
    const physicalRoot = path.join(dataDir, "physical");
    const aliases = [
      { logicalRoot: path.join(dataDir, "z-alias"), physicalRoot },
      { logicalRoot: path.join(dataDir, "a-alias"), physicalRoot },
    ];
    const store = new DirectoryGrantStore({
      dataDir,
      staticRoots: aliases,
      ownerUserId: "owner",
      ownerRoots: aliases,
    });
    store.rememberSessionBatch("owner", aliases);
    const records = store.rememberPermanentBatch("owner", aliases);

    assert.equal(records.length, 1);
    assert.deepEqual(store.summary(), { session: 1, permanent: 1 });
    assert.deepEqual(
      store.effectiveRoots("owner").map(({ source, logicalRoot }) => ({ source, logicalRoot })),
      [{ source: "static", logicalRoot: path.join(dataDir, "a-alias") }],
    );
    assert.equal(store.listForUser("other").length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed on-disk records invalidate the complete persisted grant set", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-malformed-"));
  try {
    const valid = {
      id: "valid-id",
      userId: "alice",
      logicalRoot: path.join(dataDir, "valid"),
      physicalRoot: path.join(dataDir, "valid"),
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(dataDir, "directory-grants.json"),
      JSON.stringify({ version: 1, grants: [valid, { ...valid, id: 42 }] }),
    );
    const store = new DirectoryGrantStore({ dataDir });
    assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
    assert.equal(store.hasAccess("alice", path.join(dataDir, "valid", "file.txt")), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("clear can target one user and summary exposes counts only", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-clear-"));
  try {
    const store = new DirectoryGrantStore({ dataDir });
    store.rememberSessionBatch("alice", [makeScope(dataDir, "alice-session")]);
    store.rememberSessionBatch("bob", [makeScope(dataDir, "bob-session")]);
    store.rememberPermanentBatch("alice", [makeScope(dataDir, "alice-permanent")]);
    store.rememberPermanentBatch("bob", [makeScope(dataDir, "bob-permanent")]);
    assert.deepEqual(Object.keys(store.summary()).sort(), ["permanent", "session"]);

    store.clear("alice");
    assert.deepEqual(store.summary(), { session: 1, permanent: 1 });
    assert.equal(store.listForUser("alice").length, 0);
    assert.equal(store.listForUser("bob").length, 1);
    store.clear();
    assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
