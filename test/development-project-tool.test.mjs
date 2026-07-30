import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-proj-tool-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = path.join(root, "approvals");
process.env.APPROVAL_STATE_SECRET = "dev-proj-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const {
  manageDevelopmentProject,
  manageDevelopmentProjectInputSchema,
} = await import("../dist/tools/developmentProjects.js");
const { ProjectRegistry } = await import("../dist/development/projects/registry.js");
const { approvalStateCodec } = await import("../dist/security/approvalState.js");

test.after(async () => rm(root, { recursive: true, force: true }));

// ----------------------------------------------------------- test harness ---

function makeFakeProvider(eco) {
  const created = [];
  return {
    ecosystem: eco,
    templates() {
      return [
        { id: `${eco}-basic`, displayName: `${eco} Basic`, description: `A basic ${eco} template` },
        { id: `${eco}-full`, displayName: `${eco} Full`, description: `A full ${eco} template` },
      ];
    },
    async inspect(r) {
      return { ecosystem: eco, root: r, gradleFiles: [] };
    },
    async create(request, stagingRoot) {
      created.push(request);
      mkdirSync(request.destination, { recursive: true });
      writeFileSync(path.join(request.destination, "test.txt"), "hello");
      return { root: request.destination, files: ["test.txt"] };
    },
    created,
  };
}

function makeDeps(overrides = {}) {
  const registry = new ProjectRegistry();
  const android = makeFakeProvider("android");
  registry.register(android);
  const dotnet = makeFakeProvider("dotnet");
  registry.register(dotnet);
  return {
    deps: {
      registry,
      userId: () => "owner",
      hasDirectoryAccess: () => true,
      ...overrides,
    },
    registry,
    android,
    dotnet,
  };
}

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

async function approveOnce(args, deps, ctx, decision = "allow_once") {
  const first = await manageDevelopmentProject(args, deps, ctx);
  if (!("resultType" in first)) return first;
  assert.equal(first.resultType, "input_required", `${JSON.stringify(args)} must elicit approval`);
  const verified = await approvalStateCodec.verify(first.requestState, context());
  return manageDevelopmentProject(args, deps, context({ state: verified, decision }));
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

const ANDROID_PROFILE = {
  compileSdk: 34, minSdk: 24, targetSdk: 34,
  agp: "8.2.0", kotlin: "1.9.20", gradle: "8.2",
};

// ----------------------------------------------------------- schema tests ---

test("schema rejects unknown fields on list_templates", () => {
  assert.throws(() =>
    manageDevelopmentProjectInputSchema.parse({ action: "list_templates", ecosystem: "android", templatePath: "/evil" }),
  );
});

test("schema rejects unknown action", () => {
  assert.throws(() =>
    manageDevelopmentProjectInputSchema.parse({ action: "delete", ecosystem: "android" }),
  );
});

test("schema rejects url / executable fields on create", () => {
  assert.throws(() =>
    manageDevelopmentProjectInputSchema.parse({
      action: "create", ecosystem: "android", templateId: "t", projectName: "P",
      packageId: "com.x", destination: "/d", profile: ANDROID_PROFILE, url: "https://evil",
    }),
  );
});

test("schema accepts valid list_templates and inspect", () => {
  assert.doesNotThrow(() =>
    manageDevelopmentProjectInputSchema.parse({ action: "list_templates", ecosystem: "android" }),
  );
  assert.doesNotThrow(() =>
    manageDevelopmentProjectInputSchema.parse({ action: "inspect", ecosystem: "dotnet", root: "/proj" }),
  );
});

// ----------------------------------------------------- synchronous tests ---

test("list_templates returns templates for ecosystem", async () => {
  const { deps } = makeDeps();
  const body = parse(await manageDevelopmentProject({ action: "list_templates", ecosystem: "android" }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.ecosystem, "android");
  assert.equal(body.templates.length, 2);
});

test("list_templates rejects unknown ecosystem", async () => {
  const { deps } = makeDeps();
  const body = parse(await manageDevelopmentProject({ action: "list_templates", ecosystem: "electron" }, deps, context()));
  assert.equal(body.ok, false);
  assert.equal(body.code, "DEVELOPMENT_PROJECT_UNKNOWN");
});

test("inspect returns project inspection", async () => {
  const { deps } = makeDeps();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proj-inspect-"));
  const body = parse(await manageDevelopmentProject({ action: "inspect", ecosystem: "android", root: tmpDir }, deps, context()));
  assert.equal(body.ok, true);
  assert.equal(body.ecosystem, "android");
  assert.equal(body.root, tmpDir);
  await rm(tmpDir, { recursive: true, force: true });
});

test("inspect rejects path outside allowed dirs", async () => {
  const { deps } = makeDeps({ hasDirectoryAccess: () => false });
  const body = parse(await manageDevelopmentProject({ action: "inspect", ecosystem: "android", root: "/nonexistent/path" }, deps, context()));
  assert.equal(body.ok, false);
  assert.equal(body.code, "OUTSIDE_ALLOWED_DIRS");
});

// ----------------------------------------------------- owner-only tests ---

test("requires authenticated owner", async () => {
  const { deps } = makeDeps({ userId: () => null });
  const body = parse(await manageDevelopmentProject({ action: "list_templates", ecosystem: "android" }, deps, context()));
  assert.equal(body.ok, false);
  assert.equal(body.code, "AUTHENTICATION_REQUIRED");
});

// ----------------------------------------------------- create tests ---

test("create rejects nonempty destination", async () => {
  const { deps } = makeDeps();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proj-create-"));
  await writeFile(path.join(tmpDir, "existing.txt"), "data");
  const body = parse(await manageDevelopmentProject({
    action: "create", ecosystem: "android", templateId: "android-basic",
    projectName: "TestApp", packageId: "com.test.app", destination: tmpDir, profile: ANDROID_PROFILE,
  }, deps, context()));
  assert.equal(body.ok, false);
  assert.equal(body.code, "DEVELOPMENT_DESTINATION_DENIED");
  await rm(tmpDir, { recursive: true, force: true });
});

test("create rejects destination parent outside allowed dirs", async () => {
  const { deps } = makeDeps({ hasDirectoryAccess: () => false });
  const body = parse(await manageDevelopmentProject({
    action: "create", ecosystem: "android", templateId: "android-basic",
    projectName: "TestApp", packageId: "com.test.app", destination: "/nonexistent/path/project", profile: ANDROID_PROFILE,
  }, deps, context()));
  assert.equal(body.ok, false);
  assert.equal(body.code, "DEVELOPMENT_DESTINATION_DENIED");
});

test("create elicits single-use approval on first call", async () => {
  const { deps } = makeDeps();
  const tmpParent = await mkdtemp(path.join(os.tmpdir(), "proj-approve-"));
  const dest = path.join(tmpParent, "newproject");
  const result = await manageDevelopmentProject({
    action: "create", ecosystem: "android", templateId: "android-basic",
    projectName: "TestApp", packageId: "com.test.app", destination: dest, profile: ANDROID_PROFILE,
  }, deps, context());
  assert.equal(result.resultType, "input_required");
  await rm(tmpParent, { recursive: true, force: true });
});

test("create succeeds with approved state", async () => {
  const { deps, android } = makeDeps();
  const tmpParent = await mkdtemp(path.join(os.tmpdir(), "proj-ok-"));
  const dest = path.join(tmpParent, "newproject");
  const result = await approveOnce({
    action: "create", ecosystem: "android", templateId: "android-basic",
    projectName: "TestApp", packageId: "com.test.app", destination: dest, profile: ANDROID_PROFILE,
  }, deps, context(), "allow_once");
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(body.ecosystem, "android");
  assert.equal(body.root, dest);
  assert.ok(body.fileCount > 0);
  assert.equal(android.created.length, 1);
  await rm(tmpParent, { recursive: true, force: true });
});

test("create staging rollback on failure", async () => {
  const registry = new ProjectRegistry();
  const failingProvider = {
    ecosystem: "android",
    templates: () => [{ id: "bad", displayName: "Bad", description: "Fails" }],
    inspect: async (r) => ({ ecosystem: "android", root: r, gradleFiles: [] }),
    async create(_req, stagingRoot) {
      const stagingDir = path.join(stagingRoot, "staging-fail");
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(path.join(stagingDir, "partial.txt"), "partial");
      throw new Error("intentional failure");
    },
  };
  registry.register(failingProvider);
  const deps = { registry, userId: () => "owner", hasDirectoryAccess: () => true };
  const tmpParent = await mkdtemp(path.join(os.tmpdir(), "proj-rollback-"));
  const dest = path.join(tmpParent, "failproject");
  const result = await approveOnce({
    action: "create", ecosystem: "android", templateId: "bad",
    projectName: "FailApp", packageId: "com.fail.app", destination: dest, profile: ANDROID_PROFILE,
  }, deps, context(), "allow_once");
  const body = parse(result);
  assert.equal(body.ok, false);
  assert.equal(body.code, "DEVELOPMENT_CREATE_FAILED");
  assert.ok(!existsSync(dest), "destination should not exist after failure");
  await rm(tmpParent, { recursive: true, force: true });
});

test("template listing carries no secrets", async () => {
  const { deps } = makeDeps();
  const body = parse(await manageDevelopmentProject({ action: "list_templates", ecosystem: "dotnet" }, deps, context()));
  assert.equal(body.ok, true);
  const jsonStr = JSON.stringify(body);
  assert.ok(!jsonStr.includes("password"), "no password in response");
  assert.ok(!jsonStr.includes("secret"), "no secret in response");
  assert.ok(!jsonStr.includes("credential"), "no credential in response");
});
