# RedGiant G27.1: writing speed with llama-bench (64 tokens, repeated), sparsity off and on,
# rounds interleaved so that whatever else the PC does weighs on all of them alike.
param([string]$Model, [string]$Ngl = "0", [string]$Cs = "off,0,0.27,0.40,0.50", [int]$Rounds = 2, [string]$Slices = "", [string]$Label = "")
$d = "C:\Users\Pixel\Desktop\redgiant-test"
$env:PATH = "$d\cuda\bin;$env:PATH"
$env:LLAMA_TEAL_DIR = "$d\teal"
if ($Slices) { $env:LLAMA_TEAL_SLICES = $Slices } else { Remove-Item Env:LLAMA_TEAL_SLICES -ErrorAction SilentlyContinue }
for ($r = 1; $r -le $Rounds; $r++) {
  foreach ($c in ($Cs -split ",")) {
    if ($c -eq "off") { Remove-Item Env:LLAMA_TEAL_C -ErrorAction SilentlyContinue } else { $env:LLAMA_TEAL_C = $c }
    $out = & "$d\llama.cpp\build\bin\llama-bench.exe" -m "$d\models\$Model" -ngl $Ngl -p 0 -n 64 -r 3 -o json 2>$null | Out-String
    try {
      $j = $out | ConvertFrom-Json
      "{4} {0} c={1} tg={2:N2} +/- {3:N2}" -f $r, $c, $j[0].avg_ts, $j[0].stddev_ts, $Label
    } catch { "{0} c={1} error" -f $r, $c }
  }
}
