import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const launcherScript = path.join(projectDir, "scripts", "start-feishu-mcp.ps1");

function checkOnly(envFile) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherScript,
      "-CheckOnly",
      "-EnvFile",
      envFile,
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        PUBLIC_HOST: "",
        NGROK_DOMAIN: "",
        AUTH_PIN: "",
        MCP_AUTH_TOKEN: "",
      },
      encoding: "utf8",
    }
  );
}

test(
  "CheckOnly accepts a tunnel-free .env with PUBLIC_HOST and no ngrok keys",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "feishu-startup-launcher-"));
    const envFile = path.join(root, ".env");
    await writeFile(
      envFile,
      [
        "PORT=3000",
        "HOST=127.0.0.1",
        "PUBLIC_HOST=mcp.example.com",
        "ALLOWED_DIRS=",
        "OWNER_USER_ID=startup-owner",
        "OWNER_DEFAULT_DIRS=" + path.join(root, "owner-default"),
        "DIRECTORY_APPROVAL_FALLBACK=owner",
        "MCP_AUTH_TOKEN=transport-secret",
        "AUTH_MODE=pin",
        "AUTH_PIN=pin-secret-value",
        "APPROVAL_STATE_SECRET=approval-secret",
        "APPROVAL_DATA_DIR=" + path.join(root, "approval-data"),
      ].join("\n"),
      "utf8"
    );
    try {
      const result = checkOnly(envFile);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "ready");
      assert.equal(output.publicHost, "mcp.example.com");
      assert.equal(output.toolCount, 39);
      // No ngrok engine requirement anywhere.
      assert.doesNotMatch(result.stdout + result.stderr, /ngrok/i);
      assert.doesNotMatch(result.stdout + result.stderr, /NGROK_AUTHTOKEN/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
