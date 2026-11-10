import { findTimingLine } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { findTimingText, lang } from "../src/i18n.js";

afterEach(() => {
  lang.value = "en";
});

describe("find_files' source and time in the page (3.5.5)", () => {
  const answer = (line: string) =>
    `1 found (Everything's index):\nC:\\a.jar\nThe search was complete.\n${line}`;

  it("says the source and the time in Italian", () => {
    lang.value = "it";
    expect(findTimingText(answer(findTimingLine({ source: "everything", seconds: 0.2 })))).toBe(
      "indice di Everything, 0,2 s",
    );
    expect(
      findTimingText(answer(findTimingLine({ source: "walk", seconds: 20.3, cutAtSeconds: 20 }))),
    ).toBe("ricerca nelle cartelle, 20,3 s (fermata a 20 s)");
    expect(
      findTimingText(
        answer(findTimingLine({ source: "container", seconds: 1, interrupted: true })),
      ),
    ).toBe("ricerca nel container, 1,0 s (interrotta)");
  });

  it("and in English", () => {
    lang.value = "en";
    expect(findTimingText(answer(findTimingLine({ source: "walk", seconds: 3.1 })))).toBe(
      "searched the folders, 3.1 s",
    );
    expect(findTimingText(answer(findTimingLine({ source: "path", seconds: 0 })))).toBe(
      "programs on the PATH, 0.0 s",
    );
  });

  it("shows nothing for an answer without the line (older ones, failures)", () => {
    expect(findTimingText("2 found (the PATH):\n/a\n/b\nThe search was complete.")).toBeUndefined();
    expect(findTimingText("The search failed: boom")).toBeUndefined();
  });
});
