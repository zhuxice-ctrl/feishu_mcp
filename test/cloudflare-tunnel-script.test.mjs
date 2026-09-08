import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const script = path.join(projectDir, "scripts", "test-cloudflare-tunnel.ps1");
const launcher = path.join(projectDir, "scripts", "start-cf-mcp.ps1");

function run(args) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd: projectDir, encoding: "utf8" },
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("connector script never prints secrets and validates its fields", () => {
  const content = readFileSync(script, "utf8");
  assert.match(content, /ValidatePattern\('\^\[A-Za-z0-9\.\-\]\+\$'\)/);
  assert.match(content, /Get-CimInstance Win32_Process -Filter "Name = 'cloudflared\.exe'"/);
  assert.match(content, /\\brun\\s\+/);
  assert.match(content, /\[regex\]::Escape\("feishu-mcp"\)/);
  assert.match(content, /function Test-HealthJson\(\[object\]\$Health/);
  assert.match(content, /OK_CONNECTOR_CHECK/);
  // No environment expansion, no reading .env/credential/config files.
  assert.doesNotMatch(content, /\$\{env:/);
  assert.doesNotMatch(content, /Get-Content[^\r\n]*(\.env|cloudflared.*\.json|config\.yml)/i);
  // No output line may carry an auth/credential marker.
  for (const line of content.split(/\r?\n/)) {
    if (/Write-Host|Write-Error|Write-Warning/.test(line)) {
      assert.doesNotMatch(
        line,
        /Authorization|MCP_AUTH_TOKEN|credential|token/i,
        `output line may leak a secret: ${line}`,
      );
    }
  }
  assert.doesNotMatch(content, /Invoke-Command|Start-Process|Set-Content|Out-File/i);
  assert.doesNotMatch(content, /feishu-mcp-test|mcp-test|3001/);
});

test("connector script rejects a non-hostname PublicHost", () => {
  const result = run(["-PublicHost", "https://ugly.example.com/mcp"]);
  assert.notEqual(result.status, 0);
});

test("connector script reports a bounded local failure exit code", async () => {
  const port = await freePort();
  const result = run(["-PublicHost", "mcp.example.com", "-Port", String(port)]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /LOCAL_HEALTH_FAILURE/);
});

test("production launcher isolates and supervises only its own tunnel", () => {
  const content = readFileSync(launcher, "utf8");
  assert.match(content, /\"feishu-mcp\"/);
  assert.match(content, /\$MetricsPort = 20241/);
  assert.match(content, /ConsoleCancelEventHandler/);
  assert.match(content, /Stop-OwnedProcessTree/);
  assert.match(content, /\\brun\\s\+/);
  assert.match(content, /\[regex\]::Escape\(\$TunnelName\)/i);
  assert.doesNotMatch(content, /feishu-mcp-test|mcp-test|3001/);
});
