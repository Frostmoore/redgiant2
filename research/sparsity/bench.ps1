# Speculative decoding measured on this PC (RedGiant G26.8, 2026-11-04). Everything stays in
# this folder: llama.cpp b12034 (CUDA) in bin\, the models in models\, the results in bench.json.
param([string]$Only = "")
$d = "C:\Users\Pixel\Desktop\redgiant-test"
$exe = "$d\bin\llama-server.exe"
$port = 18090
$prose = "Write a detailed explanation, about 300 words, of how a refrigerator works, for a curious teenager."
$code = @"
Here is a Python function. Rewrite it exactly, changing only the variable name 'items' to 'products' everywhere, and keep every other line identical.

def total_price(items, tax_rate):
    subtotal = 0
    for item in items:
        if item.get('quantity', 0) <= 0:
            continue
        price = item['price'] * item['quantity']
        if item.get('discount'):
            price = price * (1 - item['discount'])
        subtotal += price
    tax = subtotal * tax_rate
    shipping = 0 if subtotal > 50 else 5.99
    summary = {'items': len(items), 'subtotal': round(subtotal, 2), 'tax': round(tax, 2), 'shipping': shipping}
    summary['total'] = round(subtotal + tax + shipping, 2)
    return summary
"@
$runs = @(
  @{ name = "qwen3-14b";            model = "Qwen3-14B-Q4_K_M.gguf";            extra = @() },
  @{ name = "qwen3-14b+draft";      model = "Qwen3-14B-Q4_K_M.gguf";            extra = @("--spec-type","draft-simple","-md","$d\models\Qwen3-0.6B-Q8_0.gguf","-ngld","99","--spec-draft-n-max","8") },
  @{ name = "qwen3-14b+draft-p75";  model = "Qwen3-14B-Q4_K_M.gguf";            extra = @("--spec-type","draft-simple","-md","$d\models\Qwen3-0.6B-Q8_0.gguf","-ngld","99","--spec-draft-n-max","8","--spec-draft-p-min","0.75") },
  @{ name = "qwen3-14b+ngram";      model = "Qwen3-14B-Q4_K_M.gguf";            extra = @("--spec-type","ngram-mod") },
  @{ name = "llama-3.3-70b";        model = "Llama-3.3-70B-Instruct-Q4_K_M.gguf"; extra = @() },
  @{ name = "llama-3.3-70b+draft";  model = "Llama-3.3-70B-Instruct-Q4_K_M.gguf"; extra = @("--spec-type","draft-simple","-md","$d\models\Llama-3.2-1B-Instruct-Q8_0.gguf","-ngld","99","--spec-draft-n-max","8") },
  @{ name = "llama-3.3-70b+draft-p75"; model = "Llama-3.3-70B-Instruct-Q4_K_M.gguf"; extra = @("--spec-type","draft-simple","-md","$d\models\Llama-3.2-1B-Instruct-Q8_0.gguf","-ngld","99","--spec-draft-n-max","8","--spec-draft-p-min","0.75") },
  @{ name = "llama-3.3-70b+ngram";  model = "Llama-3.3-70B-Instruct-Q4_K_M.gguf"; extra = @("--spec-type","ngram-mod") }
)
$results = @()
foreach ($r in $runs) {
  if ($Only -and -not $r.name.StartsWith($Only)) { continue }
  $args = @("-m", "$d\models\$($r.model)", "--host", "127.0.0.1", "--port", "$port", "-c", "8192", "--parallel", "1", "--jinja") + $r.extra
  $p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory "$d\bin" -PassThru -WindowStyle Hidden -RedirectStandardError "$d\server-$($r.name).log"
  $ok = $false
  for ($i = 0; $i -lt 600; $i++) {
    Start-Sleep -Seconds 1
    try { $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; if ($h.status -eq "ok") { $ok = $true; break } } catch {}
    if ($p.HasExited) { break }
  }
  foreach ($kind in @("prose", "code")) {
    if (-not $ok) { $results += @{ run = $r.name; prompt = $kind; error = "did not start" }; continue }
    $text = if ($kind -eq "prose") { $prose } else { $code }
    $body = @{ messages = @(@{ role = "user"; content = $text }); max_tokens = 320; temperature = 0; chat_template_kwargs = @{ enable_thinking = $false } } | ConvertTo-Json -Depth 5
    try {
      # Warmed up with another question: the same one would teach the n-grams the answer.
      $warm = @{ messages = @(@{ role = "user"; content = "Name three rivers in Europe." }); max_tokens = 32; temperature = 0; chat_template_kwargs = @{ enable_thinking = $false } } | ConvertTo-Json -Depth 5
      Invoke-RestMethod "http://127.0.0.1:$port/v1/chat/completions" -Method Post -ContentType "application/json" -Body $warm -TimeoutSec 900 | Out-Null
      $res = Invoke-RestMethod "http://127.0.0.1:$port/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 900
      $t = $res.timings
      $results += @{ run = $r.name; prompt = $kind; gen_tps = [math]::Round($t.predicted_per_second, 1); tokens = $t.predicted_n; draft_n = $t.draft_n; draft_accepted = $t.draft_n_accepted }
    } catch { $results += @{ run = $r.name; prompt = $kind; error = "$_" } }
    $results[-1] | ConvertTo-Json -Compress | Tee-Object -FilePath "$d\bench.log" -Append | Write-Output
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
$results | ConvertTo-Json -Depth 4 | Set-Content "$d\bench.json"
"BENCH DONE"
