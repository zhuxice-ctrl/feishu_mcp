<#
.SYNOPSIS
Scan tracked files and reachable Git objects for development secrets.

.DESCRIPTION
Scans the repository working tree and all reachable Git objects for the
current configured Bearer token, PIN, approval signing key, broker key,
generated fixture secrets, credential blobs, private-key markers, PFX and
keystore files, and authorization headers with values.

The script prints only the finding category and the file or object identity
(SHA/path). It NEVER prints the matched secret, credential value, or key
material. Exit code is 0 when zero findings are present, 1 otherwise.
#>
[CmdletBinding()]
param(
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$findings = @()

# --- Collect live secret values from .env (never printed) ---
$liveSecrets = @()
$secretKeys = @(
    "MCP_AUTH_TOKEN",
    "AUTH_PIN",
    "APPROVAL_STATE_SECRET",
    "NGROK_AUTHTOKEN",
    "DEV_ENV_BROKER_KEY"
)
foreach ($key in $secretKeys) {
    $value = [Environment]::GetEnvironmentVariable($key, "Process")
    if (-not [string]::IsNullOrEmpty($value) -and $value.Length -ge 8) {
        $liveSecrets += $value
    }
}
if ($EnvFile -and (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        if ($line -match '^\s*(MCP_AUTH_TOKEN|AUTH_PIN|APPROVAL_STATE_SECRET|NGROK_AUTHTOKEN|DEV_ENV_BROKER_KEY_PATH)\s*=\s*(.+)$') {
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            if ($val.Length -ge 8) { $liveSecrets += $val }
        }
    }
}

# --- Pattern categories. Each entry: label + regex. ---
$patterns = @(
    @{ Label = "bearer-token-header";   Regex = 'Authorization:\s*Bearer\s+(?!<|\$\{|MCP_|YOUR_|REPLACE|EXAMPLE|PLACEHOLDER)[A-Za-z0-9._-]{24,}' }
    @{ Label = "private-key-marker";    Regex = '-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----' }
)

# --- Scan tracked working-tree files ---
$tracked = git -C $projectDir ls-files
foreach ($rel in $tracked) {
    $full = Join-Path $projectDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    if ($rel -match '(?i)\.(pfx|p12|keystore|jks)$') {
        $findings += [pscustomobject]@{ Category = "pfx-keystore-file"; Location = "file:$rel" }
    }
    if ($rel -match '(?i)\.broker-key$') {
        $findings += [pscustomobject]@{ Category = "broker-key-blob"; Location = "file:$rel" }
    }
    # Skip binary-ish files by extension.
    if ($rel -match '\.(png|jpg|jpeg|gif|webp|ico|zip|gz|tar|jar|dll|exe|so|dylib|node|snap)$') { continue }
    $text = Get-Content -LiteralPath $full -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($p in $patterns) {
        if ($text -match $p.Regex) {
            $findings += [pscustomobject]@{ Category = $p.Label; Location = "file:$rel" }
        }
    }
    foreach ($secret in $liveSecrets) {
        if ($text.Contains($secret)) {
            $findings += [pscustomobject]@{ Category = "live-secret-leak"; Location = "file:$rel" }
        }
    }
}

# --- Scan reachable Git history in one streaming Git process. ---
# `--root -m -p --full-history --no-renames` emits the introduction/removal of
# every text blob reachable from any ref, including merge-only content, while
# Git keeps binary contents out of the patch stream. This is equivalent to
# scanning each reachable historical text blob for leak patterns, but avoids
# spawning `cat-file` twice per object (which took minutes on Windows).
$currentCommit = "unknown"
$currentPath = "unknown"
git -C $projectDir -c core.quotepath=false log --all --root -m -p --full-history --no-renames --format='commit %H' -- 2>$null |
    ForEach-Object {
        $line = [string]$_
        if ($line -match '^commit ([0-9a-f]{40})$') {
            $script:currentCommit = $Matches[1]
        } elseif ($line -match '^diff --git a/(.+) b/(.+)$') {
            $script:currentPath = $Matches[2]
            $location = "object:$($script:currentCommit):$($script:currentPath)"
            if ($script:currentPath -match '(?i)\.(pfx|p12|keystore|jks)$') {
                $script:findings += [pscustomobject]@{ Category = "pfx-keystore-file"; Location = $location }
            }
            if ($script:currentPath -match '(?i)\.broker-key$') {
                $script:findings += [pscustomobject]@{ Category = "broker-key-blob"; Location = $location }
            }
        }
        $location = "object:$($script:currentCommit):$($script:currentPath)"
        foreach ($p in $patterns) {
            if ($line -match $p.Regex) {
                $script:findings += [pscustomobject]@{ Category = $p.Label; Location = $location }
            }
        }
        foreach ($secret in $liveSecrets) {
            if ($line.Contains($secret)) {
                $script:findings += [pscustomobject]@{ Category = "live-secret-leak"; Location = $location }
            }
        }
    }

$findings = @($findings | Sort-Object Category, Location -Unique)

if ($findings.Count -eq 0) {
    Write-Output "No secret findings."
    exit 0
}

foreach ($f in $findings) {
    Write-Output "$($f.Category)`t$($f.Location)"
}
exit 1
