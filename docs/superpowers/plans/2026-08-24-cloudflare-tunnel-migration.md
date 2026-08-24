# Cloudflare Tunnel Migration Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the ngrok public transport with a Cloudflare named tunnel on a stable self-owned hostname, while preserving MCP authentication, host/origin checks, and a reversible ngrok rollback path.

**Architecture:** Separate the local MCP server lifecycle from the public transport lifecycle. The server trusts a transport-neutral PUBLIC_HOST; cloudflared owns the outbound connection to 127.0.0.1:PORT and is supervised independently as a Windows service. The hostname, tunnel UUID, credential JSON, and Cloudflare login token stay outside the repository.

**Tech Stack:** TypeScript, Node.js, PowerShell 5.1, cloudflared named tunnels, Windows Service Manager, Cloudflare DNS.

---

## File structure

- Modify: src/config.ts — add public-host configuration with legacy NGROK_DOMAIN fallback.
- Modify: src/index.ts — use the transport-neutral public hostname in allowed host/origin configuration.
- Modify: scripts/start-feishu-mcp.ps1 — make the launcher local-service-only and remove ngrok process ownership.
- Modify: start-feishu-mcp.bat — call the renamed local launcher mode.
- Create: scripts/test-cloudflare-tunnel.ps1 — bounded local/public health validation without secrets.
- Create: docs/superpowers/specs/2026-08-24-cloudflare-tunnel-design.md — final checked operational contract.
- Modify: README.md and Aily registration guidance.
- Retain temporarily: scripts/start-ngrok.ps1 and the existing ngrok Runbook as rollback material.

### Task 1: Lock prerequisites and create the named tunnel outside the repository

**Files:**
- Create locally outside repository: %USERPROFILE%\.cloudflared\config.yml
- Create/modify outside repository: .env (not committed)
- Verify: Cloudflare dashboard DNS and Windows cloudflared installation

- [ ] **Step 1: Confirm that the selected subdomain is proxied by Cloudflare DNS**

The operator must choose one hostname, for example mcp.example.com. It must be an active zone in the operator's Cloudflare account. Do not modify repository code or Aily endpoint until that hostname is active.

- [ ] **Step 2: Authenticate and create a named tunnel in an interactive local terminal**

    cloudflared tunnel login
    cloudflared tunnel create feishu-mcp

Expected: browser login completes; the command prints a UUID and creates one credential JSON under %USERPROFILE%\.cloudflared. Never copy that JSON, account token, or full credential path into git, logs, screenshots, or MCP responses.

- [ ] **Step 3: Bind the chosen hostname to that tunnel**

    cloudflared tunnel route dns feishu-mcp mcp.example.com

Expected: Cloudflare creates a proxied CNAME for mcp.example.com pointing at the named tunnel.

- [ ] **Step 4: Write the external connector configuration**

    tunnel: <tunnel UUID from Step 2>
    credentials-file: C:\Users\<Windows user>\.cloudflared\<tunnel UUID>.json
    ingress:
      - hostname: mcp.example.com
        service: http://127.0.0.1:3000
      - service: http_status:404

Use the actual configured MCP PORT in place of 3000. Restrict NTFS ACLs on the credential JSON and config.yml to the Windows account that runs cloudflared.

- [ ] **Step 5: Install but do not yet start the Windows service**

    cloudflared service install

Expected: Service Manager lists cloudflared. Configure its service account as the same Windows user that owns the credential file, or move credentials/config to a service-readable protected location before starting it.

### Task 2: Add transport-neutral public-host configuration

**Files:**
- Modify: src/config.ts
- Modify: src/index.ts
- Test: test/config.test.mjs or a new test/public-host-config.test.mjs

- [ ] **Step 1: Write failing public-host fallback tests**

    test("PUBLIC_HOST overrides legacy NGROK_DOMAIN", () => {
      const config = loadConfig({ PUBLIC_HOST: "mcp.example.com", NGROK_DOMAIN: "old.ngrok.app" });
      assert.equal(config.PUBLIC_HOST, "mcp.example.com");
    });
    test("legacy NGROK_DOMAIN remains a temporary fallback", () => {
      const config = loadConfig({ NGROK_DOMAIN: "old.ngrok.app" });
      assert.equal(config.PUBLIC_HOST, "old.ngrok.app");
    });

- [ ] **Step 2: Run:** node --test test/public-host-config.test.mjs  
Expected: FAIL because PUBLIC_HOST is not exported.

- [ ] **Step 3: Implement the explicit compatibility boundary**

    export const LEGACY_NGROK_DOMAIN = process.env.NGROK_DOMAIN || "";
    export const PUBLIC_HOST = process.env.PUBLIC_HOST || LEGACY_NGROK_DOMAIN;

Update index.ts so allowedRequestHosts contains PUBLIC_HOST, not NGROK_DOMAIN. Keep the legacy environment variable for exactly one migration release; no other server module may refer to NGROK_AUTHTOKEN or transport-specific configuration.

- [ ] **Step 4: Run:** npm run build && node --test test/public-host-config.test.mjs  
Expected: PASS. Health endpoint and MCP route remain unchanged.

- [ ] **Step 5: Commit**

    git add src/config.ts src/index.ts test/public-host-config.test.mjs
    git commit -m "refactor: use transport-neutral public host"

### Task 3: Decouple local MCP startup from ngrok

**Files:**
- Modify: scripts/start-feishu-mcp.ps1
- Modify: start-feishu-mcp.bat
- Test: test/startup-launcher.test.mjs or script CheckOnly acceptance

- [ ] **Step 1: Write failing launcher checks**

    $env:PUBLIC_HOST = "mcp.example.com"
    & .\scripts\start-feishu-mcp.ps1 -CheckOnly

Expected: launcher reports status ready, host 127.0.0.1, publicHost mcp.example.com, and has no requirement for NGROK_AUTHTOKEN, port 4040, or an ngrok executable.

- [ ] **Step 2: Refactor launcher responsibilities**

Keep its existing .env loading, host/port, authentication, directory, build, and local /health checks. Remove Resolve-Ngrok, Wait-NgrokTunnel, ngrok 4040 port checks, ngrok process startup, public ngrok health probing, and coupled termination. Change the preflight hostname lookup to:

    $publicHost = Require-Value "PUBLIC_HOST"
    if ($publicHost -notmatch '^[A-Za-z0-9.-]+$') {
        throw "PUBLIC_HOST must contain only a hostname"
    }

Start only node dist/index.js. On Q, Enter, Ctrl+C, or node failure, clean up only the local node process. Print the expected public URL from PUBLIC_HOST but explicitly state that connector health is checked by test-cloudflare-tunnel.ps1 or Windows service status.

- [ ] **Step 3: Update the batch entrypoint**

Keep start-feishu-mcp.bat as a thin call to scripts/start-feishu-mcp.ps1. It must not invoke ngrok or cloudflared, and must preserve the existing PowerShell execution-policy behavior.

- [ ] **Step 4: Run local launch acceptance**

    .\scripts\start-feishu-mcp.ps1 -CheckOnly
    .\scripts\start-feishu-mcp.ps1

Expected: local /health returns version 1.0.0 and exact tool inventory; closing launcher stops only node and leaves cloudflared service ownership untouched.

- [ ] **Step 5: Commit**

    git add scripts/start-feishu-mcp.ps1 start-feishu-mcp.bat test/startup-launcher.test.mjs
    git commit -m "refactor: separate MCP service from ngrok"

### Task 4: Add bounded Cloudflare health verification

**Files:**
- Create: scripts/test-cloudflare-tunnel.ps1
- Test: manual validation plus script parameter tests if the project has PowerShell test infrastructure

- [ ] **Step 1: Implement a read-only test script with strict inputs**

    param(
      [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost,
      [ValidateRange(1, 65535)][int]$Port = 3000
    )

The script must query http://127.0.0.1:$Port/health, then https://$PublicHost/health using a 20-second timeout. It must parse JSON and require status ok, version 1.0.0, toolCount matching the tool array length, and mcpEndpoint equal to /mcp. It must never print Authorization, MCP_AUTH_TOKEN, .env contents, Cloudflare credentials, or process environments.

- [ ] **Step 2: Add service-state verification**

    Get-Service -Name cloudflared -ErrorAction Stop |
      Select-Object Status, Name, StartType

Treat a stopped/missing service as a failed connector check. The test must distinguish local health failure from public health failure and exit nonzero for either one.

- [ ] **Step 3: Run validation before Aily cutover**

    .\scripts\test-cloudflare-tunnel.ps1 -PublicHost mcp.example.com -Port 3000

Expected: both local and public health checks pass. If local passes but public fails, keep Aily on ngrok and inspect the cloudflared service and Cloudflare DNS; do not weaken host/origin validation.

- [ ] **Step 4: Commit**

    git add scripts/test-cloudflare-tunnel.ps1
    git commit -m "test: add Cloudflare tunnel health check"

### Task 5: Cut over Aily, monitor, and preserve rollback

**Files:**
- Modify: .env locally only, never commit
- Modify: README.md and Aily setup/onboarding guide
- Retain: scripts/start-ngrok.ps1 and docs/CLOUDFLARE_TUNNEL_MIGRATION.md until the observation period ends

- [ ] **Step 1: Change local environment without exposing secrets**

    PUBLIC_HOST=mcp.example.com
    # Keep NGROK_DOMAIN only for rollback during the observation period.
    # Do not store NGROK_AUTHTOKEN in the active Cloudflare configuration.

Restart the local MCP launcher after editing .env. Confirm /health reports authEnabled true and the intended auth mode; none mode must remain owner-scoped at the tool layer.

- [ ] **Step 2: Start and verify cloudflared**

    Start-Service cloudflared
    .\scripts\test-cloudflare-tunnel.ps1 -PublicHost mcp.example.com

Expected: service is Running and both health checks pass.

- [ ] **Step 3: Update Aily configuration**

Change only the endpoint to https://mcp.example.com/mcp. Preserve the existing Authorization header and x-aily-user identity header. Rediscover tools, call ping, then run a read-only authenticated tool. Do not paste tokens into Aily descriptions or documentation.

- [ ] **Step 4: Observe for seven days**

Record service restarts, public health failures, timeout rate, and connector logs with secrets redacted. Compare against the ngrok disconnect pattern observed on 2026-08-24. Treat any public outage longer than five minutes as a rollback trigger until its cause is known.

- [ ] **Step 5: Perform a tested rollback when required**

    Stop-Service cloudflared
    # Restore NGROK_DOMAIN and NGROK_AUTHTOKEN in the local .env.
    .\scripts\start-ngrok.ps1

Change the Aily endpoint back to the prior ngrok address, then verify local health, public health, and ping. Do not delete the named tunnel or its DNS route during rollback.

- [ ] **Step 6: Final documentation and clean-up commit after observation**

Update README and Aily guide to make Cloudflare the primary route, document the service/status/health commands, and label ngrok rollback-only. Remove legacy NGROK_DOMAIN fallback and ngrok launcher only in a separately approved cleanup change after the seven-day observation succeeds.

    git add README.md docs
    git commit -m "docs: document Cloudflare MCP transport"

