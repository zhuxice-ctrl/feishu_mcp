[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Detach,
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $EnvFile) { $EnvFile = Join-Path $projectDir ".env.test" }

function Import-TestEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Test environment file not found" }
    if (-not $Path.EndsWith(".env.test", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Test launcher requires an .env.test file" }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $separator = $trimmed.IndexOf("=")
        if ($separator -le 0) { continue }
        $name = $trimmed.Substring(0, $separator).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid test environment variable name" }
        $value = $trimmed.Substring($separator + 1).Trim()
        # Populate both the .NET process view and PowerShell's environment
        # drive: Start-Process inherits the latter on Windows PowerShell 5.1.
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
        Set-Item -Path ("Env:" + $name) -Value $value
    }
}

function Require-TestValue([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is required in .env.test" }
    return $value.Trim()
}

function Assert-ChildPath([string]$Root, [string]$Candidate, [string]$Name) {
    $prefix = $Root.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not ($Candidate -eq $Root -or $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "$Name must be inside TEST_DATA_ROOT"
    }
}

Import-TestEnv $EnvFile
$port = Require-TestValue "PORT"
$hostValue = Require-TestValue "HOST"
$publicHost = Require-TestValue "PUBLIC_HOST"
$testToken = Require-TestValue "MCP_AUTH_TOKEN"
$dataRoot = [System.IO.Path]::GetFullPath((Require-TestValue "TEST_DATA_ROOT"))
if ($port -ne "3001") { throw "Test MCP PORT must be 3001" }
if ($hostValue -ne "127.0.0.1") { throw "Test MCP HOST must be 127.0.0.1" }
if ($publicHost -ne "mcp-test.zxc66.asia") { throw "Test MCP PUBLIC_HOST must be mcp-test.zxc66.asia" }
foreach ($name in @("APPROVAL_DATA_DIR", "DEV_TASK_DATA_DIR", "LOCAL_WORKSPACE_CATALOG_PATH", "LOG_DIR")) {
    $candidate = [System.IO.Path]::GetFullPath((Require-TestValue $name))
    Assert-ChildPath $dataRoot $candidate $name
}
if ($CheckOnly) {
    [pscustomobject]@{ status = "test-ready"; port = 3001; host = "127.0.0.1"; publicHost = "mcp-test.zxc66.asia"; toolCount = 41 } | ConvertTo-Json -Compress
    exit 0
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $node -or -not $npm) { throw "Node.js and npm are required" }
$listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Test MCP port 3001 is already in use" }
Push-Location $projectDir
try { & $npm.Source run build; if ($LASTEXITCODE -ne 0) { throw "npm run build failed" } } finally { Pop-Location }
$server = Start-Process -FilePath $node.Source -ArgumentList @("dist/index.js") -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
try {
    $deadline = (Get-Date).AddSeconds(30)
    $headers = @{ Authorization = "Bearer $testToken" }
    do { try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:3001/health" -Headers $headers -TimeoutSec 2 } catch {}; if ($health.status -eq "ok" -and @($health.tools).Count -eq 41) { break }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)
    if (-not $health) { throw "Test MCP health check failed" }
    Write-Host "Test MCP is ready at http://127.0.0.1:3001 (production is untouched)."
    if ($Detach) {
        # Used by non-interactive local automation. The recorded PID belongs
        # only to this verified test child; no port discovery is used to stop it.
        Set-Content -LiteralPath (Join-Path $dataRoot "test-mcp.pid") -Value $server.Id -Encoding ASCII
        return
    }
    while (-not $server.HasExited) { Start-Sleep -Seconds 1; $server.Refresh() }
} finally {
    if (-not $Detach -and $server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
