import { describe, expect, it } from "vitest";
import { readGgufMeta } from "../src/index.js";

/** A small GGUF header: the model's keys, then a long tokenizer list that must not be read. */
function gguf(kv: [string, number, unknown][]): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, n, true);
    parts.push(...new Uint8Array(b.buffer));
  };
  const u64 = (n: number) => {
    const b = new DataView(new ArrayBuffer(8));
    b.setBigUint64(0, BigInt(n), true);
    parts.push(...new Uint8Array(b.buffer));
  };
  const str = (s: string) => {
    const e = new TextEncoder().encode(s);
    u64(e.length);
    parts.push(...e);
  };
  parts.push(...new TextEncoder().encode("GGUF"));
  u32(3);
  u64(0);
  u64(kv.length + 1);
  for (const [k, type, v] of kv) {
    str(k);
    u32(type);
    if (type === 4) u32(v as number);
    else if (type === 8) str(v as string);
    else if (type === 9) {
      u32(4);
      u64(3);
      for (const x of v as number[]) u32(x);
    }
  }
  str("tokenizer.ggml.tokens");
  u32(9);
  u32(8);
  u64(1_000_000); // claimed, never there: reading stops before it
  return new Uint8Array(parts);
}

const reader = (b: Uint8Array) => async (offset: number, length: number) =>
  b.subarray(offset, offset + length);

describe("GGUF header (2026-11-03)", () => {
  it("reads a mixture of experts: layers, context, experts and the KV cost of a token", async () => {
    const meta = await readGgufMeta(
      reader(
        gguf([
          ["general.architecture", 8, "qwen3moe"],
          ["general.name", 8, "Qwen3 Coder 30B A3B"],
          ["qwen3moe.block_count", 4, 48],
          ["qwen3moe.context_length", 4, 262144],
          ["qwen3moe.embedding_length", 4, 2048],
          ["qwen3moe.attention.head_count", 4, 32],
          ["qwen3moe.attention.head_count_kv", 4, 4],
          ["qwen3moe.attention.key_length", 4, 128],
          ["qwen3moe.attention.value_length", 4, 128],
          ["qwen3moe.expert_count", 4, 128],
          ["qwen3moe.expert_used_count", 4, 8],
          ["qwen3moe.rope.dimension_sections", 9, [1, 2, 3]],
        ]),
      ),
    );
    expect(meta).toEqual({
      architecture: "qwen3moe",
      name: "Qwen3 Coder 30B A3B",
      layers: 48,
      contextLength: 262144,
      experts: 128,
      expertsUsed: 8,
      // 48 layers × 4 KV heads × (128 + 128) × 2 bytes
      kvBytesPerToken: 98304,
    });
  });

  it("a dense model has no experts; a file that is not GGUF is refused", async () => {
    const meta = await readGgufMeta(
      reader(
        gguf([
          ["general.architecture", 8, "gemma3"],
          ["gemma3.block_count", 4, 48],
          ["gemma3.context_length", 4, 131072],
          ["gemma3.embedding_length", 4, 3840],
          ["gemma3.attention.head_count", 4, 16],
          ["gemma3.attention.head_count_kv", 4, 8],
        ]),
      ),
    );
    expect(meta.experts).toBe(0);
    expect(meta.kvBytesPerToken).toBe(48 * 8 * (240 + 240) * 2);
    await expect(
      readGgufMeta(reader(new TextEncoder().encode("PK\u0003\u0004zip"))),
    ).rejects.toThrow("Not a GGUF file");
  });
});
