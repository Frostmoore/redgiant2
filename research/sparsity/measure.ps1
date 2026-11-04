# TEAL-style sparsity measured with llama.cpp itself (RedGiant G26.6, 2026-11-04).
# For each c: the sparsity really obtained (llama-eval-callback, the masks' sums on a short
# text) and the perplexity on wikitext-2 (llama-perplexity). One JSON line per result in
# measure.log.
param([string]$Model, [string]$Name, [int]$Chunks = 20, [string]$Cs = "0,0.3,0.5,0.7,0.9,1.1")
$d = "C:\Users\Pixel\Desktop\redgiant-test"
$bin = "$d\llama.cpp\build\bin"
$env:PATH = "$d\cuda\bin;$env:PATH"
$log = "$d\measure.log"
$text = "The history of the bicycle spans more than two centuries. Early designs had no pedals and riders pushed along the ground with their feet. Later, cranks were added to the front wheel, and finally the chain drive made the modern safety bicycle possible, with two wheels of equal size."
foreach ($c in ($Cs -split ",")) {
  if ([double]$c -gt 0) { $env:LLAMA_TEAL_C = $c } else { Remove-Item Env:LLAMA_TEAL_C -ErrorAction SilentlyContinue }
  $sparsity = 0.0
  if ([double]$c -gt 0) {
    $out = & "$bin\llama-eval-callback.exe" -m "$d\models\$Model" -p $text -c 512 2>&1 | Out-String
    $kept = 0.0; $total = 0.0
    $ms = [regex]::Matches($out, "teal_mask = \(f32\)[^\n]*= \{(\d+), (\d+), (\d+), (\d+)\}[\s\S]*?sum = ([0-9.eE+-]+)")
    foreach ($m in $ms) {
      $n = [double]$m.Groups[1].Value * [double]$m.Groups[2].Value * [double]$m.Groups[3].Value * [double]$m.Groups[4].Value
      $total += $n; $kept += [double]$m.Groups[5].Value
    }
    if ($total -gt 0) { $sparsity = [math]::Round(1 - $kept / $total, 3) } else { $sparsity = -1 }
  }
  $ppl = & "$bin\llama-perplexity.exe" -m "$d\models\$Model" -f "$d\wikitext\wiki.test.raw" -c 512 --chunks $Chunks 2>&1 | Out-String
  $m = [regex]::Match($ppl, "Final estimate: PPL = ([0-9.]+) \+/- ([0-9.]+)")
  $line = @{ model = $Name; c = [double]$c; sparsity = $sparsity; ppl = $(if ($m.Success) { [double]$m.Groups[1].Value } else { -1 }); err = $(if ($m.Success) { [double]$m.Groups[2].Value } else { -1 }) } | ConvertTo-Json -Compress
  $line | Add-Content $log
  $line
  if (-not $m.Success) { ($ppl -split "`n" | Select-Object -Last 15) -join "`n" | Add-Content "$d\measure-errors.log" }
}
"MEASURE DONE $Name" | Add-Content $log
