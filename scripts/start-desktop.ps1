<#
.SYNOPSIS
  GitHub Knowledge Hub — Docker desktop launcher for Windows.
.DESCRIPTION
  Starts Docker Desktop when needed, starts PostgreSQL, synchronizes Prisma,
  launches Next.js, and opens the browser after the app becomes reachable.
.PARAMETER NoBrowser
  Start the services without opening the default browser.
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $ProjectRoot "docker-compose.yml"
$AppUrl = "http://localhost:3000"
$ContainerName = "github-knowledge-hub-db"
$BrowserJob = $null

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step([string]$Message) {
    Write-Host "`n>>> $Message" -ForegroundColor Yellow
}

function Write-OK([string]$Message) {
    Write-Host "  OK  $Message" -ForegroundColor Green
}

function Assert-NativeSuccess([string]$Message) {
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

function Test-DockerEngine {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        docker info *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Test-App {
    try {
        $response = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

trap {
    Write-Host "`nStartup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Review the messages above. No running process was stopped by this launcher." -ForegroundColor Gray
    exit 1
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  GitHub Knowledge Hub -- Docker Desktop Launcher" -ForegroundColor Cyan
Write-Host "===================================================="

foreach ($commandName in @("docker", "npx.cmd", "npm.cmd")) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $commandName"
    }
}
if (-not (Test-Path $ComposeFile)) {
    throw "Compose file not found: $ComposeFile"
}

Write-Step "Checking for an existing app instance ..."
if (Test-App) {
    Write-OK "$AppUrl is already reachable"
    if (-not $NoBrowser) {
        Start-Process -FilePath $AppUrl
    }
    Write-Host "No duplicate server was started." -ForegroundColor Gray
    return
}

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $occupyingPid = ($listener | Select-Object -First 1).OwningProcess
    throw "Port 3000 is occupied by PID $occupyingPid, but $AppUrl is unavailable. Stop that process manually, then retry."
}
Write-OK "Port 3000 is free"

Write-Step "Checking Docker engine ..."
if (-not (Test-DockerEngine)) {
    $dockerCli = (Get-Command docker -ErrorAction Stop).Source
    $dockerRoot = Split-Path (Split-Path (Split-Path $dockerCli -Parent) -Parent) -Parent
    $candidates = @((Join-Path $dockerRoot "Docker Desktop.exe"))
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    }
    $dockerDesktop = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $dockerDesktop) {
        throw "Docker engine is unavailable and Docker Desktop.exe could not be located. Start Docker Desktop manually, then retry."
    }

    Write-Host "  Starting Docker Desktop: $dockerDesktop" -ForegroundColor Gray
    Start-Process -FilePath $dockerDesktop | Out-Null

    $engineReady = $false
    $deadline = [DateTime]::Now.AddMinutes(3)
    while ([DateTime]::Now -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-DockerEngine) {
            $engineReady = $true
            break
        }
        Write-Host "  Waiting for Docker engine ..." -ForegroundColor Gray
    }
    if (-not $engineReady) {
        throw "Docker engine did not become ready within 3 minutes. Check Docker Desktop, then retry."
    }
}
Write-OK "Docker engine is ready"

Write-Step "Starting PostgreSQL + pgvector ..."
docker compose -f "$ComposeFile" up -d
Assert-NativeSuccess "docker compose up failed"

Write-Host "  Waiting for PostgreSQL ..." -ForegroundColor Gray
$databaseReady = $false
$deadline = [DateTime]::Now.AddSeconds(90)
while ([DateTime]::Now -lt $deadline) {
    docker exec $ContainerName pg_isready -U postgres -d github_knowledge_hub *> $null
    if ($LASTEXITCODE -eq 0) {
        $databaseReady = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $databaseReady) {
    throw "PostgreSQL did not become ready within 90 seconds. Run 'docker logs $ContainerName' for details."
}

docker exec $ContainerName psql -U postgres -d github_knowledge_hub -c "CREATE EXTENSION IF NOT EXISTS vector;"
Assert-NativeSuccess "Failed to enable the pgvector extension"
Write-OK "PostgreSQL and pgvector are ready"

Push-Location $ProjectRoot
try {
    Write-Step "Validating and synchronizing Prisma ..."
    npx.cmd prisma validate
    Assert-NativeSuccess "prisma validate failed"
    npx.cmd prisma db push
    Assert-NativeSuccess "prisma db push failed"
    Write-OK "Prisma is ready"

    if (-not $NoBrowser) {
        $BrowserJob = Start-Job -ScriptBlock {
            param($Url)
            for ($attempt = 0; $attempt -lt 90; $attempt++) {
                try {
                    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
                    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                        Start-Process -FilePath $Url
                        return
                    }
                }
                catch {
                    # The development server may still be compiling; retry until timeout.
                }
                Start-Sleep -Seconds 1
            }
        } -ArgumentList $AppUrl
    }

    Write-Step "Starting Next.js development server ..."
    Write-Host "  URL: $AppUrl" -ForegroundColor Cyan
    Write-Host "  Press Ctrl+C to stop Next.js. PostgreSQL will remain running." -ForegroundColor Gray
    npm.cmd run dev
}
finally {
    if ($BrowserJob) {
        Remove-Job -Job $BrowserJob -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
