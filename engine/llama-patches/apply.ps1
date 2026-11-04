# RedGiant's changes to llama.cpp (G27): run from llama.cpp's source folder, at tag b12034.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$here\llama-teal.h", "$here\llama-teal.cpp" src\
git apply --whitespace=nowarn "$here\0001-redgiant-teal.patch"
if ($LASTEXITCODE -ne 0) { throw "patch failed" }
