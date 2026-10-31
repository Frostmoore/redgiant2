# RedGiant installer for Windows (PowerShell 5.1 or 7).
#   irm https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.ps1 | iex
# or double-click install.cmd in a copy of the repository.
# Environment: REDGIANT_HOME (default %USERPROFILE%\redgiant), REDGIANT_REF (default main),
# REDGIANT_IMAGE / REDGIANT_SANDBOX_IMAGE, REDGIANT_PORT (default 7600), REDGIANT_YES=1,
# REDGIANT_NO_PULL=1, REDGIANT_NO_BROWSER=1.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$HomeDir = if ($env:REDGIANT_HOME) { $env:REDGIANT_HOME } else { Join-Path $env:USERPROFILE "redgiant" }
$Ref = if ($env:REDGIANT_REF) { $env:REDGIANT_REF } else { "main" }
$Raw = "https://raw.githubusercontent.com/Frostmoore/redgiant2/$Ref"
$Port = if ($env:REDGIANT_PORT) { $env:REDGIANT_PORT } else { "7600" }
$Files = @("compose.yaml", "docker/egress.json", "docker/searxng/settings.yml", ".env.example")
$Yes = $env:REDGIANT_YES -eq "1"

function Say([string]$Text) { Write-Host "> $Text" -ForegroundColor Red }
function Die([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; exit 1 }
function Ask([string]$Question) {
  if ($Yes) { return $true }
  $answer = Read-Host "$Question [y/N]"
  return $answer -match "^[YySs]"
}
function New-Secret([int]$Length) {
  $chars = [char[]]"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $bytes = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
function Test-Docker {
  try { docker info *> $null; return $LASTEXITCODE -eq 0 } catch { return $false }
}

# 1. WSL 2 and Docker Desktop -------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say "Docker Desktop is not installed (RedGiant runs in Docker, on WSL 2)."
  $wsl = $false
  try { wsl --status *> $null; $wsl = $LASTEXITCODE -eq 0 } catch {}
  if (-not $wsl) {
    if (-not (Ask "Install WSL 2 now (needs administrator rights and a restart)?")) {
      Die "RedGiant needs WSL 2: https://learn.microsoft.com/windows/wsl/install"
    }
    Start-Process -Verb RunAs -Wait wsl -ArgumentList "--install", "--no-distribution"
    Say "Restart Windows, then run this installer again."
    exit 0
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ then run this again."
  }
  if (-not (Ask "Install Docker Desktop now with winget?")) {
    Die "RedGiant needs Docker Desktop: https://www.docker.com/products/docker-desktop/"
  }
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
if (-not (Test-Docker)) {
  $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $desktop) {
    Say "Starting Docker Desktop (the first start takes a minute; accept its terms if it asks)"
    Start-Process $desktop
    for ($i = 0; $i -lt 90 -and -not (Test-Docker); $i++) { Start-Sleep -Seconds 2 }
  }
  if (-not (Test-Docker)) { Die "Docker is not running. Start Docker Desktop and run this again." }
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die "Docker Compose v2 is missing: update Docker Desktop." }
$api = docker version --format "{{.Server.APIVersion}}"
$v = $api.Split(".")
if ([int]$v[0] -lt 1 -or ([int]$v[0] -eq 1 -and [int]$v[1] -lt 45)) {
  Die "Docker is too old (API $api): update Docker Desktop."
}

# 2. Files --------------------------------------------------------------------------------------
Say "Installing RedGiant in $HomeDir"
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir "docker\searxng") | Out-Null
$here = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
foreach ($f in $Files) {
  $target = Join-Path $HomeDir $f
  $local = if ($here) { Join-Path $here $f } else { "" }
  if ($local -and (Test-Path $local) -and ((Resolve-Path $here).Path -ne (Resolve-Path $HomeDir).Path)) {
    Copy-Item $local $target -Force
  } else {
    Invoke-WebRequest -UseBasicParsing "$Raw/$f" -OutFile $target
  }
}
Set-Location $HomeDir

# 3. Settings -----------------------------------------------------------------------------------
$envFile = Join-Path $HomeDir ".env"
if (-not (Test-Path $envFile)) {
  $lines = Get-Content (Join-Path $HomeDir ".env.example")
  $values = @{
    REDGIANT_TOKEN    = New-Secret 40
    POSTGRES_PASSWORD = New-Secret 32
    REDGIANT_PORT     = $Port
  }
  if ($env:REDGIANT_IMAGE) { $values.REDGIANT_IMAGE = $env:REDGIANT_IMAGE }
  if ($env:REDGIANT_SANDBOX_IMAGE) { $values.REDGIANT_SANDBOX_IMAGE = $env:REDGIANT_SANDBOX_IMAGE }
  if (-not $Yes) {
    $key = Read-Host "Anthropic API key (Enter to skip; you can add it later in .env)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($key))
    if ($plain) { $values.ANTHROPIC_API_KEY = $plain }
  }
  $seen = @{}
  $out = foreach ($line in $lines) {
    $k = ($line -split "=", 2)[0]
    if ($values.ContainsKey($k)) { $seen[$k] = $true; "$k=$($values[$k])" } else { $line }
  }
  $out += foreach ($k in $values.Keys) { if (-not $seen.ContainsKey($k)) { "$k=$($values[$k])" } }
  # UTF-8 without BOM, LF line ends: Docker Compose reads it as written.
  [IO.File]::WriteAllText($envFile, (($out -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
  # Only this user may read it: it holds the token and the keys.
  icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  Say "Settings written to $envFile (keep it private: it holds your token)"
} else {
  Say "Keeping the existing settings in $envFile"
}
$settings = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match "^([A-Z_]+)=(.*)$") { $settings[$Matches[1]] = $Matches[2] }
}
$token = $settings.REDGIANT_TOKEN
if ($settings.REDGIANT_PORT) { $Port = $settings.REDGIANT_PORT }

# 4. Start --------------------------------------------------------------------------------------
if ($env:REDGIANT_NO_PULL -ne "1") {
  Say "Downloading the images (the first time takes a few minutes)"
  docker compose pull --quiet redgiant egress postgres
  $sandbox = if ($settings.REDGIANT_SANDBOX_IMAGE) { $settings.REDGIANT_SANDBOX_IMAGE } else { "ghcr.io/frostmoore/redgiant2-sandbox:latest" }
  docker pull --quiet $sandbox | Out-Null
}
Say "Starting RedGiant"
docker compose up -d
if ($LASTEXITCODE -ne 0) { Die "docker compose up failed." }

$url = "http://127.0.0.1:$Port"
$up = $false
for ($i = 0; $i -lt 120 -and -not $up; $i++) {
  try { $up = (Invoke-WebRequest -UseBasicParsing "$url/api/health" -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 3 }
}
if (-not $up) { Die "RedGiant did not come up. See: cd $HomeDir; docker compose logs redgiant" }

Say "RedGiant is running: $url"
Write-Host "   Your token (also in $envFile): $token"
Write-Host "   Stop: cd $HomeDir; docker compose down    Update: run this installer again"
# The token travels after '#': it never reaches any server, only the page.
if ($env:REDGIANT_NO_BROWSER -ne "1") { Start-Process "$url/#token=$token" }
