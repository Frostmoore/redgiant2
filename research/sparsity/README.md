# Activation sparsity and speculative decoding, measured (G26.6 / G26.8, 2026-11-04)

Research only: nothing here ships with RedGiant.

- `teal.py`: TEAL-style sparsity and hot-neuron concentration on small Hugging Face models, on a
  CPU (image `python:3.12-slim`, `pip install torch transformers pyarrow huggingface_hub`).
- `llama-teal-b12034.patch`: llama.cpp b12034 with a measuring switch. `LLAMA_TEAL_C=c` sets to
  zero every layer's matmul input below c times the token's mean magnitude (`teal_mask` tensors,
  counted with `llama-eval-callback`); the graph gets room for the extra nodes. It reads every
  weight anyway: quality only, no speed.
- `measure.ps1`: the sparsity obtained and the wikitext-2 perplexity for several c (Windows, CUDA).
- `bench.ps1`: speculative decoding (draft model, threshold, n-grams) with llama-server.

## Results (RTX 4080 Super, 64 GB RAM)

Perplexity change with the sparsity obtained (wikitext-2, 512-token chunks):

| sparsity | Qwen3 14B Q4_K_M | Llama 3.3 70B Q4_K_M |
| -------- | ---------------- | -------------------- |
| 0 %      | 8.16             | 3.49                 |
| ~28 %    | +0.4 %           | +4.9 %               |
| ~41 %    | +2.6 %           | +23 %                |
| ~47 %    | +5.2 %           | +41 %                |
| ~52 %    | +6.7 %           | +62 %                |
| ~57 %    | +13 %            | +87 %                |
| ~60 %    | +20 %            | +118 %               |

On small models (CPU, `teal.py`): Qwen3 1.7B +3.9 % at 40 %, Llama 3.2 1B +43 % at 40 %. Hot
neurons in the down projection: 69-72 % of them carry 80 % of the activity (80 % if random), so
a fixed hot set (PowerInfer) does not pay on SwiGLU models.

Speculative decoding (tokens/s, new prose / code rewritten): Qwen3 14B 61/59 alone, 56/155 with
Qwen3 0.6B and `--spec-draft-p-min 0.75`; Llama 3.3 70B 1.1/1.1 alone, 2.6/7.4 with Llama 3.2 1B.

Conclusion: tolerated sparsity depends on the family (Qwen about 47 %, Llama 3 about 25 % for a
5 % loss); a real speed-up needs a column-skipping kernel in llama.cpp. Parked; speculative
decoding is what RedGiant offers for large dense models.
