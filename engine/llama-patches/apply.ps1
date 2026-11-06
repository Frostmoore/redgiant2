# RedGiant's changes to llama.cpp (G27, G32.2): run from llama.cpp's source folder, at tag b12034.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$here\llama-teal.h", "$here\llama-teal.cpp", "$here\llama-moe-prefetch.h", "$here\llama-moe-prefetch.cpp" src\
foreach ($p in "0001-redgiant-teal.patch", "0002-redgiant-moe-prefetch.patch") {
  git apply --whitespace=nowarn "$here\$p"
  if ($LASTEXITCODE -ne 0) { throw "patch $p failed" }
}
