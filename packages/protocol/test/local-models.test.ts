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
    expect(estimatedSpeed(dense, 16, gpu).wordsPerSec).toBeGreaterThan(
      estimatedSpeed(dense, 16, cpu).wordsPerSec * 4,
    );
    expect(estimatedSpeed(moe, 17, cpu).stars).toBeGreaterThan(
      estimatedSpeed(dense, 16, cpu).stars,
    );
    // Too big for the card: about as slow as the processor.
    expect(estimatedSpeed(dense, 30, gpu).stars).toBeLessThanOrEqual(2);
  });
});

describe("speed with SSD stream (2026-11-03)", () => {
  it("is slower when part of the model must come from the SSD at each word", () => {
    const moe = { totalB: 30, activeB: 3 };
    const hw = { kind: "gpu" as const, vramGb: 12, ramGb: 32 };
    const inRam = estimatedSpeed(moe, 17, hw, { stream: true });
    const onSsd = estimatedSpeed(moe, 17, { ...hw, ramGb: 4 }, { stream: true });
    expect(inRam.wordsPerSec).toBeGreaterThan(onSsd.wordsPerSec);
    expect(onSsd.wordsPerSec).toBeGreaterThan(0);
    // Without streaming nothing changes.
    expect(estimatedSpeed(moe, 10, hw)).toEqual(estimatedSpeed(moe, 10, hw, { stream: false }));
  });
});
