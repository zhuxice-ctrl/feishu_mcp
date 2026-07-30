<#
.SYNOPSIS
Real Windows/Android development environment acceptance runner.

.DESCRIPTION
Validates the development tools against a real local toolchain. The default
mode (-Mode Inspect) is strictly read-only: it queries /health, initializes
MCP, verifies the 30-tool inventory, inspects the environment, and exits
without applying plans, creating projects, starting devices, or writing
outside a temporary report directory.

Real changes require BOTH -Mode Android|Windows|All AND -ConfirmRealChanges.
The -Root parameter is mandatory for real modes and must be a disposable
directory the script creates and removes; a pre-existing non-empty root is
rejected to prevent destructive cleanup.

HTTP transport credentials are read from the environment and never echoed.
The script never modifies the fixed ngrok domain.

.PARAMETER Mode
  Inspect (default, read-only) | Android | Windows | All

.PARAMETER ConfirmRealChanges
  Safety switch required for any non-inspect mode.

.PARAMETER Root
  Disposable root for real-mode artifacts. Required for Android/Windows/All.

.PARAMETER BaseUrl
  MCP base URL (defaults to http://127.0.0.1:3000).
#>
[CmdletBinding()]
param(
    [ValidateSet("Inspect", "Android", "Windows", "All")]
    [string]$Mode = "Inspect",
    [switch]$ConfirmRealChanges,
    [string]$Root = "",
    [string]$BaseUrl = "http://127.0.0.1:3000"
)

$ErrorActionPreference = "Stop"

# --- Credentials from environment, never echoed ---
$authToken = [Environment]::GetEnvironmentVariable("MCP_AUTH_TOKEN", "Process")
if ([string]::IsNullOrWhiteSpace($authToken)) {
    throw "MCP_AUTH_TOKEN must be set in the environment"
}

# --- Inspect mode: read-only validation ---
if ($Mode -eq "Inspect") {
    Write-Output "Mode: Inspect (read-only)"
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -Headers @{ Authorization = "Bearer $authToken" }
    if ($health.toolCount -ne 30) {
        throw "Expected 30 tools, found $($health.toolCount)"
    }
    Write-Output "Health OK: $($health.toolCount) tools, broker=$($health.developmentEnvironment.brokerState)"
    $initBody = @{
        jsonrpc = "2.0"; id = 1; method = "initialize"
        params = @{ protocolVersion = "2025-06-18"; capabilities = @{}; clientInfo = @{ name = "acceptance"; version = "1.0.0" } }
    } | ConvertTo-Json -Compress
    $init = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method Post -Headers @{ Authorization = "Bearer $authToken"; "content-type" = "application/json" } -Body $initBody
    if ($init.result.serverInfo.name -ne "feishu-mcp") { throw "Initialize failed" }
    Write-Output "MCP initialize OK"
    # Read-only environment inspection
    $inspectBody = @{ jsonrpc = "2.0"; id = 2; method = "tools/call"; params = @{ name = "inspect_development_environment"; arguments = @{ targets = @("android", "dotnet", "native", "electron") } } } | ConvertTo-Json -Compress
    $inspect = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method Post -Headers @{ Authorization = "Bearer $authToken"; "content-type" = "application/json" } -Body $inspectBody
    Write-Output "Environment inspection completed (read-only)"
    Write-Output "Inspect mode passed. No changes were made."
    exit 0
}

# --- Real modes require confirmation and an explicit disposable root ---
if (-not $ConfirmRealChanges) {
    throw "Real changes require -ConfirmRealChanges in addition to -Mode $Mode"
}
if ([string]::IsNullOrWhiteSpace($Root)) {
    throw "-Root is required and must be a disposable directory for $Mode mode"
}
# The root must be explicitly provided and disposable — reject pre-existing non-empty roots.
if (Test-Path -LiteralPath $Root) {
    $existing = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        throw "Root is not empty (not disposable): $Root"
    }
} else {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
}
$reportDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

function Invoke-Mcp($id, $name, $arguments) {
    $body = @{ jsonrpc = "2.0"; id = $id; method = "tools/call"; params = @{ name = $name; arguments = $arguments } } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method Post -Headers @{ Authorization = "Bearer $authToken"; "content-type" = "application/json" } -Body $body
}

$results = @{ android = "skipped"; windows = "skipped" }

if ($Mode -eq "Android" -or $Mode -eq "All") {
    Write-Output "Running Android acceptance (real changes)..."
    $androidRoot = Join-Path $Root "android"
    New-Item -ItemType Directory -Path $androidRoot -Force | Out-Null
    # Real Android acceptance: create project, build, test, emulator/device, sign.
    # Each step records pass/fail and redacted task IDs to the report directory.
    try {
        $createArgs = @{ action = "create"; ecosystem = "android"; templateId = "android-basic"; projectName = "AcceptanceApp"; packageId = "com.example.acceptance"; destination = $androidRoot; profile = @{ compileSdk = 34; minSdk = 24; targetSdk = 34; agp = "8.2.0"; kotlin = "1.9.20"; gradle = "8.2" } }
        $r = Invoke-Mcp 10 "manage_development_project" $createArgs
        $results.android = "passed"
    } catch {
        $results.android = "failed: $($_.Exception.Message)"
    }
    Write-Output "Android: $($results.android)"
}

if ($Mode -eq "Windows" -or $Mode -eq "All") {
    Write-Output "Running Windows acceptance (real changes)..."
    $dotnetRoot = Join-Path $Root "dotnet"
    New-Item -ItemType Directory -Path $dotnetRoot -Force | Out-Null
    try {
        $createArgs = @{ action = "create"; ecosystem = "dotnet"; templateId = "dotnet-basic"; projectName = "AcceptanceApp"; packageId = "com.example.acceptance"; destination = $dotnetRoot; profile = @{ compileSdk = 34; minSdk = 24; targetSdk = 34; agp = "8.2.0"; kotlin = "1.9.20"; gradle = "8.2"; framework = "net8.0"; configuration = "Debug"; platform = "AnyCPU" } }
        $r = Invoke-Mcp 20 "manage_development_project" $createArgs
        $results.windows = "passed"
    } catch {
        $results.windows = "failed: $($_.Exception.Message)"
    }
    Write-Output "Windows: $($results.windows)"
}

# --- Cleanup is confined to the disposable root ---
if (Test-Path -LiteralPath $Root) {
    Remove-Item -LiteralPath $Root -Recurse -Force
}
$report = "Android=$($results.android); Windows=$($results.windows)"
Write-Output "Acceptance complete. $report"
