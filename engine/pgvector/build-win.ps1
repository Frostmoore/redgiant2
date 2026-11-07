# pgvector for the embedded Postgres on Windows x64 (G36.1). Headers and postgres.lib come from
# EDB's official zip of the same Postgres (18.6: only include/ and lib/postgres.lib are used, the
# rest is thrown away); pgvector from its release tag; MSVC through vcvars64 (Visual Studio 2022 or
# its Build Tools). No installation: everything stays in the work folder.
#
#   pwsh engine/pgvector/build-win.ps1 -Out out [-Work work] [-EdbZip <already downloaded zip>]
#
# Output: <Out>\pgvector-<ver>-pg<major>-windows-x64.zip (lib\, share\extension\) and .sha256.
param(
  [string]$Out = "out",
  [string]$Work = "",
  [string]$EdbZip = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$here = $PSScriptRoot
$vars = @{}
Get-Content "$here\versions.env" | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object {
  $null = $_ -match '^\s*([A-Z_]+)=(.*)$'; $vars[$Matches[1]] = $Matches[2].Trim()
}
$pv = $vars.PGVECTOR_VERSION
$pg = $vars.PG_VERSION
$major = $pg.Split(".")[0]
$name = "pgvector-$pv-pg$major-windows-x64"
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
if (-not $Work) { $Work = Join-Path ([IO.Path]::GetTempPath()) "pgvector-build-$pv" }
New-Item -ItemType Directory -Force $Work | Out-Null
$Work = (Resolve-Path $Work).Path

# Postgres' headers and import library (EDB, "binaries" zip of the same version).
$pgroot = Join-Path $Work "edb\pgsql"
if (-not (Test-Path "$pgroot\include\server\postgres.h")) {
  if (-not $EdbZip) {
    $EdbZip = Join-Path $Work "postgresql-$pg-1-windows-x64-binaries.zip"
    if (-not (Test-Path $EdbZip)) {
      Write-Host "Downloading EDB Postgres $pg binaries (headers and postgres.lib only are kept)"
      Invoke-WebRequest "https://get.enterprisedb.com/postgresql/postgresql-$pg-1-windows-x64-binaries.zip" -OutFile $EdbZip
    }
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($EdbZip)
  try {
    foreach ($e in $zip.Entries) {
      $n = $e.FullName.Replace("\", "/")
      if (($n.StartsWith("pgsql/include/") -or $n -eq "pgsql/lib/postgres.lib") -and -not $n.EndsWith("/")) {
        $dest = Join-Path (Join-Path $Work "edb") $n
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      }
    }
  } finally { $zip.Dispose() }
}

# pgvector's source at its tag.
$src = Join-Path $Work "pgvector-$pv"
if (-not (Test-Path "$src\Makefile.win")) {
  $tgz = Join-Path $Work "pgvector-$pv.tar.gz"
  Invoke-WebRequest "https://github.com/pgvector/pgvector/archive/refs/tags/v$pv.tar.gz" -OutFile $tgz
  tar -xzf $tgz -C $Work
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
}

# MSVC: the newest Visual Studio (or Build Tools) with the C++ tools.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Visual Studio with the C++ tools not found" }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
$log = Join-Path $Work "nmake.log"
cmd /c "call `"$vcvars`" >nul && cd /d `"$src`" && set PGROOT=$pgroot&& nmake /nologo /F Makefile.win clean >nul 2>&1 & nmake /nologo /F Makefile.win" *> $log
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$src\vector.dll")) { Get-Content $log -Tail 40; throw "nmake failed" }

$stage = Join-Path $Work $name
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\lib", "$stage\share\extension" | Out-Null
Copy-Item "$src\vector.dll" "$stage\lib\"
Copy-Item "$src\vector.control" "$stage\share\extension\"
Copy-Item "$src\sql\vector--*.sql" "$stage\share\extension\"
# CREATE EXTENSION needs the install script nmake wrote, for the version the control file names.
if (-not (Test-Path "$stage\share\extension\vector--$pv.sql")) { throw "vector--$pv.sql missing" }
$zipPath = Join-Path $Out "$name.zip"
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
# Windows' own bsdtar writes zip entries with forward slashes.
Push-Location $stage
try { tar -a -cf $zipPath lib share; if ($LASTEXITCODE -ne 0) { throw "zip failed" } } finally { Pop-Location }
$hash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
"$hash  $name.zip" | Set-Content -NoNewline -Encoding ascii "$zipPath.sha256"
"vector.dll {0:N0} bytes" -f (Get-Item "$stage\lib\vector.dll").Length
"$hash  $name.zip"
