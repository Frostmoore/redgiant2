# CUDA's compiler and libraries for building llama.cpp on Windows (G32.2), without NVIDIA's
# installer: the redistributable archives of one CUDA release, each checked against the sha256
# its redistrib_<version>.json lists, unpacked together into one folder (bin, include, lib).
#
#   pwsh cuda-redist.ps1 -Out C:\cuda [-Version 12.8.1]
#
# In CUDA 12.8 the compiler's archive (cuda_nvcc) carries nvvm and crt itself.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Version = "12.8.1",
  [string[]]$Components = @("cuda_nvcc", "cuda_cudart", "cuda_cccl", "libcublas", "cuda_profiler_api", "cuda_nvtx")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$base = "https://developer.download.nvidia.com/compute/cuda/redist"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "cuda-redist-$Version"
New-Item -ItemType Directory -Force $work, $Out | Out-Null
$manifest = Invoke-RestMethod "$base/redistrib_$Version.json"
foreach ($name in $Components) {
  $entry = $manifest.$name.'windows-x86_64'
  if (-not $entry) { throw "$name has no windows-x86_64 archive in CUDA $Version" }
  $zip = Join-Path $work (Split-Path -Leaf $entry.relative_path)
  if (-not (Test-Path $zip) -or (Get-FileHash -Algorithm SHA256 $zip).Hash -ne $entry.sha256.ToUpper()) {
    Invoke-WebRequest "$base/$($entry.relative_path)" -OutFile $zip
  }
  $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash
  if ($hash -ne $entry.sha256.ToUpper()) { throw "$name`: sha256 $hash, expected $($entry.sha256)" }
  $dir = Join-Path $work $name
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  Expand-Archive $zip -DestinationPath $dir
  # Each archive has one folder (<name>-windows-x86_64-<version>-archive) with bin, include, lib…
  $top = Get-ChildItem $dir -Directory | Select-Object -First 1
  # Merged with the others' folders (robocopy: below 8 is success).
  robocopy $top.FullName $Out /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copying $name failed ($LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
  "{0} {1} ({2:N0} MB)" -f $name, $manifest.$name.version, ((Get-Item $zip).Length / 1MB)
}
Remove-Item -Recurse -Force $work
