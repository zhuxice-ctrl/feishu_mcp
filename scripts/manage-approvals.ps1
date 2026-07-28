[CmdletBinding(DefaultParameterSetName = "List")]
param(
    [Parameter(ParameterSetName = "List")]
    [switch]$List,

    [Parameter(Mandatory = $true, ParameterSetName = "Remove")]
    [ValidateNotNullOrEmpty()]
    [string]$Remove,

    [Parameter(Mandatory = $true, ParameterSetName = "Clear")]
    [switch]$Clear,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "feishu-mcp")
)

$ErrorActionPreference = "Stop"
$storePath = Join-Path $DataDir "approvals.json"

function Read-Store {
    if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
        return [pscustomobject]@{ version = 1; approvals = @() }
    }
    $parsed = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($parsed.version -ne 1 -or $null -eq $parsed.approvals) {
        throw "Unsupported or invalid approval store: $storePath"
    }
    return $parsed
}

function Write-Store($store) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    $temporary = Join-Path $DataDir (".approvals-{0}-{1}.tmp" -f $PID, [guid]::NewGuid())
    try {
        $json = ($store | ConvertTo-Json -Depth 5) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $storePath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

$store = Read-Store
if ($PSCmdlet.ParameterSetName -eq "Clear") {
    $store.approvals = @()
    Write-Store $store
    Write-Output "All permanent approvals were removed."
    exit 0
}

if ($PSCmdlet.ParameterSetName -eq "Remove") {
    $before = @($store.approvals).Count
    $store.approvals = @($store.approvals | Where-Object { $_.id -ne $Remove })
    if (@($store.approvals).Count -eq $before) {
        throw "Approval id not found: $Remove"
    }
    Write-Store $store
    Write-Output "Permanent approval removed: $Remove"
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
