import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const testLauncher = path.join(projectDir, "scripts", "start-test-mcp.ps1");
const tunnelLauncher = path.join(projectDir, "scripts", "start-test-cloudflared.ps1");

function check(script, args) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-CheckOnly", ...args], {
    cwd: projectDir, encoding: "utf8", env: { ...process.env, MCP_AUTH_TOKEN: "", APPROVAL_DATA_DIR: "", PORT: "", PUBLIC_HOST: "" },
  });
}

async function testEnv(root, overrides = {}) {
  const data = path.join(root, "test-data");
  const file = path.join(root, ".env.test");
  const values = {
    PORT: "3001", HOST: "127.0.0.1", PUBLIC_HOST: "mcp-test.zxc66.asia", MCP_ENDPOINT: "/mcp",
    MCP_AUTH_TOKEN: "test-token-only", AUTH_MODE: "none", TEST_DATA_ROOT: data,
    APPROVAL_DATA_DIR: path.join(data, "approval-data"), DEV_TASK_DATA_DIR: path.join(data, "approval-data", "tasks"),
    LOCAL_WORKSPACE_CATALOG_PATH: path.join(data, "approval-data", "local-workspaces.json"), LOG_DIR: path.join(data, "logs"), ...overrides,
  };
  await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), "utf8");
  return file;
}

test("test MCP launcher accepts only the isolated 3001 configuration", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-test-isolation-"));
  try {
    const file = await testEnv(root);
    const accepted = check(testLauncher, ["-EnvFile", file]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /test-ready/);
    for (const overrides of [{ PORT: "3000" }, { PUBLIC_HOST: "mcp.zxc66.asia" }, { APPROVAL_DATA_DIR: path.join(root, "outside") }]) {
      const rejected = check(testLauncher, ["-EnvFile", await testEnv(root, overrides)]);
      assert.notEqual(rejected.status, 0, rejected.stderr);
    }
    const productionNamed = path.join(root, ".env");
    await writeFile(productionNamed, "PORT=3001\n", "utf8");
    assert.notEqual(check(testLauncher, ["-EnvFile", productionNamed]).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("test Cloudflare launcher rejects production ingress and only accepts test ingress", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-test-tunnel-"));
  try {
    const config = path.join(root, "test-config.yml");
    await writeFile(config, "tunnel: feishu-mcp-test\ncredentials-file: C:\\test\\credentials-test.json\ningress:\n  - hostname: mcp-test.zxc66.asia\n    service: http://127.0.0.1:3001\n", "utf8");
    assert.equal(check(tunnelLauncher, ["-ConfigPath", config, "-TunnelName", "feishu-mcp-test"]).status, 0);
    await writeFile(config, "tunnel: feishu-mcp\ningress:\n  - hostname: mcp.zxc66.asia\n    service: http://127.0.0.1:3000\n", "utf8");
    assert.notEqual(check(tunnelLauncher, ["-ConfigPath", config, "-TunnelName", "feishu-mcp-test"]).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
