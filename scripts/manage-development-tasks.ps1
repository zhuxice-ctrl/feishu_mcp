<#
.SYNOPSIS
List and clean up terminal development task records.

.DESCRIPTION
Operates only on the persisted development task store (DEV_TASK_DATA_DIR,
which must live inside APPROVAL_DATA_DIR). The script never starts a worker,
never contacts a device or emulator, and never modifies the tunnel domain.

 -List            Print redacted summaries of every task record.
 -Remove <id>     Delete one terminal task directory identified by a UUID or a
                  unique UUID prefix. Non-terminal tasks are rejected.
 -ClearTerminal   Delete every terminal task directory.

Only terminal tasks (succeeded, failed, cancelled, interrupted) may be
removed. Each summary exposes a short id, tool, action, state, timestamps,
and the total byte size of the task directory — never the owner key,
resource paths, launch arguments, environment variables, or credentials.
#>
[CmdletBinding()]
param(
    [switch]$List,
    [string]$Remove = "",
    [switch]$ClearTerminal
)

$ErrorActionPreference = "Stop"

$approvalDataDir = [Environment]::GetEnvironmentVariable("APPROVAL_DATA_DIR", "Process")
if ([string]::IsNullOrWhiteSpace($approvalDataDir)) {
    throw "APPROVAL_DATA_DIR is not configured"
}
if (-not (Test-Path -LiteralPath $approvalDataDir -PathType Container)) {
    throw "APPROVAL_DATA_DIR does not exist: $approvalDataDir"
}
$approvalDataDir = (Resolve-Path -LiteralPath $approvalDataDir).Path

$taskRoot = [Environment]::GetEnvironmentVariable("DEV_TASK_DATA_DIR", "Process")
if ([string]::IsNullOrWhiteSpace($taskRoot)) {
    $taskRoot = Join-Path $approvalDataDir "tasks"
}
if (-not (Test-Path -LiteralPath $taskRoot -PathType Container)) {
    if ($List) { Write-Output "[]" }
    exit 0
}
$taskRoot = (Resolve-Path -LiteralPath $taskRoot).Path

# Enforce confinement: the task root must stay inside APPROVAL_DATA_DIR.
$relative = [System.IO.Path]::GetRelativePath($approvalDataDir, $taskRoot)
if ($relative.StartsWith("..") -or $relative -eq "..") {
    throw "DEV_TASK_DATA_DIR must remain inside APPROVAL_DATA_DIR"
}

$terminalStates = @("succeeded", "failed", "cancelled", "interrupted")

function Convert-ToIso([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try {
        return ([DateTimeOffset]$Value).UtcDateTime.ToString("o")
    } catch {
        return $Value
    }
}

function Get-DirByteSize([string]$Dir) {
    $total = 0L
    foreach ($file in Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue) {
        $total += $file.Length
    }
    return $total
}

function Read-TaskRecord([string]$Dir) {
    $meta = Join-Path $Dir "metadata.json"
    if (-not (Test-Path -LiteralPath $meta -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $meta -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($null -eq $record.id -or $null -eq $record.state) { return $null }
    return $record
}

function New-RedactedSummary([string]$Dir, $Record) {
    return [pscustomobject]@{
        id        = $Record.id
        tool      = $Record.tool
        action    = $Record.action
        state     = $Record.state
        class     = $Record.class
        createdAt = Convert-ToIso $Record.createdAt
        updatedAt = Convert-ToIso $Record.updatedAt
        byteSize  = Get-DirByteSize $Dir
    }
}

$allDirs = @(Get-ChildItem -LiteralPath $taskRoot -Directory -Force -ErrorAction SilentlyContinue)

# ----------------------------------------------------------------- List ----

if ($List) {
    $summaries = @()
    foreach ($dir in $allDirs) {
        $record = Read-TaskRecord $dir.FullName
        if ($null -ne $record) {
            $summaries += (New-RedactedSummary $dir.FullName $record)
        }
    }
    if ($summaries.Count -eq 0) {
        Write-Output "[]"
    } else {
        $summaries | ConvertTo-Json -Compress -Depth 4
    }
    exit 0
}

# --------------------------------------------------------------- Remove ----

if ($Remove) {
    $found = @()
    foreach ($dir in $allDirs) {
        $record = Read-TaskRecord $dir.FullName
        if ($null -ne $record -and $record.id.StartsWith($Remove, [System.StringComparison]::OrdinalIgnoreCase)) {
            $found += ,@{ Dir = $dir.FullName; Record = $record }
        }
    }
    if ($found.Count -eq 0) {
        throw "No task found matching: $Remove"
    }
    if ($found.Count -gt 1) {
        throw "Ambiguous prefix matched $($found.Count) tasks; provide more characters"
    }
    $target = $found[0]
    if ($terminalStates -notcontains $target.Record.state) {
        throw "Task $($target.Record.id) is not terminal (state: $($target.Record.state)); only terminal tasks may be removed"
    }
    Remove-Item -LiteralPath $target.Dir -Recurse -Force
    Write-Output "Removed $($target.Record.id)"
    exit 0
}

# -------------------------------------------------------- ClearTerminal ----

if ($ClearTerminal) {
    $removed = 0
    foreach ($dir in $allDirs) {
        $record = Read-TaskRecord $dir.FullName
        if ($null -ne $record -and $terminalStates -contains $record.state) {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force
            $removed++
        }
    }
    Write-Output "Removed $removed terminal task(s)"
    exit 0
}

throw "Specify -List, -Remove <uuid-or-prefix>, or -ClearTerminal"
