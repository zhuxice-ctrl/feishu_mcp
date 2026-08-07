[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$EnvFile = "",
    [string]$NgrokPath = ""
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $EnvFile) {
    $EnvFile = Join-Path $projectDir ".env"
}

$script:SensitiveValues = @()
$script:ServerErrorLog = $null
$script:NgrokLog = $null

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw ".env file not found: $Path"
    }

    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -le 0) {
            continue
        }

        $name = $trimmed.Substring(0, $separator).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            continue
        }

        $value = $trimmed.Substring($separator + 1).Trim()
        $quoted =
            ($value.Length -ge 2) -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))
        if ($quoted) {
            $value = $value.Substring(1, $value.Length - 2)
        } else {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }

        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

function Require-Value([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name is required in .env"
    }
    return $value.Trim()
}

function Get-BoundedPositiveInt(
    [string]$Name,
    [int64]$Default,
    [int64]$Maximum
) {
    $raw = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Default
    }
    $parsed = [int64]0
    if (-not [int64]::TryParse($raw, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt $Maximum) {
        throw "$Name must be an integer between 1 and $Maximum"
    }
    return $parsed
}

function Resolve-Ngrok([string]$Requested) {
    if ($Requested) {
        if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) {
            throw "Configured ngrok executable was not found"
        }
        return (Resolve-Path -LiteralPath $Requested).Path
    }

    $command = Get-Command ngrok.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        $command = Get-Command ngrok -ErrorAction SilentlyContinue
    }
    if ($command) {
        return $command.Source
    }

    $bundled = Join-Path $projectDir "tools\ngrok\ngrok.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
        return (Resolve-Path -LiteralPath $bundled).Path
    }

    throw "ngrok was not found in PATH or the project tools/ngrok directory"
}

function Wait-Json(
    [string]$Uri,
    [int]$Seconds,
    [System.Diagnostics.Process]$OwnedProcess = $null,
    [hashtable]$Headers = @{}
) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $lastError = $null
    while ((Get-Date) -lt $deadline) {
        if ($OwnedProcess) {
            $OwnedProcess.Refresh()
            if ($OwnedProcess.HasExited) {
                throw "Process exited before $Uri became ready (exit $($OwnedProcess.ExitCode))"
            }
        }
        try {
            return Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec 5
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Timed out waiting for $Uri ($lastError)"
}

function Wait-NgrokTunnel(
    [string]$Domain,
    [int]$Seconds,
    [System.Diagnostics.Process]$OwnedProcess
) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $expectedUrl = "https://$Domain"
    $lastError = $null
    while ((Get-Date) -lt $deadline) {
        $OwnedProcess.Refresh()
        if ($OwnedProcess.HasExited) {
            throw "ngrok exited before the fixed endpoint became ready (exit $($OwnedProcess.ExitCode))"
        }
        try {
            $inspector = Invoke-RestMethod `
                -Uri "http://127.0.0.1:4040/api/tunnels" `
                -TimeoutSec 5
            $tunnel = @($inspector.tunnels) |
                Where-Object {
                    ([string]$_.public_url).TrimEnd('/') -eq $expectedUrl
                } |
                Select-Object -First 1
            if ($tunnel) {
                return $tunnel
            }
            $lastError = "fixed endpoint not registered yet"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for ngrok fixed endpoint ($lastError)"
}

function Stop-ProcessTree($Process) {
    if (-not $Process) {
        return
    }
    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
        }
    } catch {
        # Cleanup is best-effort and targets only the captured child PID.
    }
}

function Write-SafeTail([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8 -Tail 20) {
        $safe = $line
        foreach ($secret in $script:SensitiveValues) {
            if ($secret) {
                $safe = $safe.Replace($secret, "[REDACTED]")
            }
        }
        [Console]::Error.WriteLine($safe)
    }
}

function Assert-PortAvailable([int]$Port) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback,
            $Port
        )
        $listener.Start()
    } catch {
        throw "Local port $Port is already in use"
    } finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

function Get-BrokerState {
    # Read-only probe of the administrator broker service. The function only
    # queries service status and pipe existence — it never mutates the service,
    # never requests elevation, and never reads the key or pipe payload.
    # Returns "ready", "missing", or "incompatible".
    $service = Get-Service -Name "FeishuMcpAdminBroker" -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        return "missing"
    }
    if ($service.Status -ne "Running") {
        return "incompatible"
    }
    $ownerSid = [Environment]::GetEnvironmentVariable("DEV_ENV_OWNER_SID", "Process")
    $keyPath = [Environment]::GetEnvironmentVariable("DEV_ENV_BROKER_KEY_PATH", "Process")
    if ([string]::IsNullOrWhiteSpace($ownerSid) -or
        [string]::IsNullOrWhiteSpace($keyPath) -or
        -not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
        return "incompatible"
    }
    try {
        [void][System.Security.Principal.SecurityIdentifier]::new($ownerSid)
    } catch {
        return "incompatible"
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($ownerSid))
    } finally {
        $sha256.Dispose()
    }
    $suffix = ([System.BitConverter]::ToString($digest, 0, 8) -replace '-', '').ToLowerInvariant()
    $pipeName = "\\.\pipe\feishu-mcp-admin-$suffix"
    $pipeExists = Test-Path -LiteralPath $pipeName -ErrorAction SilentlyContinue
    if (-not $pipeExists) {
        return "incompatible"
    }
    return "ready"
}

function Invoke-Launcher {
    Import-DotEnv $EnvFile

    $brokerService = Get-Service -Name "FeishuMcpAdminBroker" -ErrorAction SilentlyContinue
    if ($brokerService) {
        if ([string]::IsNullOrWhiteSpace($env:DEV_ENV_OWNER_SID)) {
            $env:DEV_ENV_OWNER_SID = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        }
        if ([string]::IsNullOrWhiteSpace($env:DEV_ENV_BROKER_KEY_PATH)) {
            $env:DEV_ENV_BROKER_KEY_PATH = Join-Path $env:ProgramData "FeishuMcp\Broker\broker.key"
        }
    }

    $rawPort = Require-Value "PORT"
    $port = 0
    if (-not [int]::TryParse($rawPort, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "PORT must be an integer between 1 and 65535"
    }

    $hostValue = Require-Value "HOST"
    if ($hostValue -ne "127.0.0.1") {
        throw "HOST must be 127.0.0.1 for the tunnel launcher"
    }

    $allowedDirs = [Environment]::GetEnvironmentVariable("ALLOWED_DIRS", "Process")
    $ownerDirs = [Environment]::GetEnvironmentVariable("OWNER_DEFAULT_DIRS", "Process")
    $ownerId = [Environment]::GetEnvironmentVariable("OWNER_USER_ID", "Process")
    if ([string]::IsNullOrWhiteSpace($allowedDirs) -and [string]::IsNullOrWhiteSpace($ownerDirs)) {
        throw "ALLOWED_DIRS or OWNER_DEFAULT_DIRS must configure at least one directory"
    }
    if (-not [string]::IsNullOrWhiteSpace($ownerDirs) -and [string]::IsNullOrWhiteSpace($ownerId)) {
        throw "OWNER_USER_ID is required when OWNER_DEFAULT_DIRS is configured"
    }
    $directoryApprovalFallback = [Environment]::GetEnvironmentVariable("DIRECTORY_APPROVAL_FALLBACK", "Process")
    if ([string]::IsNullOrWhiteSpace($directoryApprovalFallback)) {
        $directoryApprovalFallback = "deny"
        $env:DIRECTORY_APPROVAL_FALLBACK = $directoryApprovalFallback
    }
    if ($directoryApprovalFallback -notin @("deny", "owner")) {
        throw "DIRECTORY_APPROVAL_FALLBACK must be deny or owner"
    }
    if ($directoryApprovalFallback -eq "owner" -and [string]::IsNullOrWhiteSpace($ownerId)) {
        throw "OWNER_USER_ID is required when directory approval fallback is owner"
    }
    $ownerDefaultCount = @($ownerDirs -split ',' | Where-Object { $_.Trim() }).Count
    $transportToken = Require-Value "MCP_AUTH_TOKEN"
    $authMode = [Environment]::GetEnvironmentVariable("AUTH_MODE", "Process")
    if ([string]::IsNullOrWhiteSpace($authMode)) {
        $authMode = "pin"
        $env:AUTH_MODE = $authMode
    }
    $pin = [Environment]::GetEnvironmentVariable("AUTH_PIN", "Process")
    if ($authMode -eq "pin" -and ([string]::IsNullOrEmpty($pin) -or $pin.Length -lt 8)) {
        throw "AUTH_PIN must contain at least 8 characters when AUTH_MODE=pin"
    }

    $domain = Require-Value "NGROK_DOMAIN"
    if ($domain -notmatch '^[A-Za-z0-9.-]+$') {
        throw "NGROK_DOMAIN must contain only a hostname"
    }

    $approvalSecret = [Environment]::GetEnvironmentVariable("APPROVAL_STATE_SECRET", "Process")
    $ngrokToken = [Environment]::GetEnvironmentVariable("NGROK_AUTHTOKEN", "Process")
    $script:SensitiveValues = @($transportToken, $pin, $approvalSecret, $ngrokToken) |
        Where-Object { -not [string]::IsNullOrEmpty($_) } |
        Sort-Object Length -Descending

    $limitMaximum = 64
    $timeoutMaximum = 3600000
    $responseMaximum = 104857600
    $maxConcurrentTools = Get-BoundedPositiveInt "MAX_CONCURRENT_TOOLS" 8 $limitMaximum
    $maxConcurrentCommands = Get-BoundedPositiveInt "MAX_CONCURRENT_COMMANDS" 2 $limitMaximum
    $maxConcurrentSearches = Get-BoundedPositiveInt "MAX_CONCURRENT_SEARCHES" 2 $limitMaximum
    $maxConcurrentFetches = Get-BoundedPositiveInt "MAX_CONCURRENT_FETCHES" 4 $limitMaximum
    [void](Get-BoundedPositiveInt "TOOL_QUEUE_TIMEOUT_MS" 30000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "COMMAND_TIMEOUT_MS" 30000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "COMMAND_MAX_TIMEOUT_MS" 300000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "COMMAND_MAX_OUTPUT_BYTES" 1048576 $responseMaximum)
    [void](Get-BoundedPositiveInt "SEARCH_TIMEOUT_MS" 30000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "SEARCH_MAX_FILES" 10000 $responseMaximum)
    [void](Get-BoundedPositiveInt "SEARCH_MAX_RESULTS" 1000 $responseMaximum)
    [void](Get-BoundedPositiveInt "GIT_TIMEOUT_MS" 30000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "FETCH_TIMEOUT_MS" 30000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "FETCH_MAX_TIMEOUT_MS" 120000 $timeoutMaximum)
    [void](Get-BoundedPositiveInt "FETCH_MAX_BYTES" 5242880 $responseMaximum)
    [void](Get-BoundedPositiveInt "FETCH_MAX_REDIRECTS" 5 $responseMaximum)
    [void](Get-BoundedPositiveInt "APPROVAL_TIMEOUT_MS" 600000 $timeoutMaximum)

    $approvalDataDir = [Environment]::GetEnvironmentVariable("APPROVAL_DATA_DIR", "Process")
    if ([string]::IsNullOrWhiteSpace($approvalDataDir)) {
        $localDataRoot = [Environment]::GetFolderPath("LocalApplicationData")
        if ([string]::IsNullOrWhiteSpace($localDataRoot)) {
            $localDataRoot = $env:TEMP
        }
        $approvalDataDir = Join-Path $localDataRoot "feishu-mcp"
        $env:APPROVAL_DATA_DIR = $approvalDataDir
    }
    New-Item -ItemType Directory -Path $approvalDataDir -Force | Out-Null
    $approvalFile = Join-Path $approvalDataDir "approvals.json"
    $directoryGrantFile = Join-Path $approvalDataDir "directory-grants.json"
    $approvalCount = 0
    if (Test-Path -LiteralPath $approvalFile -PathType Leaf) {
        try {
            $approvalDocument = Get-Content -LiteralPath $approvalFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $approvalCount = @($approvalDocument.approvals).Count
        } catch {
            throw "Approval store is not valid JSON"
        }
    }
    $directoryGrantCount = 0
    if (Test-Path -LiteralPath $directoryGrantFile -PathType Leaf) {
        try {
            $directoryDocument = Get-Content -LiteralPath $directoryGrantFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($directoryDocument.version -ne 1 -or $null -eq $directoryDocument.grants) {
                throw "invalid directory grant schema"
            }
            $directoryGrantCount = @($directoryDocument.grants).Count
        } catch {
            throw "Directory grant store is not valid JSON"
        }
    }

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        throw "Node.js was not found in PATH"
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
    }
    if (-not $npm) {
        throw "npm was not found in PATH"
    }

    $resolvedNgrok = Resolve-Ngrok $NgrokPath

    if ($CheckOnly) {
        [pscustomobject]@{
            status = "ready"
            port = $port
            host = $hostValue
            authMode = $authMode
            ngrokDomain = $domain
            ngrokPath = $resolvedNgrok
            toolCount = 31
            brokerState = Get-BrokerState
            concurrency = @{
                global = $maxConcurrentTools
                command = $maxConcurrentCommands
                search = $maxConcurrentSearches
                fetch = $maxConcurrentFetches
            }
            permanentApprovalCount = $approvalCount
            ownerDefaultCount = $ownerDefaultCount
            permanentDirectoryGrantCount = $directoryGrantCount
            directoryApprovalFallback = $directoryApprovalFallback
        } | ConvertTo-Json -Compress
        return
    }

    Assert-PortAvailable $port
    Assert-PortAvailable 4040

    Write-Host "Building feishu_mcp..." -ForegroundColor Cyan
    Push-Location $projectDir
    try {
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed"
        }
    } finally {
        Pop-Location
    }

    $logsDir = Join-Path $projectDir "logs"
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $serverOut = Join-Path $logsDir "launcher-server-$stamp.out.log"
    $serverErr = Join-Path $logsDir "launcher-server-$stamp.err.log"
    $ngrokLog = Join-Path $logsDir "launcher-ngrok-$stamp.log"
    $script:ServerErrorLog = $serverErr
    $script:NgrokLog = $ngrokLog

    $server = $null
    $ngrok = $null
    try {
        Write-Host "Starting local MCP on 127.0.0.1:$port..." -ForegroundColor Cyan
        $server = Start-Process -FilePath $node.Source `
            -ArgumentList @("dist/index.js") `
            -WorkingDirectory $projectDir `
            -RedirectStandardOutput $serverOut `
            -RedirectStandardError $serverErr `
            -WindowStyle Hidden `
            -PassThru

        $localHealthUrl = "http://127.0.0.1:$port/health"
        $localHealth = Wait-Json $localHealthUrl 30 $server
        if ($localHealth.version -ne "1.0.0" -or @($localHealth.tools).Count -ne 31) {
            throw "Local health response did not report version 1.0.0 and 31 tools"
        }
        Write-Host "Local health passed (31 tools, auth mode $($localHealth.authMode))." -ForegroundColor Green

        Write-Host "Starting fixed ngrok tunnel..." -ForegroundColor Cyan
        $ngrokArguments = @(
            "http",
            "http://127.0.0.1:$port",
            "--url=https://$domain",
            "--log=$ngrokLog",
            "--log-format=json"
        )
        $ngrok = Start-Process -FilePath $resolvedNgrok `
            -ArgumentList $ngrokArguments `
            -WorkingDirectory $projectDir `
            -WindowStyle Hidden `
            -PassThru

        $httpsTunnel = Wait-NgrokTunnel $domain 30 $ngrok
        $publicUrl = [string]$httpsTunnel.public_url
        $expectedUrl = "https://$domain"
        if ($publicUrl.TrimEnd('/') -ne $expectedUrl) {
            throw "ngrok public URL did not match NGROK_DOMAIN"
        }

        $publicHeaders = @{ "ngrok-skip-browser-warning" = "true" }
        try {
            $publicHealth = Wait-Json "$expectedUrl/health" 45 $ngrok $publicHeaders
            if ($publicHealth.version -ne "1.0.0" -or @($publicHealth.tools).Count -ne 31) {
                throw "Public health response did not report version 1.0.0 and 31 tools"
            }
            Write-Host "Public health passed (31 tools)." -ForegroundColor Green
        } catch {
            Write-Warning "Public health probe unavailable; keeping the established ngrok tunnel running. Local proxy or Fake-IP may block this computer's reverse probe."
        }

        $mcpUrl = "$expectedUrl/mcp"
        try {
            Set-Clipboard -Value $mcpUrl
            $clipboardStatus = "copied to clipboard"
        } catch {
            $clipboardStatus = "clipboard unavailable"
        }

        Write-Host ""
        Write-Host "feishu_mcp is ready." -ForegroundColor Green
        Write-Host "Health: $expectedUrl/health"
        Write-Host "MCP:    $mcpUrl ($clipboardStatus)"
        Write-Host "Press Q or Enter to stop both processes (Ctrl+C also cleans up)." -ForegroundColor Yellow

        while ($true) {
            try {
                if ([Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true)
                    if ($key.Key -eq [ConsoleKey]::Q -or $key.Key -eq [ConsoleKey]::Enter) {
                        break
                    }
                }
            } catch {
                # Non-interactive hosts cannot inspect console keys; process monitoring continues.
            }
            $server.Refresh()
            $ngrok.Refresh()
            if ($server.HasExited) {
                throw "MCP server exited unexpectedly (exit $($server.ExitCode))"
            }
            if ($ngrok.HasExited) {
                throw "ngrok exited unexpectedly (exit $($ngrok.ExitCode))"
            }
            Start-Sleep -Seconds 1
        }
    } catch {
        Write-SafeTail $script:ServerErrorLog
        Write-SafeTail $script:NgrokLog
        throw
    } finally {
        Stop-ProcessTree $ngrok
        Stop-ProcessTree $server
    }
}

try {
    Invoke-Launcher
    exit 0
} catch [System.Management.Automation.PipelineStoppedException] {
    exit 0
} catch {
    [Console]::Error.WriteLine("Error: $($_.Exception.Message)")
    exit 1
}
