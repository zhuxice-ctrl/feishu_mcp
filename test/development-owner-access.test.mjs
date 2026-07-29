import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

const root = await mkdtemp(path.join(os.tmpdir(), "feishu-dev-owner-"));
process.env.AUTH_MODE = "none";
process.env.APPROVAL_DATA_DIR = root;
process.env.APPROVAL_STATE_SECRET = "owner-access-secret-0123456789abcdef";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { runWithRequestContext } = await import("../dist/security/requestContext.js");
const { authorizeOwnerToolCall } = await import("../dist/security/toolAccess.js");

function code(result) {
  return JSON.parse(result.content[0].text).code;
}

test.after(async () => rm(root, { recursive: true, force: true }));

test("the configured owner is authorized to call owner-only tools", async () => {
  const result = await runWithRequestContext(
    { token: "", userId: "owner", email: null },
    () => authorizeOwnerToolCall("get_development_task", {}),
  );
  assert.equal(result, null);
});

test("a different authenticated identity receives OWNER_REQUIRED", async () => {
  const result = await runWithRequestContext(
    { token: "", userId: "other", email: null },
    () => authorizeOwnerToolCall("get_development_task", {}),
  );
  assert.equal(code(result), "OWNER_REQUIRED");
});

test("missing OWNER_USER_ID returns OWNER_NOT_CONFIGURED", async () => {
  const script =
    "import('./dist/security/requestContext.js').then(async(r)=>{const a=await import('./dist/security/toolAccess.js');const out=await r.runWithRequestContext({token:'',userId:'other',email:null},()=>a.authorizeOwnerToolCall('get_development_task',{}));console.log(JSON.stringify(out));})";
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        OWNER_USER_ID: "",
        APPROVAL_DATA_DIR: root,
        AUTH_MODE: "none",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(code(JSON.parse(result.stdout)), "OWNER_NOT_CONFIGURED");
});

test("an unauthenticated caller is rejected before the owner check", async () => {
  const script =
    "import('./dist/security/requestContext.js').then(async(r)=>{const a=await import('./dist/security/toolAccess.js');const out=await r.runWithRequestContext({token:'',userId:null,email:null},()=>a.authorizeOwnerToolCall('get_development_task',{}));console.log(JSON.stringify(out));})";
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_MODE: "pin",
        AUTH_PIN: "test-pin-1234",
        APPROVAL_DATA_DIR: root,
        OWNER_USER_ID: "owner",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Authentication/i);
});

test("owner denial audit does not log the raw request identity", async () => {
  const rawIdentity = "raw-sensitive-request-identity-7f3a";
  const script =
    `import('./dist/security/requestContext.js').then(async(r)=>{const a=await import('./dist/security/toolAccess.js');await r.runWithRequestContext({token:'',userId:${JSON.stringify(rawIdentity)},email:null},()=>a.authorizeOwnerToolCall('get_development_task',{}));})`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_MODE: "none",
        APPROVAL_DATA_DIR: root,
        APPROVAL_STATE_SECRET: "owner-log-secret-0123456789abcdef",
        OWNER_USER_ID: "owner",
        LOG_LEVEL: "warn",
        LOG_FORMAT: "json",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /owner_tool_authorization_denied/);
  assert.doesNotMatch(result.stderr, new RegExp(rawIdentity));
});
