[CmdletBinding()]
param(
    [switch]$List,
    [string]$Remove = "",
    [switch]$Clear,
    [switch]$ListDirectories,
    [string]$RemoveDirectory = "",
    [switch]$ClearDirectories,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "feishu-mcp")
)

$ErrorActionPreference = "Stop"
$approvalPath = Join-Path $DataDir "approvals.json"
$directoryPath = Join-Path $DataDir "directory-grants.json"

function Read-VersionedStore([string]$Path, [string]$Property) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $empty = [ordered]@{ version = 1 }
        $empty[$Property] = @()
        return [pscustomobject]$empty
    }
    $parsed = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($parsed.version -ne 1 -or $null -eq $parsed.$Property) {
        throw "Unsupported or invalid local authorization store"
    }
    return $parsed
}

function Write-VersionedStore([string]$Path, $Store) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    $temporary = Join-Path $DataDir ((".{0}-{1}-{2}.tmp" -f [IO.Path]::GetFileNameWithoutExtension($Path), $PID, [guid]::NewGuid()))
    try {
        $json = ($Store | ConvertTo-Json -Depth 8) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Short-Hash([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 12)
}

function Redacted-Root([string]$Value) {
    $root = [IO.Path]::GetPathRoot($Value)
    $drive = if ($root -and $root -match '^[A-Za-z]:') { $root.Substring(0, 2) } else { "volume" }
    $name = [IO.Path]::GetFileName($Value.TrimEnd('\', '/'))
    if ([string]::IsNullOrWhiteSpace($name)) { $name = "[root]" }
    return "$drive\...\$name"
}

function Resolve-DirectoryRecord($Items, [string]$Selector) {
    $number = 0
    if ([int]::TryParse($Selector, [ref]$number) -and $number -ge 1 -and $number -le $Items.Count) {
        return $Items[$number - 1]
    }
    $matches = @($Items | Where-Object { $_.id -eq $Selector -or $_.id.StartsWith($Selector) })
    if ($matches.Count -ne 1) { throw "Directory grant selector did not match exactly one record" }
    return $matches[0]
}

$actions = @($List, [bool]$Remove, $Clear, $ListDirectories, [bool]$RemoveDirectory, $ClearDirectories) |
    Where-Object { $_ }
if ($actions.Count -gt 1) { throw "Choose exactly one approval-management action" }

if ($ListDirectories -or $RemoveDirectory -or $ClearDirectories) {
    $store = Read-VersionedStore $directoryPath "grants"
    $items = @($store.grants)
    if ($ClearDirectories) {
        $store.grants = @()
        Write-VersionedStore $directoryPath $store
        Write-Output "All permanent directory grants were removed."
        exit 0
    }
    if ($RemoveDirectory) {
        $selected = Resolve-DirectoryRecord $items $RemoveDirectory
        $store.grants = @($items | Where-Object { $_.id -ne $selected.id })
        Write-VersionedStore $directoryPath $store
        Write-Output ("Permanent directory grant removed: {0}" -f $selected.id.Substring(0, [Math]::Min(8, $selected.id.Length)))
        exit 0
    }
    if ($items.Count -eq 0) {
        Write-Output "No permanent directory grants."
        exit 0
    }
    $index = 0
    $items | ForEach-Object {
        $index += 1
        [pscustomobject]@{
            number = $index
            id = $_.id.Substring(0, [Math]::Min(8, $_.id.Length))
            user = Short-Hash ([string]$_.userId)
            root = Redacted-Root ([string]$_.logicalRoot)
            createdAt = $_.createdAt
        }
    } | Format-Table -AutoSize
    exit 0
}

$store = Read-VersionedStore $approvalPath "approvals"
if ($Clear) {
    $store.approvals = @()
    Write-VersionedStore $approvalPath $store
    Write-Output "All permanent approvals were removed."
    exit 0
}
if ($Remove) {
    $before = @($store.approvals).Count
    $store.approvals = @($store.approvals | Where-Object { $_.id -ne $Remove })
    if (@($store.approvals).Count -eq $before) { throw "Approval id not found" }
    Write-VersionedStore $approvalPath $store
    Write-Output "Permanent approval removed."
    exit 0
}
$items = @($store.approvals)
if ($items.Count -eq 0) {
    Write-Output "No permanent approvals."
    exit 0
}
$items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        user = $_.userId
        tool = $_.tool
        scope = $_.subjectKind
        target = "[REDACTED]"
        createdAt = $_.createdAt
    }
} | Format-Table -AutoSize
