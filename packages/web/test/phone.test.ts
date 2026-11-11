// @vitest-environment jsdom
// Phones and tablets (3.5.11, G37.9): when the canvas covers the chat, when an editor's bars
// fold, how big a finger's targets are, and the arithmetic of two fingers. Tables first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchoredScroll,
  COVER_QUERY,
  canvasCovers,
  compactWidth,
  Fingers,
  gizmoSize,
  isPhoneScreen,
  pinchStep,
} from "../src/phone.js";

describe("the canvas covers the chat", () => {
  const cases: [string, number, boolean, boolean][] = [
    ["a phone in portrait (390)", 390, true, true],
    ["a large phone in portrait (412)", 412, true, true],
    ["a phone on its side (844)", 844, true, true],
    ["a tablet in portrait (820)", 820, true, true],
    ["a tablet on its side (1180): beside the chat", 1180, true, false],
    ["a narrow desktop window with a mouse (700)", 700, false, true],
    ["a desktop window with a mouse (900): beside", 900, false, false],
    ["a desktop with a mouse (1366)", 1366, false, false],
  ];
  for (const [name, width, coarse, want] of cases)
    it(name, () => expect(canvasCovers(width, coarse)).toBe(want));

  it("the CSS says the same as the query", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");
    expect(css).toContain(`@media ${COVER_QUERY} {`);
  });
});

describe("an editor's bars fold below 600 px", () => {
  const cases: [number, boolean][] = [
    [0, false], // hidden: not measured
    [360, true],
    [599, true],
    [600, false],
    [820, false],
  ];
  for (const [w, want] of cases) it(`${w} px`, () => expect(compactWidth(w)).toBe(want));
});

describe("a phone, not a tablet", () => {
  const cases: [string, number, number, boolean, boolean][] = [
    ["phone portrait", 390, 844, true, true],
    ["phone on its side", 844, 390, true, true],
    ["tablet", 820, 1180, true, false],
    ["a small window with a mouse", 390, 844, false, false],
    ["no screen", 0, 0, true, false],
  ];
  for (const [name, w, h, coarse, want] of cases)
    it(name, () => expect(isPhoneScreen(w, h, coarse)).toBe(want));
});

it("the 3D handles are larger for a finger", () => {
  expect(gizmoSize(true)).toBeGreaterThan(gizmoSize(false));
  expect(gizmoSize(false)).toBe(1);
});

describe("two fingers", () => {
  it("spreading zooms in around the point between them", () => {
    const s = pinchStep(
      [
        [100, 100],
        [200, 100],
      ],
      [
        [50, 100],
        [250, 100],
      ],
    );
    expect(s.factor).toBe(2);
    expect(s.mid).toEqual([150, 100]);
    expect(s.pan).toEqual([0, 0]);
  });
  it("moving together pans without zooming", () => {
    const s = pinchStep(
      [
        [100, 100],
        [200, 100],
      ],
      [
        [130, 140],
        [230, 140],
      ],
    );
    expect(s.factor).toBe(1);
    expect(s.pan).toEqual([30, 40]);
  });
  it("a finger on the other's spot changes nothing", () => {
    expect(
      pinchStep(
        [
          [100, 100],
          [100, 100],
        ],
        [
          [90, 100],
          [120, 100],
        ],
      ).factor,
    ).toBe(1);
  });
  it("the point under the fingers stays there after the zoom", () => {
    // Box scrolled to (100, 50); fingers at (40, 30) in the box; zoom ×2.
    const [sx, sy] = anchoredScroll([100, 50], [40, 30], 1, 2);
    // The picture point was at 140, 80 (zoom 1): at zoom 2 it is at 280, 160, seen at (40, 30).
    expect([280 - sx, 160 - sy]).toEqual([40, 30]);
    expect(anchoredScroll([100, 50], [40, 30], 1, 1, [10, 0])).toEqual([90, 50]);
  });
});

describe("fingers on a picture: one draws, two pan and zoom", () => {
  it("a second finger turns the stroke into a pinch until every finger is up", () => {
    const f = new Fingers();
    expect(f.down(1, [10, 10])).toBe("one");
    expect(f.move(1, [20, 10])).toBeUndefined(); // the stroke goes on
    expect(f.down(2, [120, 10])).toBe("pinch");
    expect(f.active).toBe(true);
    const step = f.move(2, [220, 10]);
    expect(step?.factor).toBeCloseTo(2);
    expect(f.up(2)).toBe(true); // part of the pinch, not a stroke's end
    expect(f.move(1, [30, 10])).toBeUndefined();
    expect(f.active).toBe(true); // one finger left: still no stroke
    expect(f.up(1)).toBe(true);
    expect(f.active).toBe(false);
    expect(f.down(3, [0, 0])).toBe("one"); // a new stroke
    expect(f.up(3)).toBe(false);
  });
  it("a third finger is ignored", () => {
    const f = new Fingers();
    f.down(1, [0, 0]);
    f.down(2, [100, 0]);
    expect(f.down(3, [50, 50])).toBe("ignore");
  });
});
