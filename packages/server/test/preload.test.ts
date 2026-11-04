import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelGb, modelParts, preloadFiles } from "../src/preload.js";
import { streamPlan } from "../src/stream.js";

describe("the model read once before the engine starts (2026-11-04)", () => {
  it("finds every part of a split model and reads them all, saying how far it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-pre-"));
    const name = "big-00001-of-00002.gguf";
    expect(modelParts(dir, name)).toEqual([
      join(dir, "big-00001-of-00002.gguf"),
      join(dir, "big-00002-of-00002.gguf"),
    ]);
    expect(modelParts(dir, "one.gguf")).toEqual([join(dir, "one.gguf")]);
    await writeFile(join(dir, "big-00001-of-00002.gguf"), Buffer.alloc(3000));
    await writeFile(join(dir, "big-00002-of-00002.gguf"), Buffer.alloc(2000));
    expect(await modelGb(dir, name)).toBeCloseTo(5000 / 1024 ** 3);
    const seen: [number, number | null][] = [];
    const gbs = await preloadFiles(modelParts(dir, name), {
      signal: new AbortController().signal,
      progress: (done, total) => seen.push([done, total]),
    });
    expect(seen.at(-1)).toEqual([5000, 5000]);
    expect(gbs).toBeGreaterThanOrEqual(0);
  });

  it("a mixture of experts streamed reads its context in passes of 2048 tokens", () => {
    const meta = {
      architecture: "gpt-oss",
      layers: 36,
      contextLength: 131072,
      experts: 128,
      expertsUsed: 4,
      kvBytesPerToken: 73728,
    };
    const p = streamPlan(meta, 58, { kind: "gpu", vramGb: 16, ramGb: 30 });
    expect(p.args.join(" ")).toContain("-b 2048 -ub 2048");
    const cpu = streamPlan(meta, 58, { kind: "cpu", vramGb: 0, ramGb: 64 });
    expect(cpu.args).not.toContain("-ub");
  });
});

describe("a file's quality among its repository's (2026-11-04)", () => {
  it("is high when it weighs almost as much as the largest, whatever its name", async () => {
    const { qualityAmong } = await import("../src/local-models.js");
    const files = [
      { file: "gpt-oss-120b-Q2_K.gguf", sizeGb: 58.3, quant: "Q2_K" },
      { file: "gpt-oss-120b-Q8_0.gguf", sizeGb: 59.0, quant: "Q8_0" },
    ];
    expect(qualityAmong(files[0] as (typeof files)[0], files)).toBe("high");
    const usual = [
      { file: "m-Q2_K.gguf", sizeGb: 10, quant: "Q2_K" },
      { file: "m-Q8_0.gguf", sizeGb: 30, quant: "Q8_0" },
    ];
    expect(qualityAmong(usual[0] as (typeof usual)[0], usual)).toBe("reduced");
  });
});

describe("speculative decoding (2026-11-04)", () => {
  it("gives llama.cpp the small model or the n-grams, and nothing when off", async () => {
    const { speculativeArgs } = await import("../src/stream.js");
    expect(speculativeArgs("draft", "/models/small.gguf")).toEqual([
      "--spec-type",
      "draft-simple",
      "-md",
      "/models/small.gguf",
      "-ngld",
      "99",
      "--spec-draft-n-max",
      "8",
      "--spec-draft-p-min",
      "0.75",
    ]);
    expect(speculativeArgs("draft", undefined)).toEqual([]);
    expect(speculativeArgs("ngram", undefined)).toEqual(["--spec-type", "ngram-mod"]);
    expect(speculativeArgs(undefined, "/models/x.gguf")).toEqual([]);
  });

  it("leaves the small model its room in the card", () => {
    const dense = {
      architecture: "llama",
      layers: 80,
      contextLength: 131072,
      experts: 0,
      expertsUsed: 0,
      kvBytesPerToken: 327680,
    };
    const hw = { kind: "gpu", vramGb: 16, ramGb: 30 } as const;
    const plain = streamPlan(dense, 42, hw);
    const withDraft = streamPlan(dense, 42, hw, { draftGb: 1.3 });
    expect(withDraft.ctx).toBeLessThanOrEqual(plain.ctx);
  });
});

describe("reading a context without the copy to the card (2026-11-04)", () => {
  it("adds --no-op-offload only when the tuning chose it", async () => {
    const { streamPlan: plan } = await import("../src/stream.js");
    const meta = {
      architecture: "gpt-oss",
      layers: 36,
      contextLength: 131072,
      experts: 128,
      expertsUsed: 4,
      kvBytesPerToken: 73728,
    };
    const hw = { kind: "gpu", vramGb: 16, ramGb: 30 } as const;
    expect(plan(meta, 58, hw, { opOffload: false }).args).toContain("--no-op-offload");
    expect(plan(meta, 58, hw, { opOffload: true }).args).not.toContain("--no-op-offload");
    expect(plan(meta, 58, hw).args).not.toContain("--no-op-offload");
  });
});
