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
    @{ Label = "bearer-token-header";   Regex = 'Authorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}' }
    @{ Label = "private-key-marker";    Regex = '-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----' }
    @{ Label = "pfx-keystore-file";     Regex = '\.(pfx|p12|keystore|jks)\b' }
    @{ Label = "broker-key-blob";       Regex = '[0-9a-fA-F]{64}\.broker-key' }
    @{ Label = "approval-state-secret"; Regex = 'APPROVAL_STATE_SECRET\s*=\s*[A-Za-z0-9]{32,}' }
    @{ Label = "env-auth-token";        Regex = 'MCP_AUTH_TOKEN\s*=\s*[A-Za-z0-9._-]{16,}' }
    @{ Label = "env-auth-pin";          Regex = 'AUTH_PIN\s*=\s*.{8,}' }
    @{ Label = "ngrok-authtoken";       Regex = 'NGROK_AUTHTOKEN\s*=\s*[A-Za-z0-9_-]{20,}' }
    @{ Label = "credential-id-blob";    Regex = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' }
)

# --- Scan tracked working-tree files ---
$tracked = git -C $projectDir ls-files
foreach ($rel in $tracked) {
    $full = Join-Path $projectDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    # Skip binary-ish files by extension.
    if ($rel -match '\.(png|jpg|jpeg|gif|webp|ico|zip|gz|tar|dll|exe|so|dylib|node|snap)$') { continue }
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

# --- Scan reachable Git objects (blobs) ---
$blobs = git -C $projectDir rev-list --all --objects 2>$null | ForEach-Object {
    ($_.Trim() -split '\s+')[0]
} | Sort-Object -Unique
foreach ($sha in $blobs) {
    $content = git -C $projectDir cat-file -p $sha 2>$null
    if (-not $content) { continue }
    foreach ($p in $patterns) {
        if ($content -match $p.Regex) {
            $findings += [pscustomobject]@{ Category = $p.Label; Location = "object:$sha" }
        }
    }
    foreach ($secret in $liveSecrets) {
        if ($content.Contains($secret)) {
            $findings += [pscustomobject]@{ Category = "live-secret-leak"; Location = "object:$sha" }
        }
    }
}

if ($findings.Count -eq 0) {
    Write-Output "No secret findings."
    exit 0
}

foreach ($f in $findings) {
    Write-Output "$($f.Category)`t$($f.Location)"
}
exit 1
