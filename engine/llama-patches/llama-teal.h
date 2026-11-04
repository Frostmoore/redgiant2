#pragma once
// RedGiant (G27, 2026-11-04): activation sparsity for the weights in RAM (see llama-teal.cpp).

#include "ggml.h"

struct llama_model;

// Prepares the copies by columns of the model's weights in RAM, when LLAMA_TEAL_C is set:
// made once into LLAMA_TEAL_DIR, then mapped. Called when a context starts, before its graphs.
void llama_teal_init(const llama_model & model, int n_threads);

// The product w x through the copy by columns, when it applies (sparsity on, a weight in RAM,
// one token); nullptr otherwise, and the caller does the usual product.
ggml_tensor * llama_teal_mul_mat(ggml_context * ctx, ggml_tensor * w, ggml_tensor * cur);
