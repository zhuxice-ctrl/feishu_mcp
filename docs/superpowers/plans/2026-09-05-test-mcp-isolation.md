# Test MCP Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a separately configurable test MCP on loopback port 3001 that cannot modify or control the production MCP on port 3000.

**Architecture:** Test launchers load an explicit `.env.test` only and reject every production identifier before building or spawning a process. Test configuration uses separate state roots and a separately supplied Cloudflare configuration; production scripts and `.env` are not imported, overwritten, restarted, or stopped.

**Tech Stack:** PowerShell 5.1, Node.js test runner, TypeScript configuration, Cloudflared.

---

### Task 1: Add isolated test configuration and MCP launcher

**Files:**
- Create: `.env.test.example`
- Create: `scripts/start-test-mcp.ps1`
- Create: `test/test-mcp-isolation.test.mjs`

- [ ] **Step 1: Write failing launcher checks**

Create temporary `.env.test` files and assert `start-test-mcp.ps1 -CheckOnly` accepts only this minimum boundary:

```text
PORT=3001
HOST=127.0.0.1
PUBLIC_HOST=mcp-test.zxc66.asia
TEST_DATA_ROOT=<temporary test root>
APPROVAL_DATA_DIR=<temporary test root>\\approval-data
DEV_TASK_DATA_DIR=<temporary test root>\\tasks
LOCAL_WORKSPACE_CATALOG_PATH=<temporary test root>\\local-workspaces.json
LOG_DIR=<temporary test root>\\logs
```

Assert it rejects `PORT=3000`, `PUBLIC_HOST=mcp.zxc66.asia`, an approval directory outside `TEST_DATA_ROOT`, and an input path named `.env`.

- [ ] **Step 2: Verify the tests fail**

Run: `npm run build && node --test test/test-mcp-isolation.test.mjs`

Expected: FAIL because the isolated launcher does not exist.

- [ ] **Step 3: Implement the strict test launcher and example file**

Implement `start-test-mcp.ps1` with `-CheckOnly` and `-EnvFile` parameters. It must require an existing filename ending in `.env.test`, parse it as UTF-8, enforce the six boundary values from Step 1, and reject any normalized state path outside `TEST_DATA_ROOT`. On normal execution it builds once, starts only `dist/index.js` on `127.0.0.1:3001`, verifies `/health` reports 41 tools, and stops only its captured Node process when the launcher ends.

Use `.env.test.example` with placeholder token values only:

```text
PORT=3001
HOST=127.0.0.1
PUBLIC_HOST=mcp-test.zxc66.asia
MCP_ENDPOINT=/mcp
MCP_AUTH_TOKEN=replace-with-test-token
AUTH_MODE=none
TEST_DATA_ROOT=C:\\replace-with-test-data-root
APPROVAL_DATA_DIR=C:\\replace-with-test-data-root\\approval-data
DEV_TASK_DATA_DIR=C:\\replace-with-test-data-root\\tasks
LOCAL_WORKSPACE_CATALOG_PATH=C:\\replace-with-test-data-root\\local-workspaces.json
LOG_DIR=C:\\replace-with-test-data-root\\logs
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build && node --test test/test-mcp-isolation.test.mjs`

Expected: PASS.

Run: `git add .env.test.example scripts/start-test-mcp.ps1 test/test-mcp-isolation.test.mjs && git commit -m "feat: add isolated test MCP launcher"`

### Task 2: Add isolated Cloudflare test launcher

**Files:**
- Create: `scripts/start-test-cloudflared.ps1`
- Modify: `test/test-mcp-isolation.test.mjs`

- [ ] **Step 1: Extend the failing checks**

Assert the Cloudflare test launcher accepts only a config whose ingress service is `http://127.0.0.1:3001` and hostname is `mcp-test.zxc66.asia`. Assert it rejects production hostname, port 3000, credential filenames containing `feishu-mcp`, and tunnel references matching the production configuration.

- [ ] **Step 2: Implement the test tunnel validator**

Implement `start-test-cloudflared.ps1` with explicit `-ConfigPath` and `-TunnelName` parameters. Require an absolute configuration file outside `%USERPROFILE%\\.cloudflared\\config.yml`, require tunnel name `feishu-mcp-test`, inspect configuration text without printing it, and reject production identifiers before spawning cloudflared. Start a normal child process only; never query, stop, or change the `cloudflared` Windows service.

- [ ] **Step 3: Verify and commit**

Run: `node --test test/test-mcp-isolation.test.mjs`

Expected: PASS.

Run: `git add scripts/start-test-cloudflared.ps1 test/test-mcp-isolation.test.mjs && git commit -m "feat: add isolated test tunnel launcher"`

### Task 3: Document operation and verify production remains independent

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `test/development-docs.test.mjs`

- [ ] **Step 1: Add documentation assertions**

Require README text to state production uses `.env` and 3000, testing uses `.env.test` and 3001, test state/credentials are separate, and the test launchers never restart production.

- [ ] **Step 2: Document the explicit release sequence**

Add this sequence without real token, path, or tunnel ID:

```text
1. Copy .env.test.example to .env.test and fill test-only values.
2. Run scripts/start-test-mcp.ps1.
3. Optionally run scripts/start-test-cloudflared.ps1 with separate test credentials.
4. Validate the test URL, then stop its captured test process.
5. Promote code separately; production remains on .env and port 3000.
```

Add one `.env.example` comment that test values belong only in `.env.test`.

- [ ] **Step 3: Run focused and full verification**

Run: `npm run build && node --test test/test-mcp-isolation.test.mjs test/startup-launcher.test.mjs test/development-docs.test.mjs test/tools-list.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: PASS, or report only evidence-backed pre-existing failures.

- [ ] **Step 4: Commit**

Run: `git add README.md .env.example test/development-docs.test.mjs && git commit -m "docs: document isolated test MCP workflow"`

## Self-review

- [ ] The test launcher rejects production port, host, state roots, and `.env` before spawning Node.
- [ ] The test tunnel launcher rejects production endpoint and configuration before spawning Cloudflared.
- [ ] Neither test script uses service control commands or alters production configuration.
- [ ] Documentation contains no actual credentials, data roots, or tunnel IDs.
