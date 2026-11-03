<#
.SYNOPSIS
  GitHub Knowledge Hub — Windows one-click dev startup
.DESCRIPTION
  Auto: WSL PostgreSQL start -> DB check -> env vars -> Prisma -> Next.js dev
.NOTES
  - sudo password: Read-Host -AsSecureString, never written to disk
  - API Key: written to .env.local (gitignored)
  - No secrets are ever printed
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Fix encoding for WSL UTF-8 output on Chinese Windows
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  GitHub Knowledge Hub -- Local Dev Startup" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# Helper functions
function Write-Step { Write-Host ">>> $args" -ForegroundColor Yellow }
function Write-OK   { Write-Host "  OK  $args" -ForegroundColor Green }
function Write-Err  { Write-Host "  ERR $args" -ForegroundColor Red; exit 1 }
function Write-Warn { Write-Host "  WARN $args" -ForegroundColor Magenta }
function Write-Hint { Write-Host "  HINT $args" -ForegroundColor Gray }

# Step 1: Check WSL
Write-Step "Step 1: Checking WSL ..."
$ErrorActionPreference = "Continue"
wsl --status *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Err "WSL not available. Install: wsl --install"
}
$ErrorActionPreference = "Stop"
Write-OK "WSL ready"

# Step 2: Ensure PostgreSQL is running in WSL
Write-Step "Step 2: Ensuring PostgreSQL is running ..."

# Check if pg is already running
$ErrorActionPreference = "Continue"
wsl bash -c "pg_isready -q -h localhost -p 5432" *>$null
if ($LASTEXITCODE -eq 0) {
    $ErrorActionPreference = "Stop"
    Write-OK "PostgreSQL already running"
} else {
    Write-Hint "PostgreSQL not running, starting via wsl -u root ..."
    wsl -u root service postgresql start *>$null
    Start-Sleep -Seconds 2

    # Verify
    wsl bash -c "pg_isready -q -h localhost -p 5432" *>$null
    if ($LASTEXITCODE -eq 0) {
        $ErrorActionPreference = "Stop"
        Write-OK "PostgreSQL started (no password needed)"
    } else {
        # Need sudo fallback
        Write-Warn "wsl -u root not available, need sudo password"
        $sudoPass = Read-Host "Enter WSL sudo password" -AsSecureString
        $passBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sudoPass)
        $passPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($passBstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passBstr)

        wsl bash -c "echo '$passPlain' | sudo -S service postgresql start" *>$null
        Clear-Variable passPlain -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2

        wsl bash -c "pg_isready -q -h localhost -p 5432" *>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Err "PostgreSQL start failed. Run manually in WSL: sudo service postgresql start"
        }
        $ErrorActionPreference = "Stop"
        Write-OK "PostgreSQL started"
    }
}

# Step 3: Check database exists
Write-Step "Step 3: Checking database github_knowledge_hub ..."

$ErrorActionPreference = "Continue"
$dbCheck = wsl -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='github_knowledge_hub'" *>$null
if ($LASTEXITCODE -ne 0 -or $dbCheck -notmatch "1") {
    Write-Warn "Database github_knowledge_hub not found, creating ..."
    wsl -u postgres createdb github_knowledge_hub *>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to create database"
    }
    Write-OK "Database created"
} else {
    Write-OK "Database github_knowledge_hub exists"
}
$ErrorActionPreference = "Stop"

# Step 4: Check pgvector extension
Write-Step "Step 4: Checking pgvector extension ..."

$ErrorActionPreference = "Continue"
$extCheck = wsl -u postgres psql -d github_knowledge_hub -tAc "SELECT 1 FROM pg_extension WHERE extname='vector'" *>$null
if ($LASTEXITCODE -ne 0 -or $extCheck -notmatch "1") {
    Write-Warn "pgvector extension not found, installing ..."
    wsl -u postgres psql -d github_knowledge_hub -c "CREATE EXTENSION IF NOT EXISTS vector;" *>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to install pgvector"
    }
    Write-OK "pgvector extension installed"
} else {
    Write-OK "pgvector extension ready"
}
$ErrorActionPreference = "Stop"

# Step 5: Check & fill environment variables
Write-Step "Step 5: Checking environment variables ..."

$envLocalFile = Join-Path $ProjectRoot ".env.local"
$envFile = Join-Path $ProjectRoot ".env"
$envVars = @{}

function Load-EnvFile($path) {
    if (Test-Path $path) {
        Get-Content $path | ForEach-Object {
            $line = $_.Trim()
            if ($line -and $line -notmatch '^#' -and $line -match '^([^=]+)=(.*)$') {
                $key = $Matches[1].Trim()
                $val = $Matches[2].Trim().Trim('"').Trim("'")
                if (-not $envVars.ContainsKey($key)) {
                    $envVars[$key] = $val
                }
            }
        }
    }
}

Load-EnvFile $envFile
Load-EnvFile $envLocalFile

function Get-EnvValue($key, $default) {
    $val = [Environment]::GetEnvironmentVariable($key, "Process")
    if ($val) { return $val }
    if ($envVars.ContainsKey($key)) { return $envVars[$key] }
    return $default
}

function Ensure-Env($key, $hint, $isSecret) {
    $current = Get-EnvValue $key ""
    if ($current) {
        if ($isSecret) {
            Write-OK "$key = ***SET***"
        } else {
            Write-OK "$key = $current"
        }
        return $current
    }

    Write-Warn "$key not set"
    Write-Hint $hint

    if ($isSecret) {
        $inputVal = Read-Host "Enter $key" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($inputVal)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    } else {
        $plain = Read-Host "Enter $key"
    }

    # Write to .env.local
    if (-not (Test-Path $envLocalFile)) {
        New-Item $envLocalFile -ItemType File -Force | Out-Null
    }
    # Remove existing entry for this key, then add new one
    $existingLines = @()
    if (Test-Path $envLocalFile) {
        $existingLines = Get-Content $envLocalFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "^$key=" }
    }
    $existingLines + "$key=$plain" | Set-Content $envLocalFile

    if ($isSecret) {
        Write-OK "$key saved to .env.local"
    } else {
        Write-OK "$key = $plain saved to .env.local"
    }
    Clear-Variable plain -ErrorAction SilentlyContinue
    return $plain
}

# Required vars
$vars = @(
    @{Key="DATABASE_URL";        Hint="Default: postgresql://postgres:postgres@localhost:5432/github_knowledge_hub"; Secret=$false; Default="postgresql://postgres:postgres@localhost:5432/github_knowledge_hub?schema=public"},
    @{Key="AUTH_SECRET";         Hint="Will auto-generate if empty. Or run: npx auth secret"; Secret=$true;  Default=""},
    @{Key="AUTH_GITHUB_ID";      Hint="GitHub OAuth App Client ID -> https://github.com/settings/developers"; Secret=$false; Default=""},
    @{Key="AUTH_GITHUB_SECRET";  Hint="GitHub OAuth App Client Secret"; Secret=$true;  Default=""},
    @{Key="OPENAI_API_KEY";      Hint="DeepSeek API Key or OpenAI API Key"; Secret=$true;  Default=""},
    @{Key="OPENAI_BASE_URL";     Hint="DeepSeek: https://api.deepseek.com | OpenAI: leave empty"; Secret=$false; Default="https://api.deepseek.com"},
    @{Key="OPENAI_MODEL";        Hint="DeepSeek: deepseek-chat | OpenAI: gpt-4o-mini"; Secret=$false; Default="deepseek-chat"},
    @{Key="EMBEDDING_MODEL";     Hint="Embedding model (optional, for Phase 6+)"; Secret=$false; Default=""}
)

$needsAuthRestart = $false
foreach ($var in $vars) {
    $val = Ensure-Env $var.Key $var.Hint $var.Secret
    # Handle AUTH_SECRET auto-generation
    if ($var.Key -eq "AUTH_SECRET" -and -not $val) {
        Write-Warn "AUTH_SECRET not set, auto-generating ..."
        $randomBytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($randomBytes)
        $generated = [BitConverter]::ToString($randomBytes) -replace "-",""
        $envVars["AUTH_SECRET"] = $generated
        if (-not (Test-Path $envLocalFile)) { New-Item $envLocalFile -ItemType File -Force | Out-Null }
        $existingLines = Get-Content $envLocalFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "^AUTH_SECRET=" }
        $existingLines + "AUTH_SECRET=$generated" | Set-Content $envLocalFile
        Write-OK "AUTH_SECRET auto-generated and saved to .env.local"
    }
}

# Check critical values
$authGhId = Get-EnvValue "AUTH_GITHUB_ID" ""
$authGhSecret = Get-EnvValue "AUTH_GITHUB_SECRET" ""
if (-not $authGhId -or -not $authGhSecret) {
    Write-Warn "--------------------------------------------------"
    Write-Warn "GitHub OAuth not fully configured"
    Write-Hint "Create an OAuth App at: https://github.com/settings/developers/new"
    Write-Hint "  Homepage URL: http://localhost:3000"
    Write-Hint "  Callback URL: http://localhost:3000/api/auth/callback/github"
    Write-Hint "Then fill in AUTH_GITHUB_ID and AUTH_GITHUB_SECRET above."
    Write-Warn "--------------------------------------------------"
}

$openaiKey = Get-EnvValue "OPENAI_API_KEY" ""
if (-not $openaiKey) {
    Write-Warn "OPENAI_API_KEY not set — AI summary will be unavailable (Phase 1-4 not affected)"
}

Write-OK "Environment variables check complete"

# Step 6: Prisma
Write-Step "Step 6: Prisma validate & sync ..."

Set-Location $ProjectRoot

Write-Host "  Running prisma validate ..."
$ErrorActionPreference = "Continue"
npx prisma validate *>$null
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = "Stop"
    Write-Err "prisma validate failed"
}
$ErrorActionPreference = "Stop"
Write-OK "prisma validate passed"

Write-Host "  Running prisma db push ..."
$ErrorActionPreference = "Continue"
npx prisma db push *>$null
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = "Stop"
    Write-Err "prisma db push failed"
}
$ErrorActionPreference = "Stop"
Write-OK "prisma db push done"

# Step 7: Check port 3000
Write-Step "Step 7: Checking port 3000 ..."

$port3000 = netstat -ano 2>$null | Select-String ":3000 " | Select-String "LISTENING"
if ($port3000) {
    $pidMatch = [regex]::Match($port3000, '\s+(\d+)\s*$')
    $occupyingPid = if ($pidMatch.Success) { $pidMatch.Groups[1].Value } else { "unknown" }
    Write-Warn "Port 3000 is in use (PID: $occupyingPid)"

    $choice = Read-Host "Kill this process? (y/n)"
    if ($choice -eq "y") {
        Stop-Process -Id $occupyingPid -Force -ErrorAction SilentlyContinue
        Write-OK "Killed PID $occupyingPid"
        Start-Sleep -Seconds 1
    } else {
        Write-Hint "Skipping, startup may fail if port conflict"
    }
} else {
    Write-OK "Port 3000 free"
}

# Step 8: Launch dev server
Write-Step "Step 8: Starting Next.js dev server ..."
Write-Host ""
Write-Host "  Open http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

npm run dev
