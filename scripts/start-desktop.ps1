<#
.SYNOPSIS
  GitHub Knowledge Hub — reliable Windows desktop launcher.
.DESCRIPTION
  Starts PostgreSQL, validates migration state without changing schema, then
  starts Next.js and both workers with separate PID files and logs.
.PARAMETER SmokeTest
  Verify all three processes and stop only the processes started by this invocation.
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SmokeTest,
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $ProjectRoot "docker-compose.yml"
$AppUrl = "http://localhost:$Port"
$ContainerName = "github-knowledge-hub-db"
$RuntimeDir = if ($env:GKH_RUNTIME_DIR) { $env:GKH_RUNTIME_DIR } else { Join-Path $ProjectRoot ".run" }
$LogDir = if ($env:GKH_LOG_DIR) { $env:GKH_LOG_DIR } else { Join-Path $ProjectRoot "logs" }
$StartedProcesses = @()
$ExitCode = 0

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

function Write-Step([string]$Message) { Write-Host "`n>>> $Message" -ForegroundColor Yellow }
function Write-OK([string]$Message) { Write-Host "  OK  $Message" -ForegroundColor Green }

function Assert-NativeSuccess([string]$Message) {
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Test-DockerEngine {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        docker info *> $null
        return $LASTEXITCODE -eq 0
    }
    finally { $ErrorActionPreference = $previousPreference }
}

function Test-App {
    try {
        $response = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch { return $false }
}

function Get-RecordPath([string]$Name) { return Join-Path $RuntimeDir "$Name.json" }

function Get-ManagedProcess([string]$Name) {
    $recordPath = Get-RecordPath $Name
    if (-not (Test-Path $recordPath)) { return $null }
    try {
        $record = Get-Content $recordPath -Raw | ConvertFrom-Json
        $managedProcess = Get-Process -Id $record.processId -ErrorAction Stop
        if ($managedProcess.StartTime.ToUniversalTime().Ticks -ne [long]$record.startTimeTicks) {
            throw "PID start time does not match"
        }
        return $managedProcess
    }
    catch {
        Remove-Item $recordPath -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Start-ManagedProcess([string]$Name, [string[]]$Arguments) {
    $stdoutPath = Join-Path $LogDir "$Name.log"
    $stderrPath = Join-Path $LogDir "$Name.error.log"
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $managedProcess = Start-Process -FilePath $npm -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $record = @{
        processId = $managedProcess.Id
        startTimeTicks = $managedProcess.StartTime.ToUniversalTime().Ticks.ToString()
        name = $Name
        stdout = $stdoutPath
        stderr = $stderrPath
    }
    $record | ConvertTo-Json | Set-Content -Path (Get-RecordPath $Name) -Encoding UTF8
    $script:StartedProcesses += $Name
    Write-OK "$Name started (PID $($managedProcess.Id))"
    return $managedProcess
}

function Stop-ProcessTree([int]$ProcessId) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree $child.ProcessId }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-ManagedProcess([string]$Name) {
    $managedProcess = Get-ManagedProcess $Name
    if ($managedProcess) {
        Stop-ProcessTree $managedProcess.Id
        Write-OK "$Name stopped"
    }
    Remove-Item (Get-RecordPath $Name) -Force -ErrorAction SilentlyContinue
}

$mutex = New-Object System.Threading.Mutex($false, "Local\GitHubKnowledgeHubDesktopLauncher")
$mutexHeld = $false
try {
    if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(30))) {
        throw "Another launcher is still running; retry after it finishes"
    }
    $mutexHeld = $true

    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "  GitHub Knowledge Hub -- Docker Desktop Launcher" -ForegroundColor Cyan
    Write-Host "===================================================="

    foreach ($commandName in @("docker", "npx.cmd", "npm.cmd")) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "Required command not found: $commandName"
        }
    }
    if (-not (Test-Path $ComposeFile)) { throw "Compose file not found: $ComposeFile" }

    Write-Step "Checking existing Web and Worker instances ..."
    $webProcess = Get-ManagedProcess "web"
    $workerProcess = Get-ManagedProcess "worker"
    $automationProcess = Get-ManagedProcess "automation"
    $webReachable = Test-App
    $useExistingWeb = $webReachable -and -not $webProcess

    if ($webReachable -and $workerProcess -and $automationProcess) {
        Write-OK "Web, analysis Worker and automation Worker are already running; no duplicates started"
        if (-not $NoBrowser -and -not $SmokeTest) { Start-Process -FilePath $AppUrl }
        return
    }
    if ($useExistingWeb) { Write-OK "Using the existing Web instance at $AppUrl" }
    if ($workerProcess) { Write-OK "Analysis Worker is already running (PID $($workerProcess.Id))" }
    if ($automationProcess) { Write-OK "Automation Worker is already running (PID $($automationProcess.Id))" }

    if (-not $webProcess -and -not $useExistingWeb) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            $occupyingPid = ($listener | Select-Object -First 1).OwningProcess
            throw "Port $Port is occupied by PID $occupyingPid, but $AppUrl is unavailable"
        }
    }

    Write-Step "Checking Docker engine ..."
    if (-not (Test-DockerEngine)) {
        $candidates = @()
        if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe" }
        $dockerDesktop = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $dockerDesktop) { throw "Docker engine is unavailable; start Docker Desktop manually" }
        Start-Process -FilePath $dockerDesktop | Out-Null
        $engineReady = $false
        $deadline = [DateTime]::Now.AddMinutes(3)
        while ([DateTime]::Now -lt $deadline) {
            Start-Sleep -Seconds 3
            if (Test-DockerEngine) { $engineReady = $true; break }
        }
        if (-not $engineReady) { throw "Docker engine did not become ready within 3 minutes" }
    }
    Write-OK "Docker engine is ready"

    Write-Step "Starting PostgreSQL and checking readiness ..."
    # A second Worktree has a different Compose project but the same fixed
    # container name. Reuse the already-running local database container instead
    # of asking Compose to create a conflicting container/network/volume stack.
    $containerState = docker inspect --format "{{.State.Running}}" $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0 -and "$containerState".Trim() -eq "true") {
        Write-OK "Existing PostgreSQL container is running; reusing it"
    }
    else {
        docker compose -f "$ComposeFile" up -d
        Assert-NativeSuccess "docker compose up failed"
    }
    $databaseReady = $false
    $deadline = [DateTime]::Now.AddSeconds(90)
    while ([DateTime]::Now -lt $deadline) {
        docker exec $ContainerName pg_isready -U postgres -d github_knowledge_hub *> $null
        if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $databaseReady) { throw "PostgreSQL did not become ready within 90 seconds" }
    Write-OK "PostgreSQL is ready"

    Push-Location $ProjectRoot
    try {
        Write-Step "Validating Prisma and migration status (read-only) ..."
        npx.cmd prisma validate
        Assert-NativeSuccess "prisma validate failed"
        npx.cmd prisma migrate status
        Assert-NativeSuccess "Database migrations are not up to date; run npm run db:deploy after reviewing the maintenance guide"
        Write-OK "Prisma schema and migrations are valid; no schema changes were made"

        if (-not $workerProcess) {
            Write-Step "Starting analysis Worker ..."
            $workerProcess = Start-ManagedProcess "worker" @("run", "worker")
            Start-Sleep -Seconds 2
            $workerProcess.Refresh()
            if ($workerProcess.HasExited) { throw "Worker exited during startup; inspect $LogDir\worker.error.log" }
        }

        if (-not $automationProcess) {
            Write-Step "Starting automation Worker ..."
            $automationProcess = Start-ManagedProcess "automation" @("run", "worker:automation")
            Start-Sleep -Seconds 2
            $automationProcess.Refresh()
            if ($automationProcess.HasExited) { throw "Automation Worker exited during startup; inspect $LogDir\automation.error.log" }
        }

        if (-not $webProcess -and -not $useExistingWeb) {
            Write-Step "Starting Next.js development server ..."
            $webProcess = Start-ManagedProcess "web" @("run", "dev", "--", "--port", $Port.ToString())
        }

        if (-not $webReachable) {
            $deadline = [DateTime]::Now.AddSeconds(90)
            while ([DateTime]::Now -lt $deadline) {
                if (Test-App) { $webReachable = $true; break }
                if ($webProcess) {
                    $webProcess.Refresh()
                    if ($webProcess.HasExited) { throw "Next.js exited during startup; inspect $LogDir\web.error.log" }
                }
                Start-Sleep -Seconds 1
            }
        }
        if (-not $webReachable) { throw "Next.js did not become reachable at $AppUrl within 90 seconds" }

        $workerProcess.Refresh()
        if ($workerProcess.HasExited) { throw "Worker stopped during startup; inspect $LogDir\worker.error.log" }
        $automationProcess.Refresh()
        if ($automationProcess.HasExited) { throw "Automation Worker stopped during startup; inspect $LogDir\automation.error.log" }
        Write-OK "Web is reachable at $AppUrl; analysis Worker and automation Worker are running"
        Write-Host "  Web log:        $(Join-Path $LogDir 'web.log')" -ForegroundColor Gray
        Write-Host "  Worker log:     $(Join-Path $LogDir 'worker.log')" -ForegroundColor Gray
        Write-Host "  Automation log: $(Join-Path $LogDir 'automation.log')" -ForegroundColor Gray

        if ($SmokeTest) {
            Write-OK "Smoke test passed; only newly started processes will be stopped"
        }
        else {
            if (-not $NoBrowser) { Start-Process -FilePath $AppUrl }
            Write-Host "  Stop with: npm run dev:desktop:stop" -ForegroundColor Gray
        }
    }
    finally { Pop-Location }
}
catch {
    $ExitCode = 1
    Write-Host "`nStartup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Review logs in $LogDir. No unrelated process was stopped." -ForegroundColor Gray
}
finally {
    if ($SmokeTest -or $ExitCode -ne 0) {
        foreach ($name in ($StartedProcesses | Sort-Object -Descending)) { Stop-ManagedProcess $name }
    }
    if ($mutexHeld) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
if ($ExitCode -ne 0) { exit $ExitCode }
