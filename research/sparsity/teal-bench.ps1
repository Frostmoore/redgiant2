# RedGiant G27.1: llama-server built with the sparsity patch, with and without it. One JSON
# line per run in teal-bench.log: tokens/s writing, and the start of the answer (temperature 0).
param([string]$Model, [string]$Name, [string]$Ngl = "", [string]$Cs = "off,0,0.27,0.40,0.50", [int]$Tokens = 200, [string]$Threads = "")
$d = "C:\Users\Pixel\Desktop\redgiant-test"
$exe = "$d\llama.cpp\build\bin\llama-server.exe"
$env:PATH = "$d\cuda\bin;$env:PATH"
$env:LLAMA_TEAL_DIR = "$d\teal"
New-Item -ItemType Directory -Force $env:LLAMA_TEAL_DIR | Out-Null
$port = 18091
$prompt = "Explain how a refrigerator works to a curious teenager, in about 150 words."
foreach ($c in ($Cs -split ",")) {
  if ($c -eq "off") { Remove-Item Env:LLAMA_TEAL_C -ErrorAction SilentlyContinue } else { $env:LLAMA_TEAL_C = $c }
  $args = @("-m", "$d\models\$Model", "--host", "127.0.0.1", "--port", "$port", "-c", "4096", "--parallel", "1", "--jinja")
  if ($Ngl) { $args += @("-ngl", $Ngl) }
  if ($Threads) { $args += @("-t", $Threads) }
  $started = Get-Date
  $p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory "$d\llama.cpp\build\bin" -PassThru -WindowStyle Hidden -RedirectStandardError "$d\teal-server-$Name-$c.log"
  $ok = $false
  for ($i = 0; $i -lt 3600; $i++) {
    Start-Sleep -Seconds 1
    try { $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; if ($h.status -eq "ok") { $ok = $true; break } } catch {}
    if ($p.HasExited) { break }
  }
  $load = [math]::Round(((Get-Date) - $started).TotalSeconds)
  $line = @{ model = $Name; c = $c; load_s = $load }
  if ($ok) {
    $body = @{ messages = @(@{ role = "user"; content = $prompt }); max_tokens = $Tokens; temperature = 0; chat_template_kwargs = @{ enable_thinking = $false } } | ConvertTo-Json -Depth 5
    try {
      $warm = @{ messages = @(@{ role = "user"; content = "Name three rivers in Europe." }); max_tokens = 16; temperature = 0; chat_template_kwargs = @{ enable_thinking = $false } } | ConvertTo-Json -Depth 5
      Invoke-RestMethod "http://127.0.0.1:$port/v1/chat/completions" -Method Post -ContentType "application/json" -Body $warm -TimeoutSec 1800 | Out-Null
      $res = Invoke-RestMethod "http://127.0.0.1:$port/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 1800
      $line.gen_tps = [math]::Round($res.timings.predicted_per_second, 2)
      $line.text = $res.choices[0].message.content.Substring(0, [math]::Min(160, $res.choices[0].message.content.Length))
    } catch { $line.error = "$_" }
  } else { $line.error = "did not start" }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $json = $line | ConvertTo-Json -Compress
  $json | Add-Content "$d\teal-bench.log"
  $json
}
