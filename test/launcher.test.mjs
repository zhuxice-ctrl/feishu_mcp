import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const powershell = "powershell.exe";
const launcherScript = path.join(projectDir, "scripts", "start-feishu-mcp.ps1");

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-launcher-"));
  const envFile = path.join(root, ".env");
  const fakeNgrok = path.join(root, "ngrok.exe");
  const values = {
    PORT: "3000",
    HOST: "127.0.0.1",
    ALLOWED_DIRS: "",
    OWNER_USER_ID: "owner",
    OWNER_DEFAULT_DIRS: path.join(root, "owner-default-directory"),
    MCP_AUTH_TOKEN: "transport-secret-value",
    AUTH_MODE: "pin",
    AUTH_PIN: "pin-secret-value",
    APPROVAL_STATE_SECRET: "approval-secret-value",
    APPROVAL_DATA_DIR: path.join(root, "approval-data"),
    MAX_CONCURRENT_TOOLS: "6",
    MAX_CONCURRENT_COMMANDS: "2",
    MAX_CONCURRENT_SEARCHES: "3",
    MAX_CONCURRENT_FETCHES: "4",
    NGROK_DOMAIN: "reptilian-prenatal-spinster.ngrok-free.dev",
    ...overrides,
  };
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    "utf8"
  );
  await writeFile(fakeNgrok, "", "utf8");
  return { root, envFile, fakeNgrok };
}

function checkOnly(envFile, fakeNgrok) {
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherScript,
      "-CheckOnly",
      "-EnvFile",
      envFile,
      "-NgrokPath",
      fakeNgrok,
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        NGROK_DOMAIN: "",
        AUTH_PIN: "",
        MCP_AUTH_TOKEN: "",
      },
      encoding: "utf8",
    }
  );
}

test(
  "launcher check mode resolves safe configuration without leaking secrets",
  { skip: process.platform !== "win32" },
  async () => {
    const item = await fixture();
    try {
      const result = checkOnly(item.envFile, item.fakeNgrok);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /transport-secret-value|pin-secret-value|approval-secret-value/
      );
      const output = JSON.parse(result.stdout);
      assert.deepEqual(
        {
          status: output.status,
          port: output.port,
          host: output.host,
          authMode: output.authMode,
          domain: output.ngrokDomain,
          toolCount: output.toolCount,
          concurrency: output.concurrency,
          permanentApprovalCount: output.permanentApprovalCount,
          ownerDefaultCount: output.ownerDefaultCount,
          permanentDirectoryGrantCount: output.permanentDirectoryGrantCount,
        },
        {
          status: "ready",
          port: 3000,
          host: "127.0.0.1",
          authMode: "pin",
          domain: "reptilian-prenatal-spinster.ngrok-free.dev",
          toolCount: 21,
          concurrency: { search: 3, fetch: 4, global: 6, command: 2 },
          permanentApprovalCount: 0,
          ownerDefaultCount: 1,
          permanentDirectoryGrantCount: 0,
        }
      );
      assert.doesNotMatch(result.stdout + result.stderr, /(?:^|[^A-Za-z])owner(?:$|[^A-Za-z])/);
      assert.equal((result.stdout + result.stderr).includes(path.join(item.root, "owner-default-directory")), false);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
);

test(
  "launcher requires an owner identity when owner defaults are configured",
  { skip: process.platform !== "win32" },
  async () => {
    const item = await fixture({ OWNER_USER_ID: "" });
    try {
      const result = checkOnly(item.envFile, item.fakeNgrok);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /OWNER_USER_ID.*required/i);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
);

test(
  "launcher requires either static or owner default directories",
  { skip: process.platform !== "win32" },
  async () => {
    const item = await fixture({ ALLOWED_DIRS: "", OWNER_DEFAULT_DIRS: "" });
    try {
      const result = checkOnly(item.envFile, item.fakeNgrok);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ALLOWED_DIRS or OWNER_DEFAULT_DIRS/i);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
);

test(
  "launcher rejects a missing fixed domain without leaking secrets",
  { skip: process.platform !== "win32" },
  async () => {
    const item = await fixture({ NGROK_DOMAIN: "" });
    try {
      const result = checkOnly(item.envFile, item.fakeNgrok);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /NGROK_DOMAIN/);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /transport-secret-value|pin-secret-value|approval-secret-value/
      );
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
);

test(
  "launcher rejects out-of-range concurrency limits without leaking secrets",
  { skip: process.platform !== "win32" },
  async () => {
    const item = await fixture({ MAX_CONCURRENT_TOOLS: "65" });
    try {
      const result = checkOnly(item.envFile, item.fakeNgrok);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /MAX_CONCURRENT_TOOLS.*1 and 64/i);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /transport-secret-value|pin-secret-value|approval-secret-value/
      );
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
);

test(
  "BAT entrypoint delegates to the PowerShell orchestrator",
  { skip: process.platform !== "win32" },
  async () => {
    const content = await readFile(
      path.join(projectDir, "start-feishu-mcp.bat"),
      "utf8"
    );
    assert.match(content, /scripts\\start-feishu-mcp\.ps1/i);
    assert.match(content, /ExecutionPolicy\s+Bypass/i);
    assert.doesNotMatch(content, /MCP_AUTH_TOKEN|AUTH_PIN/);
  }
);

test(
  "PowerShell launcher waits for the configured ngrok 3 endpoint URL",
  { skip: process.platform !== "win32" },
  async () => {
    const content = await readFile(launcherScript, "utf8");
    assert.match(content, /function\s+Wait-NgrokTunnel/i);
    assert.match(content, /--url=https:\/\/\$domain/);
    assert.doesNotMatch(content, /--domain=\$domain/);
    assert.match(content, /ngrok-skip-browser-warning/);
    assert.match(content, /\[Console\]::KeyAvailable/);
    assert.match(content, /Press Q or Enter to stop/);
  }
);
