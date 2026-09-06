[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Status")][string]$Action = "Start",
    [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost = "mcp.zxc66.asia",
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [ValidateRange(1, 65535)][int]$MetricsPort = 20241,
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$TunnelName = "feishu-mcp",
    [ValidateRange(5, 300)][int]$IntervalSeconds = 20,
    [ValidateRange(1, 10)][int]$FailureThreshold = 3,
    [ValidateRange(1, 10)][int]$MaxRestarts = 4
)

$ErrorActionPreference = "Stop"
$runtimeDir = Join-Path $env:LOCALAPPDATA "FeishuMcp\tunnel"
$statePath = Join-Path $runtimeDir "production-state.json"
$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$cloudflared = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source

function Test-ProductionStatePath {
    $fullRuntime = [System.IO.Path]::GetFullPath($runtimeDir)
    $fullState = [System.IO.Path]::GetFullPath($statePath)
    if (-not $fullState.StartsWith($fullRuntime + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Invalid production runtime state path."
    }
}

function Get-SafeState {
    Test-ProductionStatePath
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }
    try {
        $state = Get-Content -LiteralPath $statePath -Encoding UTF8 -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $state -or $state.tunnelName -ne $TunnelName) {
            return $null
        }
        return $state
    } catch {
        return $null
    }
}

function Write-SafeState([int]$ConnectorPid, [int]$RestartCount, [int]$FailureCount, [string]$Status) {
    Test-ProductionStatePath
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $state = [ordered]@{
        schemaVersion = 1
        supervisorPid = $PID
        connectorPid = $ConnectorPid
        tunnelName = $TunnelName
        status = $Status
        restartCount = $RestartCount
        failureCount = $FailureCount
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $temporaryPath = "$statePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporaryPath, ($state | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Test-ProcessAlive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-SupervisorAlive([object]$State) {
    if ($null -eq $State) { return $false }
    return Test-ProcessAlive ([int]$State.supervisorPid)
}

function Get-ProductionCloudflared {
    $canonicalConfig = [System.IO.Path]::GetFullPath($configPath)
    $matches = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$canonicalConfig*" -and
            $_.CommandLine -match ("\brun\s+" + [regex]::Escape($TunnelName) + "\b")
        }
    return @($matches | Sort-Object CreationDate -Descending)
}

function Test-LocalHealth {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
        return $response -and $response.status -eq "ok"
    } catch {
        return $false
    }
}

function Test-ConnectorHealth {
    try {
        $metrics = (Invoke-WebRequest -Uri "http://127.0.0.1:$MetricsPort/metrics" -TimeoutSec 5 -UseBasicParsing).Content
        $match = [regex]::Match($metrics, '(?m)^cloudflared_tunnel_ha_connections\s+([0-9]+(?:\.[0-9]+)?)\s*$')
        return $match.Success -and [double]$match.Groups[1].Value -ge 1
    } catch {
        return $false
    }
}

function Test-PublicHealth {
    try {
        $response = Invoke-RestMethod -Uri "https://$PublicHost/health" -TimeoutSec 10
        return $response -and $response.status -eq "ok"
    } catch {
        return $false
    }
}

function Start-ProductionConnector {
    if (-not $cloudflared) { throw "cloudflared.exe was not found." }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Cloudflare configuration was not found." }
    # cloudflared tunnel --config $configPath run $TunnelName
    $started = Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--config", $configPath, "run", $TunnelName) -PassThru -WindowStyle Hidden
    return $started.Id
}

function Stop-ProductionConnector([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $candidate -or $candidate.Name -ne "cloudflared.exe") { return }
    $canonicalConfig = [System.IO.Path]::GetFullPath($configPath)
    if (-not $candidate.CommandLine -or $candidate.CommandLine -notlike "*$canonicalConfig*" -or $candidate.CommandLine -notmatch ("\brun\s+" + [regex]::Escape($TunnelName) + "\b")) {
        return
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Test-ProcessAlive $ProcessId)) { Start-Sleep -Milliseconds 250 }
}

function Get-ActiveConnectorPid {
    $state = Get-SafeState
    if ($state -and (Test-ProcessAlive ([int]$state.connectorPid))) { return [int]$state.connectorPid }
    $existing = Get-ProductionCloudflared | Select-Object -First 1
    if ($existing) { return [int]$existing.ProcessId }
    return 0
}

function Stop-ManualSession {
    $state = Get-SafeState
    if ($state -and [int]$state.supervisorPid -ne $PID -and (Test-ProcessAlive ([int]$state.supervisorPid))) {
        Stop-Process -Id ([int]$state.supervisorPid) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    if ($state) { Stop-ProductionConnector ([int]$state.connectorPid) }
    if (Test-Path -LiteralPath $statePath -PathType Leaf) { Remove-Item -LiteralPath $statePath -Force }
    [pscustomobject]@{ status = "stopped"; tunnelName = $TunnelName } | ConvertTo-Json -Compress
}

if ($Action -eq "Status") {
    $state = Get-SafeState
    $supervisorAlive = Test-SupervisorAlive $state
    $connectorHealthy = Test-ConnectorHealth
    $publicHealthy = Test-PublicHealth
    [pscustomobject]@{
        status = if (-not $state) { "not_running" } elseif (-not $supervisorAlive) { "stale_state" } else { [string]$state.status }
        tunnelName = $TunnelName
        supervisorAlive = $supervisorAlive
        connectorHealthy = $connectorHealthy
        publicHealthy = $publicHealthy
        restartCount = if ($state) { [int]$state.restartCount } else { 0 }
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq "Stop") {
    Stop-ManualSession
    exit 0
}

Test-ProductionStatePath
$priorState = Get-SafeState
if ($priorState -and (Test-SupervisorAlive $priorState) -and [int]$priorState.supervisorPid -ne $PID) {
    [pscustomobject]@{ status = "already_running"; tunnelName = $TunnelName } | ConvertTo-Json -Compress
    exit 0
}

# A previous supervisor may have been terminated externally. Its state is no
# longer authoritative, so remove it before claiming this new manual session.
if ($priorState -and -not (Test-SupervisorAlive $priorState)) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

$connectorPid = Get-ActiveConnectorPid
if ($connectorPid -eq 0) { $connectorPid = Start-ProductionConnector }
$restartCount = 0
$failureCount = 0
Write-SafeState $connectorPid $restartCount $failureCount "starting"

while ($true) {
    $currentState = Get-SafeState
    if (-not $currentState -or [int]$currentState.supervisorPid -ne $PID) { exit 0 }

    $localHealthy = Test-LocalHealth
    $connectorHealthy = Test-ConnectorHealth
    $publicHealthy = Test-PublicHealth
    if ($localHealthy -and $connectorHealthy -and $publicHealthy) {
        $failureCount = 0
        Write-SafeState $connectorPid $restartCount $failureCount "healthy"
    } elseif (-not $localHealthy) {
        $failureCount = 0
        Write-SafeState $connectorPid $restartCount $failureCount "local_unhealthy"
    } else {
        $failureCount++
        Write-SafeState $connectorPid $restartCount $failureCount "connector_unhealthy"
        if ($failureCount -ge $FailureThreshold) {
            if ($restartCount -ge $MaxRestarts) {
                Write-SafeState $connectorPid $restartCount $failureCount "manual_action_required"
                exit 1
            }
            Stop-ProductionConnector $connectorPid
            $connectorPid = Start-ProductionConnector
            $restartCount++
            $failureCount = 0
            Write-SafeState $connectorPid $restartCount $failureCount "recovering"
            $backoff = @(5, 10, 20, 40)[[Math]::Min($restartCount - 1, 3)]
            Start-Sleep -Seconds $backoff
        }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
