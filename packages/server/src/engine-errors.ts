// Why the local engine did not start, in codes the UI explains (G24.3).

/** Why the engine could not start, from what llama.cpp or Docker said; undefined if unknown. */
export function engineError(text: string): string | undefined {
  if (
    /out of memory|failed to allocate|cudaMalloc failed|ErrorOutOfDeviceMemory|unable to allocate|not enough memory/i.test(
      text,
    )
  )
    return "out_of_memory";
  if (
    /could not select device driver|no CUDA-capable device|no usable GPU|ggml_vulkan: No devices|Failed to initialize Vulkan|error gathering device information|\/dev\/dri.*(no such file|not found)/i.test(
      text,
    )
  )
    return "no_gpu";
  if (
    /failed to load model|invalid magic|unknown model architecture|error loading model|gguf_init_from_file/i.test(
      text,
    )
  )
    return "bad_model";
  if (/no such file or directory|failed to open/i.test(text)) return "model_missing";
  return undefined;
}
