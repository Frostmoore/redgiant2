import { DANGER_IDS, dangerWords } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_DANGER_RULES, OUTSIDE_PROJECT } from "../src/index.js";

describe("danger words", () => {
  it("names and explains every danger in both languages", () => {
    // The guardian's danger is not a pattern: the policy finds it from where a call writes.
    const ids = [...DEFAULT_DANGER_RULES.map((r) => r.id), OUTSIDE_PROJECT];
    expect([...DANGER_IDS].sort()).toEqual([...ids].sort());
    for (const id of ids)
      for (const lang of ["it", "en"] as const) {
        const w = dangerWords(lang, id);
        expect(w.name, `${lang} ${id}`).not.toBe(id);
        expect(w.hint.length, `${lang} ${id}`).toBeGreaterThan(20);
      }
  });

  it("shows the id of a danger it does not know", () => {
    expect(dangerWords("it", "custom-rule")).toEqual({ name: "custom-rule", hint: "" });
  });
});
