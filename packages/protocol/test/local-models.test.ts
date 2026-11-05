import { describe, expect, it } from "vitest";
import { estimatedSpeed, LOCAL_MODELS } from "../src/index.js";

describe("local models compared (2026-11-03)", () => {
  it("scores every model from 1 to 5", () => {
    for (const m of LOCAL_MODELS)
      for (const v of Object.values(m.scores)) expect(v >= 1 && v <= 5).toBe(true);
  });

  it("is faster inside the graphics card than on the processor, and faster with few active parameters", () => {
    const dense = { totalB: 27, activeB: 27 };
    const moe = { totalB: 30, activeB: 3 };
    const gpu = { kind: "gpu", vramGb: 24 } as const;
    const cpu = { kind: "cpu", vramGb: 0 } as const;
    expect(estimatedSpeed(dense, 16, gpu).tokensPerSec).toBeGreaterThan(
      estimatedSpeed(dense, 16, cpu).tokensPerSec * 4,
    );
    expect(estimatedSpeed(moe, 17, cpu).stars).toBeGreaterThan(
      estimatedSpeed(dense, 16, cpu).stars,
    );
    // Too big for the card: about as slow as the processor.
    expect(estimatedSpeed(dense, 30, gpu).stars).toBeLessThanOrEqual(2);
  });
});

describe("speed by where the model sits (2026-11-04)", () => {
  const hw = { kind: "gpu" as const, vramGb: 16, ramGb: 30 };
  it("matches what was measured: Qwen3 Next 80B A3B on a 16 GB card", () => {
    const next = estimatedSpeed({ totalB: 80, activeB: 3 }, 39.7, hw).tokensPerSec;
    expect(next).toBeGreaterThanOrEqual(18);
    expect(next).toBeLessThanOrEqual(30);
  });

  it("says a range for a mixture of experts beyond memory, with what was measured inside it (2026-11-05)", () => {
    // Rig, RTX 4080 Super 16 GB. gpt-oss 120B (58 GB, about 27 GB of RAM free): 13-15 tokens/s.
    const gptOss = estimatedSpeed({ totalB: 117, activeB: 5.1 }, 58, { ...hw, ramGb: 27 });
    // GLM-4.5 Air Q4_K_S (62.4 GB, 46 GB free): 1.3-3.2 tokens/s; one number said 4.
    const glm = estimatedSpeed({ totalB: 106, activeB: 12 }, 62.4, { ...hw, ramGb: 46.3 });
    const [gLow, gHigh] = gptOss.range ?? [0, 0];
    const [lLow, lHigh] = glm.range ?? [0, 0];
    expect(gLow).toBeLessThan(gHigh);
    expect(gHigh).toBeGreaterThanOrEqual(13);
    expect(lLow).toBeLessThanOrEqual(3);
    expect(lHigh).toBeGreaterThanOrEqual(3);
    // All of it in memory: one number, no range.
    expect(
      estimatedSpeed({ totalB: 30, activeB: 3 }, 17, { ...hw, ramGb: 64 }).range,
    ).toBeUndefined();
  });

  it("is slower when part of the model must come from the SSD at each token", () => {
    const moe = { totalB: 117, activeB: 5.1 };
    const inRam = estimatedSpeed(moe, 58, { ...hw, ramGb: 64 });
    const onSsd = estimatedSpeed(moe, 58, hw);
    expect(inRam.tokensPerSec).toBeGreaterThan(onSsd.tokensPerSec);
    expect(onSsd.tokensPerSec).toBeGreaterThan(0);
  });
});
