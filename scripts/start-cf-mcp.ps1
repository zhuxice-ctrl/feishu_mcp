[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost = "mcp.zxc66.asia",
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [ValidateRange(1, 65535)][int]$MetricsPort = 20241,
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$TunnelName = "feishu-mcp",
    [ValidateRange(5, 300)][int]$IntervalSeconds = 20,
    [ValidateRange(1, 10)][int]$FailureThreshold = 3,
    [ValidateRange(1, 10)][int]$MaxRestarts = 4
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $projectDir "scripts\start-feishu-mcp.ps1"
$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$cloudflared = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
$script:OwnedProcesses = New-Object System.Collections.ArrayList
$script:Stopping = $false

function Get-ProductionConnector {
    $canonicalConfig = [System.IO.Path]::GetFullPath($configPath)
    return @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$canonicalConfig*" -and
            $_.CommandLine -match ("\brun\s+" + [regex]::Escape($TunnelName) + "\b")
        } | Sort-Object CreationDate -Descending)
}

function Test-LocalHealth {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
        return $response -and $response.status -eq "ok"
    } catch { return $false }
}

function Test-ConnectorHealth {
    try {
        $metrics = (Invoke-WebRequest -Uri "http://127.0.0.1:$MetricsPort/metrics" -TimeoutSec 5 -UseBasicParsing).Content
        $match = [regex]::Match($metrics, '(?m)^cloudflared_tunnel_ha_connections\s+([0-9]+(?:\.[0-9]+)?)\s*$')
        return $match.Success -and [double]$match.Groups[1].Value -ge 1
    } catch { return $false }
}

function Test-PublicHealth {
    try {
        $response = Invoke-RestMethod -Uri "https://$PublicHost/health" -TimeoutSec 10
        return $response -and $response.status -eq "ok"
    } catch { return $false }
}

function Add-OwnedProcess([System.Diagnostics.Process]$Process) {
    if ($Process) { [void]$script:OwnedProcesses.Add($Process) }
    return $Process
}

function Stop-OwnedProcessTree([System.Diagnostics.Process]$Process) {
    if (-not $Process) { return }
    try {
        $Process.Refresh()
        if (-not $Process.HasExited) { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null }
    } catch {
        # The process may have exited between the health check and cleanup.
    }
}

function Stop-OwnedProcesses {
    foreach ($process in @($script:OwnedProcesses)) { Stop-OwnedProcessTree $process }
}

$cancelHandler = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
    if (-not $script:Stopping) {
        $script:Stopping = $true
        Write-Host "Stopping production MCP and Cloudflare session..." -ForegroundColor Yellow
        Stop-OwnedProcesses
    }
}
[Console]::add_CancelKeyPress($cancelHandler)

try {
    if ($TunnelName -ne "feishu-mcp") { throw "Production launcher tunnel name must be feishu-mcp" }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Local MCP launcher was not found: $launcher" }
    if (-not $cloudflared) { throw "cloudflared.exe was not found" }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Cloudflare configuration was not found: $configPath" }

    $local = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($local) {
        Write-Host "Production local port $Port is already listening; observing existing service." -ForegroundColor Yellow
    } else {
        Write-Host "Starting production MCP service..." -ForegroundColor Cyan
        $localProcess = Add-OwnedProcess (Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher
        ) -WorkingDirectory $projectDir -PassThru)
    }

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not (Test-LocalHealth)) { Start-Sleep -Seconds 1 }
    if (-not (Test-LocalHealth)) { throw "Production MCP did not pass health check within 45 seconds" }
    Write-Host "Production MCP health check passed." -ForegroundColor Green

    $existingConnector = Get-ProductionConnector | Select-Object -First 1
    if ($existingConnector) {
        $connectorProcess = $null
        $ownsConnector = $false
        Write-Host "Production Cloudflare connector already exists; observing it." -ForegroundColor Green
    } else {
        Write-Host "Starting production Cloudflare connector..." -ForegroundColor Cyan
        $connectorProcess = Add-OwnedProcess (Start-Process -FilePath $cloudflared -ArgumentList @(
            "tunnel", "--config", $configPath, "run", $TunnelName
        ) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru)
        $ownsConnector = $true
    }

    Write-Host ""
    Write-Host "cf_mcp production session is ready." -ForegroundColor Green
    Write-Host "Local:  http://127.0.0.1:$Port/health"
    Write-Host "Public: https://$PublicHost/mcp"
    Write-Host "Test environment remains independent; it is not managed by this window."
    Write-Host "Press Ctrl+C to stop only processes started by this window." -ForegroundColor Yellow

    $failureCount = 0
    $restartCount = 0
    while (-not $script:Stopping) {
        if (-not (Test-LocalHealth)) { throw "Production MCP became unhealthy" }
        $connectorHealthy = Test-ConnectorHealth
        $publicHealthy = Test-PublicHealth
        if ($connectorHealthy -and $publicHealthy) {
            $failureCount = 0
        } else {
            $failureCount++
            Write-Host "Production connector/public health failed ($failureCount/$FailureThreshold)." -ForegroundColor Yellow
            if ($failureCount -ge $FailureThreshold) {
                if (-not $ownsConnector) { throw "Existing production Cloudflare connector is unhealthy; restart it from its owning session" }
                if ($restartCount -ge $MaxRestarts) { throw "Production Cloudflare connector exceeded restart limit; manual action required" }
                if ($connectorProcess) { Stop-OwnedProcessTree $connectorProcess }
                Write-Host "Restarting production Cloudflare connector..." -ForegroundColor Cyan
                $connectorProcess = Add-OwnedProcess (Start-Process -FilePath $cloudflared -ArgumentList @(
                    "tunnel", "--config", $configPath, "run", $TunnelName
                ) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru)
                $restartCount++
                $failureCount = 0
                Start-Sleep -Seconds @(5, 10, 20, 40)[[Math]::Min($restartCount - 1, 3)]
            }
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    [Console]::remove_CancelKeyPress($cancelHandler)
    Stop-OwnedProcesses
}
