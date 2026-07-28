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
    ALLOWED_DIRS: root,
    MCP_AUTH_TOKEN: "transport-secret-value",
    AUTH_MODE: "pin",
    AUTH_PIN: "pin-secret-value",
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
        /transport-secret-value|pin-secret-value/
      );
      const output = JSON.parse(result.stdout);
      assert.deepEqual(
        {
          status: output.status,
          port: output.port,
          host: output.host,
          authMode: output.authMode,
          domain: output.ngrokDomain,
        },
        {
          status: "ready",
          port: 3000,
          host: "127.0.0.1",
          authMode: "pin",
          domain: "reptilian-prenatal-spinster.ngrok-free.dev",
        }
      );
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
        /transport-secret-value|pin-secret-value/
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
