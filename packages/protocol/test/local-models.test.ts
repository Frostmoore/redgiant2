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

  it("is slower when part of the model must come from the SSD at each token", () => {
    const moe = { totalB: 117, activeB: 5.1 };
    const inRam = estimatedSpeed(moe, 58, { ...hw, ramGb: 64 });
    const onSsd = estimatedSpeed(moe, 58, hw);
    expect(inRam.tokensPerSec).toBeGreaterThan(onSsd.tokensPerSec);
    expect(onSsd.tokensPerSec).toBeGreaterThan(0);
  });
});
