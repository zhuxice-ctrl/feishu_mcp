# Manual Cloudflare Tunnel Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a manually launched production MCP Tunnel online by detecting connector false-alive states and restarting only that connector during its active session.

**Architecture:** `cf_mcp` remains the manual entry point. It delegates connector ownership to a PowerShell supervisor that owns a LocalAppData state file and probes local, connector-metrics, and public health. The test connector remains separate.

**Tech Stack:** PowerShell 5.1, Node.js tests, cloudflared named tunnel, Clash Verge/Mihomo fake-IP DNS.

---

## Files

- Create `scripts/tunnel-supervisor.ps1`: manual production supervisor, health loop, bounded restart.
- Create `scripts/stop-cf-mcp.ps1`: explicit manual stop entry.
- Modify `scripts/start-cf-mcp.ps1`: invoke supervisor rather than detached cloudflared.
- Modify `scripts/test-cloudflare-tunnel.ps1`: validate metrics and named connector, not a service.
- Create `test/tunnel-supervisor-script.test.mjs`; modify `test/launcher.test.mjs` and `test/cloudflare-tunnel-script.test.mjs`.
- Modify `README.md`; create `docs/MANUAL_CLOUDFLARE_TUNNEL_RECOVERY.md`.

Runtime state is `%LOCALAPPDATA%\\FeishuMcp\\tunnel\\production-state.json`, never committed. The only local proxy change is to `%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\dns_config.yaml`, after a backup.

### Task 1: Add a production-only manual supervisor

**Files:** Create `test/tunnel-supervisor-script.test.mjs`; create `scripts/tunnel-supervisor.ps1`.

- [ ] **Step 1: Write the failing safety test**

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "tunnel-supervisor.ps1");
test("manual supervisor has bounded connector-only recovery", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /ValidateSet\("Start", "Stop", "Status"\)/);
  assert.match(text, /cloudflared_tunnel_ha_connections/);
  assert.match(text, /FailureThreshold/);
  assert.match(text, /MaxRestarts/);
  assert.match(text, /CommandLine -like/);
  assert.doesNotMatch(text, /Start-Service|New-Service|sc\.exe\s+create/i);
  assert.doesNotMatch(text, /MCP_AUTH_TOKEN|AUTH_PIN|credentials-file/i);
});
```

- [ ] **Step 2: Verify it fails**

Run `node --test test/tunnel-supervisor-script.test.mjs`. Expected: FAIL because the script is absent.

- [ ] **Step 3: Implement the constrained interface**

Create `scripts/tunnel-supervisor.ps1` with the following parameters:

```powershell
[CmdletBinding()]
param(
  [ValidateSet("Start", "Stop", "Status")][string]$Action = "Start",
  [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost = "mcp.zxc66.asia",
  [ValidateRange(1,65535)][int]$Port = 3000,
  [ValidateRange(1,65535)][int]$MetricsPort = 20241,
  [ValidatePattern('^[A-Za-z0-9-]+$')][string]$TunnelName = "feishu-mcp",
  [ValidateRange(5,300)][int]$IntervalSeconds = 20,
  [ValidateRange(1,10)][int]$FailureThreshold = 3,
  [ValidateRange(1,10)][int]$MaxRestarts = 4
)
```

Implement `Test-ProductionStatePath`, `Get-ProductionCloudflared`, `Test-LocalHealth`, `Test-ConnectorHealth`, `Test-PublicHealth`, `Write-SafeState`, `Start-ProductionConnector`, and `Stop-ProductionConnector`. Matching requires canonical production config path plus `run feishu-mcp`, and rejects the test tunnel. State holds only pids, timestamps, counters, and status.

`Start` polls every 20 seconds. Three consecutive connector/public failures, while local health remains valid, stop the matched connector, wait up to 15 seconds, start one replacement, then back off 5/10/20/40 seconds. Four restarts write `manual_action_required` and exit. It never restarts Node. `Stop` terminates only the recorded production connector and removes state. `Status` emits redacted JSON.

- [ ] **Step 4: Verify and commit**

Run `node --test test/tunnel-supervisor-script.test.mjs`; expect PASS. Then run:

```powershell
git add scripts/tunnel-supervisor.ps1 test/tunnel-supervisor-script.test.mjs
git commit -m "feat: add manual tunnel recovery supervisor"
```

### Task 2: Preserve `cf_mcp` as the manual lifecycle entry point

**Files:** Modify `scripts/start-cf-mcp.ps1`, create `scripts/stop-cf-mcp.ps1`, modify `test/launcher.test.mjs`.

- [ ] **Step 1: Add failing launcher assertions**

Add tests that require `start-cf-mcp.ps1` to mention `tunnel-supervisor.ps1` and `-Action", "Start"`; reject `New-Service`, `cloudflared service install`, and direct `run", "feishu-mcp"`. Add tests that `stop-cf-mcp.ps1` delegates `-Action Stop` and rejects `Stop-Process -Name cloudflared`.

- [ ] **Step 2: Confirm they fail**

Run `node --test test/launcher.test.mjs`. Expected: FAIL because the old launcher owns cloudflared directly.

- [ ] **Step 3: Implement launch and stop delegation**

Preserve all existing local MCP validation in `scripts/start-cf-mcp.ps1`, but replace direct tunnel launch with:

```powershell
$supervisor = Join-Path $projectDir "scripts\tunnel-supervisor.ps1"
Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $supervisor,
  "-Action", "Start", "-PublicHost", $PublicHost, "-Port", $Port,
  "-MetricsPort", "20241", "-TunnelName", "feishu-mcp"
) -WorkingDirectory $projectDir
```

Update its stale expected tool count from `40` to `-ge 41`. Do not install, start, stop, or inspect a cloudflared service. Make `stop-cf-mcp.ps1` a thin call to the supervisor with `-Action Stop`.

- [ ] **Step 4: Verify and commit**

Run `node --test test/launcher.test.mjs test/tunnel-supervisor-script.test.mjs`; expect PASS. Then run:

```powershell
git add scripts/start-cf-mcp.ps1 scripts/stop-cf-mcp.ps1 test/launcher.test.mjs
git commit -m "feat: supervise manual cloudflare tunnel sessions"
```

### Task 3: Update diagnostics for manual ownership

**Files:** Modify `scripts/test-cloudflare-tunnel.ps1` and `test/cloudflare-tunnel-script.test.mjs`.

- [ ] **Step 1: Write failing diagnostic assertions**

Replace the old service assertion with checks for `cloudflared_tunnel_ha_connections`, `cloudflared tunnel info`, and `CONNECTOR_HEALTHY`; reject `Get-Service`, `Start-Process`, `Stop-Process`, `Start-Service`, and `Stop-Service`. Add a test that an unused metrics port returns a distinct non-zero connector exit code.

- [ ] **Step 2: Confirm failure**

Run `node --test test/cloudflare-tunnel-script.test.mjs`. Expected: FAIL because the old script requires a service.

- [ ] **Step 3: Implement read-only connector health**

Add `MetricsPort = 20241` and `TunnelName = "feishu-mcp"`. After local and public validation, GET only `http://127.0.0.1:$MetricsPort/metrics`, parse `cloudflared_tunnel_ha_connections`, fail below one, and invoke `cloudflared tunnel info $TunnelName`. Emit only `LOCAL_HEALTHY`, `PUBLIC_HEALTHY`, `CONNECTOR_HEALTHY`, and `OK_CONNECTOR_CHECK`.

- [ ] **Step 4: Verify and commit**

Run `node --test test/cloudflare-tunnel-script.test.mjs`; expect PASS. Then run:

```powershell
git add scripts/test-cloudflare-tunnel.ps1 test/cloudflare-tunnel-script.test.mjs
git commit -m "fix: verify manual tunnel connector health"
```

### Task 4: Exclude Cloudflare Tunnel names from Mihomo fake-IP

**Files:** Create `docs/MANUAL_CLOUDFLARE_TUNNEL_RECOVERY.md`; modify local `dns_config.yaml` outside Git.

- [ ] **Step 1: Back up the active DNS override**

```powershell
$root = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$source = Join-Path $root 'dns_config.yaml'
$backup = Join-Path $root ('dns_config.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.yaml')
Copy-Item -LiteralPath $source -Destination $backup -ErrorAction Stop
```

Expected: a timestamped backup beside the active override; no profile subscription or proxy group changes.

- [ ] **Step 2: Add exactly two exclusions**

Under `dns.fake-ip-filter`, add:

```yaml
  - '+.argotunnel.com'
  - '+.cfargotunnel.com'
```

Reload Clash Verge normally. Verify `region1.v2.argotunnel.com` resolves outside `198.18.0.0/16`; restore the timestamped backup if it does not.

- [ ] **Step 3: Document and commit only documentation**

Document start/stop/status, labels, state location, rollback, the two exclusions, and the no-autostart guarantee. Do not document credential content. Then run:

```powershell
git add docs/MANUAL_CLOUDFLARE_TUNNEL_RECOVERY.md
git commit -m "docs: describe manual tunnel recovery operations"
```

### Task 5: Upgrade and activate

**Files:** No repository source changes.

- [ ] **Step 1: Upgrade connector software**

Run `winget upgrade --id Cloudflare.cloudflared --exact`. Expected: a current stable cloudflared version without displaying credentials.

- [ ] **Step 2: Start a clean manual session**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-cf-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cf-mcp.ps1
```

Expected: only the production connector/supervisor changes; Node port 3000 stays available; no service is installed.

- [ ] **Step 3: Validate three layers**

```powershell
.\scripts\test-cloudflare-tunnel.ps1 -PublicHost mcp.zxc66.asia -Port 3000 -MetricsPort 20241 -TunnelName feishu-mcp
cloudflared tunnel info feishu-mcp
Invoke-RestMethod https://mcp.zxc66.asia/health | Select-Object status,toolCount
```

Expected: `OK_CONNECTOR_CHECK`, at least one active connector, `status = ok`, and `toolCount = 42`.

### Task 6: Regression and controlled recovery proof

**Files:** Modify only files above if tests expose defects.

- [ ] **Step 1: Run regression**

```powershell
npm run build
node --test test/tunnel-supervisor-script.test.mjs test/cloudflare-tunnel-script.test.mjs test/launcher.test.mjs test/test-mcp-isolation.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Prove connector-only recovery**

Use the validated runtime state to stop only the production cloudflared pid. Do not stop Node. Within 90 seconds the supervisor must launch one replacement, public health must return, and the PID listening on 3000 must not change.

- [ ] **Step 3: Prove no auto-start registration**

```powershell
Get-Service -Name cloudflared -ErrorAction SilentlyContinue
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'cloudflared|feishu-mcp' }
```

Expected: this work created no cloudflared service and no scheduled task.

- [ ] **Step 4: Commit only repair files**

```powershell
git status --short
git add scripts test README.md docs/MANUAL_CLOUDFLARE_TUNNEL_RECOVERY.md
git commit -m "test: verify manual tunnel recovery"
```

Never stage the existing Android modifications, `.commit_msg.txt`, or unrelated documents.

## Plan self-review

- Tasks 1–2 cover manual bounded recovery; Task 3 adds observable health; Task 4 corrects fake-IP routing; Task 5 activates the repaired channel; Task 6 proves recovery and no auto-start side effect.
- No placeholders remain.
- All production entries use `mcp.zxc66.asia`, `3000`, `20241`, and `feishu-mcp`; test names are rejected by the production matcher.
