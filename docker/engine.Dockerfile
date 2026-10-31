# RedGiant local engine: llama.cpp's server with RedGiant's defaults.
#   docker build --build-arg VARIANT=server-cuda -t redgiant/engine:cuda -f docker/engine.Dockerfile docker
# VARIANT: server (CPU) | server-cuda | server-rocm | server-vulkan  (official llama.cpp images)
ARG VARIANT=server
FROM ghcr.io/ggml-org/llama.cpp:${VARIANT}

# Defaults RedGiant relies on:
#  --slot-save-path /kv   KV caches saved to the SSD (shared with the RedGiant server)
#  --parallel 4           slots shared by agents, scheduled by priority
#  --swa-full             keep sliding-window layers whole, or prefixes beyond the window
#                         are recomputed every turn (Gemma and others)
#  --jinja                the model's own chat template (tool calls, reasoning)
ENV LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    LLAMA_ARG_N_PARALLEL=4 \
    LLAMA_ARG_SWA_FULL=1 \
    LLAMA_ARG_JINJA=1 \
    LLAMA_ARG_CTX_SIZE=32768
VOLUME ["/kv", "/models"]
# --slot-save-path has no environment variable: it is part of the entrypoint, so it can
# never be silently missing. Arguments given to `docker run` (e.g. -m /models/x.gguf) follow.
ENTRYPOINT ["/app/llama-server", "--slot-save-path", "/kv"]
