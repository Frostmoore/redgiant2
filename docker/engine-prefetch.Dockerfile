# RedGiant local engine for NVIDIA cards with «Next layer ahead» (G32.2): llama.cpp b12034 plus
# RedGiant's patches (engine/llama-patches, apply.sh), built from source with CUDA 12.8. Image
# ghcr.io/frostmoore/redgiant2-engine:cuda-prefetch, used only when the person turns the option on
# (the server passes LLAMA_MOE_PREFETCH=1); without the variable it behaves as the official build.
#   docker build -t ghcr.io/frostmoore/redgiant2-engine:cuda-prefetch -f docker/engine-prefetch.Dockerfile engine
# The context is the `engine` folder (the patches). Defaults: the same as docker/engine.Dockerfile.
ARG CUDA_VERSION=12.8.1
ARG UBUNTU_VERSION=24.04

FROM docker.io/nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS build
ARG LLAMA_BUILD=b12034
# Turing to Blackwell, as the Windows build (release.yml, llama-cuda): "-real" is machine code for
# that family only; 120 also carries PTX for newer cards.
ARG CUDA_ARCHS="75-real;80-real;86-real;89-real;90-real;120"
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake ninja-build git ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${LLAMA_BUILD}" https://github.com/ggml-org/llama.cpp .
COPY llama-patches/ /patches/
RUN sh /patches/apply.sh
# As llama.cpp's own .devops/cuda.Dockerfile: CPU and CUDA backends as modules llama-server loads
# (no card while building: libcuda comes from the NVIDIA runtime when the container starts).
RUN cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_NATIVE=OFF -DGGML_CUDA=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHS}" \
      -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
      -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined \
    && cmake --build build -j"$(nproc)" \
    && mkdir -p /out \
    && find build -name "*.so*" -exec cp -P {} /out \; \
    && cp build/bin/llama-server /out/ \
    && echo "${LLAMA_BUILD} + RedGiant patches (0001 teal, 0002 moe-prefetch), CUDA ${CUDA_VERSION}, ${CUDA_ARCHS}" > /out/build.txt

FROM docker.io/nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /app/
WORKDIR /app
# No card here: it must start and say its version all the same, and carry the patch.
RUN /app/llama-server --version && grep -q LLAMA_MOE_PREFETCH /app/libllama.so

# The same defaults as docker/engine.Dockerfile (a test keeps them equal).
ENV LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    LLAMA_ARG_N_PARALLEL=4 \
    LLAMA_ARG_SWA_FULL=1 \
    LLAMA_ARG_JINJA=1 \
    LLAMA_ARG_KV_UNIFIED=1 \
    LLAMA_ARG_CTX_SIZE=65536
VOLUME ["/kv", "/models"]
HEALTHCHECK CMD [ "curl", "-f", "http://localhost:8080/health" ]
ENTRYPOINT ["/app/llama-server", "--slot-save-path", "/kv"]
