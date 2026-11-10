import { describe, expect, it } from "vitest";
import {
  FIND_SOURCE_WORDS,
  type FindSource,
  findTimingLine,
  parseFindTiming,
} from "../src/index.js";

describe("find_files' line about how it searched (3.5.5)", () => {
  it("writes the source and the time, and reads them back for every source", () => {
    for (const source of Object.keys(FIND_SOURCE_WORDS) as FindSource[]) {
      const line = findTimingLine({ source, seconds: 3.14 });
      expect(line).toBe(`Search: ${FIND_SOURCE_WORDS[source]}, 3.1 s.`);
      expect(parseFindTiming(`2 found:\n/a\n/b\nThe search was complete.\n${line}`)).toEqual({
        source,
        seconds: 3.1,
      });
    }
  });

  it("says the limit when the time cut it, or that it was interrupted", () => {
    const cut = findTimingLine({ source: "walk", seconds: 20.04, cutAtSeconds: 20 });
    expect(cut).toBe("Search: walked the folders, 20.0 s (cut at 20 s).");
    expect(parseFindTiming(cut)).toEqual({ source: "walk", seconds: 20, cutAtSeconds: 20 });
    const stopped = findTimingLine({ source: "container", seconds: 1, interrupted: true });
    expect(stopped).toBe("Search: find in the container, 1.0 s (interrupted).");
    expect(parseFindTiming(stopped)).toEqual({
      source: "container",
      seconds: 1,
      interrupted: true,
    });
  });

  it("finds nothing in other answers, or in a line it did not write", () => {
    expect(parseFindTiming("The search failed: boom")).toBeUndefined();
    expect(parseFindTiming("Search: somewhere else, 1.0 s.")).toBeUndefined();
    expect(parseFindTiming("Search: Everything's index, soon.")).toBeUndefined();
    // A found path that looks like the line is not the last such line: the real one wins.
    expect(
      parseFindTiming("1 found:\nSearch: the PATH, 9.9 s.\nSearch: Everything's index, 0.2 s."),
    ).toEqual({ source: "everything", seconds: 0.2 });
  });
});
