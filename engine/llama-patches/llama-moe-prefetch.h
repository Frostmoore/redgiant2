#pragma once

// RedGiant (G32.2): experts kept in host memory (--cpu-moe) are copied to the card at every
// ubatch, on the compute stream, so the card waits for each copy. With LLAMA_MOE_PREFETCH=1,
// while the card computes one tensor of experts, the tensor predicted next (the next one in the
// layer, or the first one of the next layer) is uploaded on a second stream into one of two
// device slots; when its turn comes it is copied from the slot (device to device). Only for
// ubatches that use at least half of the experts (real routers leave a few out even with
// thousands of tokens), so generation is unchanged. Off by default.

#include "ggml-backend.h"

#include <memory>

struct llama_model;

class llama_moe_prefetch {
public:
    // nullptr when the prefetch cannot run (no events, no memory, no experts in host memory)
    static std::unique_ptr<llama_moe_prefetch> create(const llama_model & model, ggml_backend_t backend);

    ~llama_moe_prefetch();

    // Called for a host tensor of experts that the ubatch mostly uses: true if dst was filled from a
    // slot, false if the caller must upload it. Either way the upload of the next tensor starts.
    bool copy(ggml_backend_t backend, const ggml_tensor * src, ggml_tensor * dst);

    struct impl;

private:
    explicit llama_moe_prefetch(std::unique_ptr<impl> pimpl);

    std::unique_ptr<impl> pimpl;
};

// true when LLAMA_MOE_PREFETCH=1
bool llama_moe_prefetch_requested();
