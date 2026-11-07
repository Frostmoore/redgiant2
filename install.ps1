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
$Files = @("compose.yaml", "docker/egress.json", "docker/searxng/settings.yml", "docker/postgres.Dockerfile", ".env.example")
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

# 4. Download ------------------------------------------------------------------------------------
# Every download shows a bar with the amount, the speed and the time left: the sizes come from the
# registries, the bytes from Docker Compose's JSON progress. Without it, Compose's own output.
function Get-LayerSizes([string]$Image) {
  $sizes = @{}
  try {
    $tag = "latest"; $name = $Image
    $at = $Image.LastIndexOf(":")
    if ($at -gt $Image.LastIndexOf("/")) { $name = $Image.Substring(0, $at); $tag = $Image.Substring($at + 1) }
    $first = $name.Split("/")[0]
    if ($name.Contains("/") -and ($first.Contains(".") -or $first.Contains(":"))) {
      $registry = $first; $repo = $name.Substring($first.Length + 1)
      $auth = "https://$registry/token?scope=repository:${repo}:pull"
    } else {
      $registry = "registry-1.docker.io"; $repo = if ($name.Contains("/")) { $name } else { "library/$name" }
      $auth = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull"
    }
    $token = (Invoke-RestMethod -UseBasicParsing $auth).token
    $headers = @{
      Authorization = "Bearer $token"
      Accept = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"
    }
    $m = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://$registry/v2/$repo/manifests/$tag"
    if ($m.PSObject.Properties["manifests"]) {
      $own = $m.manifests | Where-Object { $_.platform.os -eq "linux" -and $_.platform.architecture -eq "amd64" } | Select-Object -First 1
      if ($own) { $m = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://$registry/v2/$repo/manifests/$($own.digest)" }
    }
    foreach ($l in $m.layers) { $sizes[$l.digest.Substring(7, 12)] = [int64]$l.size }
  } catch { }
  return $sizes
}
function Save-Images([string[]]$Images) {
  $size = @{}; $got = @{}
  foreach ($img in $Images) { foreach ($k in (Get-LayerSizes $img).GetEnumerator()) { $size[$k.Key] = $k.Value } }
  $total = [int64]0; foreach ($v in $size.Values) { $total += $v }
  # One temporary Compose file with every image, so one pull reports them all.
  $file = Join-Path $env:TEMP "redgiant-pull.yaml"
  $services = ($Images | ForEach-Object -Begin { $i = 0 } -Process { $i++; "  i${i}:`n    image: $_" }) -join "`n"
  Set-Content -Path $file -Value "services:`n$services" -Encoding ascii
  $start = Get-Date; $last = $start; $skipped = [int64]0; $json = $false
  # Compose writes its progress on stderr, which Windows PowerShell would turn into errors.
  $before = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  docker compose -f $file --progress json pull 2>&1 | ForEach-Object {
    $line = "$_"
    if (-not $line.StartsWith("{")) { return }
    $json = $true
    $ev = $line | ConvertFrom-Json
    if (-not $ev.PSObject.Properties["parent_id"]) { return }
    $id = $ev.id
    $layer = if ($size.ContainsKey($id)) { $size[$id] } else { [int64]0 }
    switch ($ev.text) {
      "Downloading" { if ($ev.PSObject.Properties["current"]) { $got[$id] = [int64]$ev.current } }
      "Already exists" { $got[$id] = $layer; $skipped += $layer }
      default { if ($ev.text -in @("Download complete", "Pull complete", "Extracting", "Verifying Checksum")) { $got[$id] = $layer } }
    }
    $now = Get-Date
    if ($total -gt 0 -and ($now - $last).TotalMilliseconds -ge 500) {
      $last = $now
      $done = [int64]0; foreach ($v in $got.Values) { $done += $v }
      if ($done -gt $total) { $done = $total }
      $secs = [Math]::Max(1, ($now - $start).TotalSeconds)
      $speed = ($done - $skipped) / $secs
      $status = "{0:N0} MB of {1:N0} MB" -f ($done / 1MB), ($total / 1MB)
      $left = -1
      if ($speed -gt 0 -and $done -lt $total) {
        $status += " - {0:N1} MB/s" -f ($speed / 1MB)
        $left = [int](($total - $done) / $speed)
      }
      if ($done -ge $total) { $status += " - unpacking" }
      Write-Progress -Activity "Downloading RedGiant" -Status $status -PercentComplete ([int]($done * 100 / $total)) -SecondsRemaining $left
    }
  }
  $ok = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $before
  Write-Progress -Activity "Downloading RedGiant" -Completed
  Remove-Item $file -ErrorAction SilentlyContinue
  if (-not $json) {
    # An older Compose without JSON progress: its own output, layer by layer.
    Set-Content -Path $file -Value "services:`n$services" -Encoding ascii
    docker compose -f $file pull
    $ok = $LASTEXITCODE -eq 0
    Remove-Item $file -ErrorAction SilentlyContinue
  }
  if (-not $ok) { Die "The download did not finish. Check the internet connection and run this again." }
}

# 5. Start --------------------------------------------------------------------------------------
if ($env:REDGIANT_NO_PULL -ne "1") {
  Say "Downloading RedGiant (the first time takes a few minutes)"
  $image = if ($settings.REDGIANT_IMAGE) { $settings.REDGIANT_IMAGE } else { "ghcr.io/frostmoore/redgiant2:latest" }
  $sandbox = if ($settings.REDGIANT_SANDBOX_IMAGE) { $settings.REDGIANT_SANDBOX_IMAGE } else { "ghcr.io/frostmoore/redgiant2-sandbox:latest" }
  $postgres = if ($settings.REDGIANT_POSTGRES_IMAGE) { $settings.REDGIANT_POSTGRES_IMAGE } else { "ghcr.io/frostmoore/redgiant2-postgres:17-pgvector0.8.7" }
  Save-Images @($image, $postgres, $sandbox)
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
