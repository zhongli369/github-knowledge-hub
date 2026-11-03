[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = if ($env:GKH_RUNTIME_DIR) { $env:GKH_RUNTIME_DIR } else { Join-Path $ProjectRoot ".run" }

function Stop-ProcessTree([int]$ProcessId) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree $child.ProcessId }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

foreach ($name in @("web", "worker")) {
    $recordPath = Join-Path $RuntimeDir "$name.json"
    if (-not (Test-Path $recordPath)) { continue }
    try {
        $record = Get-Content $recordPath -Raw | ConvertFrom-Json
        $managedProcess = Get-Process -Id $record.processId -ErrorAction Stop
        if ($managedProcess.StartTime.ToUniversalTime().Ticks -eq [long]$record.startTimeTicks) {
            Stop-ProcessTree $managedProcess.Id
            Write-Host "Stopped $name (PID $($managedProcess.Id))"
        }
        else {
            Write-Warning "Ignored stale $name PID record"
        }
    }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        Write-Host "$name is not running"
    }
    finally {
        Remove-Item $recordPath -Force -ErrorAction SilentlyContinue
    }
}
