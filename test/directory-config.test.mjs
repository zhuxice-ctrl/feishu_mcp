import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function readConfig(overrides) {
  const source = [
    "const c = await import('./dist/config.js');",
    "process.stdout.write(JSON.stringify({",
    " ownerUserId: c.OWNER_USER_ID,",
    " ownerDefaultDirs: c.OWNER_DEFAULT_DIRS,",
    " allowedDirs: c.ALLOWED_DIRS,",
    " directoryApprovalFallback: c.DIRECTORY_APPROVAL_FALLBACK,",
    " gitCommandPolicy: c.GIT_COMMAND_POLICY",
    "}));",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: projectDir,
    env: {
      ...process.env,
      AUTH_MODE: "none",
      AUTH_PIN: "",
      ALLOWED_DIRS: "",
      OWNER_USER_ID: "",
      OWNER_DEFAULT_DIRS: "",
      DIRECTORY_APPROVAL_FALLBACK: "",
      ...overrides,
    },
    encoding: "utf8",
  });
}

test("owner defaults are empty unless both settings are configured", () => {
  const empty = readConfig({});
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), {
    ownerUserId: "",
    ownerDefaultDirs: [],
    allowedDirs: [],
    directoryApprovalFallback: "deny",
    gitCommandPolicy: "approval",
  });

  const missingIdentity = readConfig({ OWNER_DEFAULT_DIRS: "F:\\" });
  assert.notEqual(missingIdentity.status, 0);
  assert.match(missingIdentity.stderr, /OWNER_USER_ID.*required/i);
});

test("Git command policy defaults to approval and permits only supported values", () => {
  const softOwner = readConfig({ OWNER_USER_ID: "owner", GIT_COMMAND_POLICY: "soft_owner" });
  assert.equal(softOwner.status, 0, softOwner.stderr);
  assert.equal(JSON.parse(softOwner.stdout).gitCommandPolicy, "soft_owner");

  const invalid = readConfig({ GIT_COMMAND_POLICY: "invalid" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /GIT_COMMAND_POLICY.*approval.*soft_owner/i);
});

test("legacy directory fallback defaults to deny and owner mode requires an owner", () => {
  const defaults = readConfig({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).directoryApprovalFallback, "deny");

  const missingOwner = readConfig({ DIRECTORY_APPROVAL_FALLBACK: "owner" });
  assert.notEqual(missingOwner.status, 0);
  assert.match(missingOwner.stderr, /OWNER_USER_ID.*required.*fallback/i);

  const owner = readConfig({
    OWNER_USER_ID: "owner",
    DIRECTORY_APPROVAL_FALLBACK: "owner",
  });
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(JSON.parse(owner.stdout).directoryApprovalFallback, "owner");
});

test("path lists trim, resolve and deduplicate case-insensitively on Windows", () => {
  const result = readConfig({
    OWNER_USER_ID: "owner",
    OWNER_DEFAULT_DIRS: process.platform === "win32" ? "F:\\,f:\\" : "/tmp,/tmp",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ownerDefaultDirs.length, 1);
});
