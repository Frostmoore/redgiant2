#!/bin/sh
# RedGiant's changes to llama.cpp (G27, G32.2): run from llama.cpp's source folder, at tag b12034.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cp "$here/llama-teal.h" "$here/llama-teal.cpp" "$here/llama-moe-prefetch.h" "$here/llama-moe-prefetch.cpp" src/
git apply --whitespace=nowarn "$here/0001-redgiant-teal.patch"
git apply --whitespace=nowarn "$here/0002-redgiant-moe-prefetch.patch"
