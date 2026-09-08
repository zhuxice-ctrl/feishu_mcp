# Dual Environment Tunnel Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production MCP launcher remain visible and supervise only its own local server and Cloudflare connector, while leaving a concurrently running test environment untouched.

**Architecture:** `scripts/start-cf-mcp.ps1` becomes the production session owner. It starts missing production children, records exactly which children it owns, continuously checks local, connector, and public health, and restarts only a failed production connector. Process matching uses the production config path plus exact tunnel name, so the test tunnel is never selected.

**Tech Stack:** Windows PowerShell 5.1, cloudflared, Node.js, Node built-in test runner.

---

### Task 1: Define the launcher safety contract in tests

**Files:**
- Modify: `test/cloudflare-tunnel-script.test.mjs`
- Modify: `test/startup-launcher.test.mjs`

- [ ] **Step 1: Add a static regression test for the production launcher**

Add assertions that `scripts/start-cf-mcp.ps1` contains the exact production tunnel name, metrics port `20241`, a Ctrl+C cleanup handler, owned-process cleanup, and a strict process match for `run feishu-mcp`. Assert it contains no `feishu-mcp-test` literal.

- [ ] **Step 2: Run the focused tests to verify the new contract initially fails**

Run: `node --test test/cloudflare-tunnel-script.test.mjs test/startup-launcher.test.mjs`

Expected: the added contract test fails until the launcher owns and supervises its production connector.

- [ ] **Step 3: Commit the red test only if it is independently useful**

Run: `git add test/cloudflare-tunnel-script.test.mjs test/startup-launcher.test.mjs && git commit -m "test: define isolated launcher contract"`

Expected: a focused test commit, or a documented decision to commit together when the test is not independently runnable.

### Task 2: Make the production launcher an owned, visible supervisor

**Files:**
- Modify: `scripts/start-cf-mcp.ps1`
- Modify: `cf_mcp.bat` only if its exit handling needs to preserve Ctrl+C behavior

- [ ] **Step 1: Add exact production connector discovery**

Implement a helper that selects only `cloudflared.exe` processes whose command line contains the canonical production config path and matches `run feishu-mcp` as a whole tunnel name. Do not query or match the test configuration/name.

- [ ] **Step 2: Track ownership when starting children**

When port 3000 is unavailable, observe it without owning it. When the production local launcher is started, retain its process handle. When no matching production connector exists, start cloudflared with the production config, retain its process handle, and wait for connector/public health.

- [ ] **Step 3: Keep the initiating console resident and supervise health**

Replace `Read-Host` with a loop that checks local health, connector metrics on 20241, and public health every 20 seconds. After three consecutive connector/public failures with local health intact, restart only the owned production connector, using 5/10/20/40-second backoff and a four-restart bound.

- [ ] **Step 4: Add Ctrl+C cleanup that is scoped to owned children**

Register a PowerShell cancel handler that stops only the captured local-launcher and cloudflared process trees. Never stop an existing process discovered at startup, and never stop any test process. Remove no shared or test state file.

- [ ] **Step 5: Run the focused test suite**

Run: `node --test test/cloudflare-tunnel-script.test.mjs test/startup-launcher.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the supervisor implementation**

Run: `git add scripts/start-cf-mcp.ps1 cf_mcp.bat test/cloudflare-tunnel-script.test.mjs test/startup-launcher.test.mjs && git commit -m "fix: supervise production tunnel session"`

Expected: one implementation commit without unrelated files.

### Task 3: Verify source and live isolation

**Files:**
- Test: `scripts/start-cf-mcp.ps1`
- Test: `scripts/test-cloudflare-tunnel.ps1`

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run a production-only configuration check**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-cloudflare-tunnel.ps1 -PublicHost mcp.zxc66.asia -Port 3000`

Expected: local/public health succeeds; the check may report that no Windows service is installed because the design deliberately uses a manual resident session.

- [ ] **Step 3: Verify no test identifier is referenced by the production launcher**

Run: `rg -n "feishu-mcp-test|3001|mcp-test" scripts/start-cf-mcp.ps1 cf_mcp.bat`

Expected: no matches.

- [ ] **Step 4: Push only after all checks pass**

Run: `git push origin fix/cf-launcher-persistent-runtime`

Expected: remote branch receives the implementation and plan commits.
