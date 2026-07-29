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
    " allowedDirs: c.ALLOWED_DIRS",
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
  });

  const missingIdentity = readConfig({ OWNER_DEFAULT_DIRS: "F:\\" });
  assert.notEqual(missingIdentity.status, 0);
  assert.match(missingIdentity.stderr, /OWNER_USER_ID.*required/i);
});

test("path lists trim, resolve and deduplicate case-insensitively on Windows", () => {
  const result = readConfig({
    OWNER_USER_ID: "owner",
    OWNER_DEFAULT_DIRS: process.platform === "win32" ? "F:\\,f:\\" : "/tmp,/tmp",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ownerDefaultDirs.length, 1);
});
