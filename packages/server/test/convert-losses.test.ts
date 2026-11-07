// The losses as stable codes for the page (3.3.0): every text a converter writes has its code,
// and the values in it (a layer's name, a count) come back as they were.
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { knownFormats } from "../src/convert-formats.js";
import { idmlToOdg } from "../src/convert-idml.js";
import { idmlToOdt, psdToOra } from "../src/convert-js.js";
import { LOSS_TEMPLATES, type LossId, lossCode, lossText } from "../src/convert-losses.js";
import { sketchToSvg } from "../src/convert-sketch.js";
import { idmlSample, psdSample, sketchSample } from "./fixtures/convert-samples.js";

const uncoded = (losses: string[]) => losses.filter((l) => lossCode(l).code === null);

describe("loss codes", () => {
  it("gives every template back its own code and values", () => {
    for (const code of Object.keys(LOSS_TEMPLATES) as LossId[]) {
      const vars = { n: "3", names: "Title, Logo", layer: "Sky", bits: "16", fonts: "Minion Pro" };
      const text = lossText(code, vars);
      const found = lossCode(text);
      expect(found.code, text).toBe(code);
      for (const [k, v] of Object.entries(found.vars ?? {}))
        expect(v).toBe((vars as Record<string, string>)[k]);
    }
    expect(lossCode("something new")).toEqual({ code: null });
    expect(lossCode("adjustment layer dropped: «Curves 1»")).toEqual({
      code: "psd_adjustment",
      vars: { layer: "Curves 1" },
    });
  });

  it("knows every loss the formats declare", () => {
    const all = knownFormats().flatMap((f) => f.targets.flatMap((t) => t.losses));
    expect(all.length).toBeGreaterThan(20);
    expect(uncoded(all)).toEqual([]);
  });

  it("knows every loss the converters write on the samples", () => {
    expect(uncoded(psdToOra(psdSample(), "p").losses)).toEqual([]);
    expect(uncoded(sketchToSvg(unzipSync(sketchSample()), "s").losses)).toEqual([]);
    // Without its pictures: the missing links are said too.
    const odg = idmlToOdg(unzipSync(idmlSample()), "b").losses;
    expect(odg.some((l) => lossCode(l).code === "idml_missing_links")).toBe(true);
    expect(uncoded(odg)).toEqual([]);
    expect(uncoded(idmlToOdt(unzipSync(idmlSample()), "b").losses)).toEqual([]);
  });
});
