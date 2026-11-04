import { describe, expect, it } from "vitest";
import { streamPlan } from "../src/stream.js";

const qwenCoder = {
  architecture: "qwen3moe",
  layers: 48,
  contextLength: 262144,
  experts: 128,
  expertsUsed: 8,
  kvBytesPerToken: 98304,
};
const gemma12 = {
  architecture: "gemma4",
  layers: 48,
  contextLength: 262144,
  experts: 0,
  expertsUsed: 0,
  kvBytesPerToken: 1572864,
};

describe("SSD stream plan (2026-11-03)", () => {
  it("a mixture of experts on a 12 GB card: experts out, a cache for them, a long context", () => {
    const p = streamPlan(qwenCoder, 17.3, { kind: "gpu", vramGb: 12, ramGb: 32 });
    expect(p.args.slice(0, 2)).toEqual(["--cpu-moe", "--moe-cache-mib"]);
    expect(p.args).toContain("q8_0");
    expect(p.moeCacheMib).toBeGreaterThan(2000);
    // Far beyond 65536: the experts left the card to the context.
    // (a GB of the card goes to the long reading passes, 2026-11-04)
    expect(p.ctx).toBeGreaterThanOrEqual(98304);
    expect(p.ctx).toBeLessThanOrEqual(262144);
    expect(p.ctx % 4096).toBe(0);
    // 17 GB in 32 GB of RAM: nothing read from the SSD at each word.
    expect(p).toMatchObject({ source: "ram", ssdGbPerWord: 0, fit: true, ramGb: 32 });
  });

  it("the same model with 12 GB of RAM free reads part of it from the SSD", () => {
    const p = streamPlan(qwenCoder, 17.3, { kind: "gpu", vramGb: 12, ramGb: 12 });
    expect(p.source).toBe("ssd");
    expect(p.ssdGbPerWord).toBeGreaterThan(0);
    expect(p.ssdGbPerWord).toBeLessThan(2);
  });

  it("a dense model: no expert flags, the context bounded by what a token costs", () => {
    const p = streamPlan(gemma12, 7.3, { kind: "gpu", vramGb: 12, ramGb: 32 });
    expect(p.args).not.toContain("--cpu-moe");
    expect(p.moeCacheMib).toBe(0);
    // 6 GB for keys and values at 8 bits, 0.8 MB a token: about 7.6k, at least 16k.
    expect(p.ctx).toBe(16384);
  });

  it("a larger cache share for the experts leaves less context", () => {
    const hw = { kind: "gpu", vramGb: 24, ramGb: 64 } as const;
    const a = streamPlan(qwenCoder, 17.3, hw, { moeCacheShare: 0.2 });
    const b = streamPlan(qwenCoder, 17.3, hw, { moeCacheShare: 0.7 });
    expect(b.moeCacheMib).toBeGreaterThan(a.moeCacheMib);
    expect(b.ctx).toBeLessThanOrEqual(a.ctx);
  });

  it("no graphics card: the context lives in RAM", () => {
    const p = streamPlan(qwenCoder, 17.3, { kind: "cpu", vramGb: 0, ramGb: 32 });
    expect(p.moeCacheMib).toBe(0);
    expect(p.ctx).toBeGreaterThan(65536);
  });
});
