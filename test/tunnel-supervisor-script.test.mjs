import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const script = path.join(projectDir, "scripts", "tunnel-supervisor.ps1");

test("manual supervisor has bounded connector-only recovery", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /ValidateSet\("Start", "Stop", "Status"\)/);
  assert.match(source, /cloudflared_tunnel_ha_connections/);
  assert.match(source, /FailureThreshold/);
  assert.match(source, /MaxRestarts/);
  assert.match(source, /CommandLine -like/);
  assert.match(source, /stale_state/);
  assert.match(source, /Test-SupervisorAlive/);
  assert.doesNotMatch(source, /Start-Service|New-Service|sc\.exe\s+create/i);
});

test("manual supervisor does not handle secrets or broad environments", () => {
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /MCP_AUTH_TOKEN|AUTH_PIN|credentials-file/i);
  assert.doesNotMatch(source, /Get-ChildItem\s+Env:/i);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /CommandLine -like/);
});
