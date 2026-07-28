# Feishu MCP One-Click Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows double-click launcher that builds and starts `feishu_mcp`, establishes the configured fixed ngrok tunnel, verifies local/public health, prints and copies the Aily MCP URL, and cleans up only its own child processes.

**Architecture:** A minimal root BAT delegates to a testable PowerShell orchestrator. The orchestrator imports `.env` without echoing secrets, validates prerequisites, starts Node and ngrok by exact executable/PID, polls both health surfaces, and owns their lifecycle in a `try/finally` block. A `-CheckOnly` mode exposes only non-sensitive resolved configuration so Node tests can cover validation without starting services.

**Tech Stack:** Windows batch, PowerShell 5.1+, Node.js 22+, Node built-in test runner, Express health endpoint, ngrok 3.x local inspector API.

---

## File Map

- Create `start-feishu-mcp.bat`: double-click entrypoint only.
- Create `scripts/start-feishu-mcp.ps1`: configuration, validation, build, process lifecycle, health checks, and output.
- Create `test/launcher.test.mjs`: Windows-only subprocess coverage for safe configuration validation and BAT wiring.
- Modify `README.md`: document the one-click path and fixed-domain prerequisites.
- Modify local ignored `.env`: set loopback binding and the approved fixed domain; never stage this file.

### Task 1: Add Failing Launcher Contract Tests

**Files:**
- Create: `test/launcher.test.mjs`

- [ ] **Step 1: Write the Windows-only tests**

Create a test that skips on non-Windows, creates a temporary `.env` and fake
ngrok executable, and calls the future script in `-CheckOnly` mode:

```js
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
    Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"),
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
      "-ExecutionPolicy", "Bypass",
      "-File", launcherScript,
      "-CheckOnly",
      "-EnvFile", envFile,
      "-NgrokPath", fakeNgrok,
    ],
    {
      cwd: projectDir,
      env: { ...process.env, NGROK_DOMAIN: "", AUTH_PIN: "", MCP_AUTH_TOKEN: "" },
      encoding: "utf8",
    }
  );
}

test("launcher check mode resolves safe configuration without leaking secrets", {
  skip: process.platform !== "win32",
}, async () => {
  const item = await fixture();
  try {
    const result = checkOnly(item.envFile, item.fakeNgrok);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /transport-secret-value|pin-secret-value/);
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
});

test("launcher rejects a missing fixed domain without leaking secrets", {
  skip: process.platform !== "win32",
}, async () => {
  const item = await fixture({ NGROK_DOMAIN: "" });
  try {
    const result = checkOnly(item.envFile, item.fakeNgrok);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NGROK_DOMAIN/);
    assert.doesNotMatch(result.stdout + result.stderr, /transport-secret-value|pin-secret-value/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("BAT entrypoint delegates to the PowerShell orchestrator", {
  skip: process.platform !== "win32",
}, async () => {
  const content = await readFile(path.join(projectDir, "start-feishu-mcp.bat"), "utf8");
  assert.match(content, /scripts\\start-feishu-mcp\.ps1/i);
  assert.match(content, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(content, /MCP_AUTH_TOKEN|AUTH_PIN/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```text
npm test
```

Expected: existing tests pass and `test/launcher.test.mjs` fails because
`scripts/start-feishu-mcp.ps1` and `start-feishu-mcp.bat` do not exist.

### Task 2: Implement the BAT and PowerShell Orchestrator

**Files:**
- Create: `start-feishu-mcp.bat`
- Create: `scripts/start-feishu-mcp.ps1`
- Test: `test/launcher.test.mjs`

- [ ] **Step 1: Add the BAT wrapper**

Use this exact responsibility boundary: the BAT changes directory, invokes the
PowerShell file, returns its exit code, and pauses only on failure.

```bat
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-feishu-mcp.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo feishu_mcp launcher failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
```

- [ ] **Step 2: Implement configuration import and safe validation**

The PowerShell script must declare:

```powershell
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$EnvFile = "",
    [string]$NgrokPath = ""
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $EnvFile) { $EnvFile = Join-Path $projectDir ".env" }
```

Add focused helpers with these interfaces and behavior:

```powershell
function Import-DotEnv([string]$Path)       # UTF-8, quoted values preserve #
function Require-Value([string]$Name)       # throws only the variable name
function Resolve-Ngrok([string]$Requested)  # requested, PATH, then ..\ngrok\ngrok.exe
function Wait-Json([string]$Uri, [int]$Seconds)
function Stop-ProcessTree($Process)         # taskkill exact PID /T /F
function Write-SafeTail([string]$Path)       # redact current token and PIN
```

After import, validate `PORT` as 1..65535, require `HOST=127.0.0.1`, require
`ALLOWED_DIRS`, `MCP_AUTH_TOKEN`, `NGROK_DOMAIN`, and require an eight-character
`AUTH_PIN` only when `AUTH_MODE=pin`. Resolve Node, npm, and ngrok without
printing secret values.

For `-CheckOnly`, emit only:

```powershell
[pscustomobject]@{
    status = "ready"
    port = $port
    host = $env:HOST
    authMode = $env:AUTH_MODE
    ngrokDomain = $env:NGROK_DOMAIN
    ngrokPath = $resolvedNgrok
} | ConvertTo-Json -Compress
exit 0
```

- [ ] **Step 3: Implement the owned process lifecycle**

The main path must:

```powershell
& $npm.Source run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

$server = Start-Process -FilePath $node.Source `
    -ArgumentList @("dist/index.js") `
    -WorkingDirectory $projectDir `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -WindowStyle Hidden -PassThru
```

Poll local health until it returns version `1.0.0` and exactly 11 tools. Then
start ngrok with the fixed domain and a dedicated log file:

```powershell
$ngrok = Start-Process -FilePath $resolvedNgrok `
    -ArgumentList @(
        "http", "http://127.0.0.1:$port",
        "--domain=$($env:NGROK_DOMAIN)",
        "--log=$ngrokLog", "--log-format=json"
    ) `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden -PassThru
```

Poll `http://127.0.0.1:4040/api/tunnels`, require the HTTPS `public_url` to
equal `https://$env:NGROK_DOMAIN`, then poll the public `/health`. Print both
public URLs, call `Set-Clipboard` best-effort, and wait while both processes
remain alive. Put every long-lived process operation inside `try/finally`, and
call `Stop-ProcessTree` for `$ngrok` and `$server` in `finally`.

- [ ] **Step 4: Run the focused and full test suites**

Run:

```text
npm run build
node --test test/launcher.test.mjs
npm test
```

Expected: launcher tests pass on Windows, all existing security tests remain
green, and neither test output stream contains fixture secrets.

- [ ] **Step 5: Commit the launcher**

```text
git add start-feishu-mcp.bat scripts/start-feishu-mcp.ps1 test/launcher.test.mjs
git commit -m "feat: add one-click fixed tunnel launcher"
```

### Task 3: Configure and Document the Fixed Domain

**Files:**
- Modify local ignored file: `.env`
- Modify: `README.md`

- [ ] **Step 1: Patch only non-secret local configuration**

Change or add exactly these values without staging `.env`:

```env
HOST=127.0.0.1
NGROK_DOMAIN=reptilian-prenatal-spinster.ngrok-free.dev
```

Confirm with a sanitized check that Token and PIN remain configured, without
printing their values.

- [ ] **Step 2: Add README usage**

Document the primary Windows flow:

```text
双击 start-feishu-mcp.bat
```

State that the launcher uses `.env`, builds before start, uses a PATH ngrok or
the sibling `ngrok/ngrok.exe`, copies the fixed `/mcp` URL, and stops owned
children on `Ctrl+C`. Keep the existing manual ngrok commands as the fallback.

- [ ] **Step 3: Verify documentation and repository hygiene**

Run:

```text
git diff --check
git status --short
```

Expected: `.env` is ignored; only README is an intended tracked modification.

- [ ] **Step 4: Commit documentation**

```text
git add README.md
git commit -m "docs: document one-click tunnel startup"
```

### Task 4: Live Fixed-Domain Acceptance

**Files:**
- No tracked file changes expected.

- [ ] **Step 1: Run the complete static verification matrix**

Run:

```text
npm ci
npm run typecheck
npm test
git diff --check origin/main...HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Start the launcher through its PowerShell target**

Run the command used by the BAT in an interactive execution session:

```text
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/start-feishu-mcp.ps1
```

Expected: it stays running after reporting local and public health success.

- [ ] **Step 3: Verify all live surfaces independently**

Check:

```text
http://127.0.0.1:3000/health
http://127.0.0.1:4040/api/tunnels
https://reptilian-prenatal-spinster.ngrok-free.dev/health
```

Expected: local/public health report version `1.0.0` and 11 tools; the inspector
reports the configured fixed HTTPS URL.

- [ ] **Step 4: Verify authentication without exposing credentials**

Load `.env` inside the verification process and send an MCP `initialize`
request with the configured Bearer header. Report only status code, server name,
and version. Expected: HTTP 200, `feishu-mcp`, `1.0.0`.

- [ ] **Step 5: Stop and prove cleanup**

Send `Ctrl+C` to the launcher session, then check the exact captured child PIDs
are gone and ports 3000/4040 are not owned by them. Expected: no child survives.

- [ ] **Step 6: Final review**

Inspect `git status -sb`, the branch log, launcher logs for secret values using
in-memory comparisons, and the complete diff against `origin/main`. Resolve any
correctness/security finding before reporting completion.
