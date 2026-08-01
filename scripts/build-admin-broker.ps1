# Build the allowlisted administrator broker into self-contained single-file
# artifacts for win-x64 and win-arm64, and emit an adjacent JSON manifest per
# runtime containing protocol version, catalog digest, runtime, filename, byte
# size, and SHA-256 of the published artifact.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-admin-broker.ps1 -Runtime win-x64
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-admin-broker.ps1 -Runtime win-arm64 -OutputRoot artifacts/admin-broker
#
# Only the two reviewed runtime enums are accepted. The output root must be a
# repository-relative path. No remote script execution, no reflective
# string evaluation, and no secret is embedded.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime,

    [string]$OutputRoot = 'artifacts/admin-broker'
)

$ErrorActionPreference = 'Stop'

if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    throw 'OutputRoot must be a repository-relative path, not an absolute path.'
}

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$project = Join-Path $repoRoot 'broker\FeishuMcp.AdminBroker.Host\FeishuMcp.AdminBroker.Host.csproj'
$outDir = Join-Path (Join-Path $repoRoot $OutputRoot) $Runtime
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "Publishing FeishuMcp.AdminBroker.Host for $Runtime ..."
dotnet publish $project `
    -c Release `
    -r $Runtime `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $outDir

$exeName = 'FeishuMcp.AdminBroker.Host.exe'
$exePath = Join-Path $outDir $exeName
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Published artifact not found: $exePath"
}

$bytes = [System.IO.File]::ReadAllBytes($exePath)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hash = ([System.BitConverter]::ToString($sha256.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()

# Catalog digest is produced by the published broker via its build-time helper.
$catalogDigest = (& $exePath --catalog-digest).Trim()

$manifest = [ordered]@{
    protocolVersion = 1
    catalogDigest   = $catalogDigest
    runtime         = $Runtime
    filename        = $exeName
    byteSize        = $bytes.Length
    sha256          = $hash
}

$manifestPath = Join-Path $outDir 'manifest.json'
$manifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Built $Runtime -> $exePath"
Write-Host "SHA-256: $hash"
Write-Host "Manifest: $manifestPath"
