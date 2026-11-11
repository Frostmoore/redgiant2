// A finger on the sheet (3.5.11, G37.9): Univer alone takes a drag as a selection and never
// scrolls. What each gesture becomes for it, as a table of finger moves and what is sent.
import { describe, expect, it } from "vitest";
import { DOUBLE_TAP, type MouseOut, TouchMouse } from "../src/viewers/touch-mouse.js";

type Step =
  | ["down", number, number, number]
  | ["move", number, number, number]
  | ["up", number, number?]
  | ["press"];

function run(steps: Step[]): string[] {
  const out: MouseOut[] = [];
  const tm = new TouchMouse((o) => out.push(o));
  for (const s of steps) {
    if (s[0] === "down") tm.down(s[1], [s[2], s[3]]);
    else if (s[0] === "move") tm.move(s[1], [s[2], s[3]]);
    else if (s[0] === "up") tm.up(s[1], s[2] ?? 0);
    else tm.press();
  }
  return out.map((o) =>
    o.t === "wheel"
      ? `wheel ${o.dx},${o.dy}`
      : o.t === "zoom"
        ? `zoom ${o.factor.toFixed(1)}`
        : `${o.t} ${o.at.join(",")}`,
  );
}

describe("what a finger does on the sheet", () => {
  const cases: [string, Step[], string[]][] = [
    [
      "a tap is a click",
      [
        ["down", 1, 10, 10],
        ["up", 1],
      ],
      ["down 10,10", "up 10,10"],
    ],
    [
      "a small wobble is still a tap",
      [
        ["down", 1, 10, 10],
        ["move", 1, 14, 13],
        ["up", 1],
      ],
      ["down 10,10", "up 10,10"],
    ],
    [
      "a drag scrolls, never selects",
      [
        ["down", 1, 100, 300],
        ["move", 1, 100, 250],
        ["move", 1, 90, 200],
        ["up", 1],
      ],
      ["wheel 0,50", "wheel 10,50"],
    ],
    [
      "a long press then a drag selects (a mouse drag)",
      [["down", 1, 10, 10], ["press"], ["move", 1, 60, 40], ["up", 1]],
      ["down 10,10", "move 60,40", "up 60,40"],
    ],
    [
      "the long press's time after a scroll began does nothing",
      [["down", 1, 10, 100], ["move", 1, 10, 50], ["press"], ["up", 1]],
      ["wheel 0,50"],
    ],
    [
      "two fingers zoom, nothing is clicked",
      [
        ["down", 1, 100, 100],
        ["down", 2, 200, 100],
        ["move", 2, 300, 100],
        ["up", 2],
        ["up", 1],
      ],
      ["zoom 2.0"],
    ],
    [
      "a press let go when a second finger comes",
      [["down", 1, 10, 10], ["press"], ["down", 2, 110, 10], ["up", 2], ["up", 1]],
      ["down 10,10", "up 10,10"],
    ],
  ];
  for (const [name, steps, want] of cases) it(name, () => expect(run(steps)).toEqual(want));

  it("two taps close in time and place are a double click (to type in a cell)", () => {
    expect(
      run([
        ["down", 1, 10, 10],
        ["up", 1, 1000],
        ["down", 1, 14, 12],
        ["up", 1, 1000 + DOUBLE_TAP - 50],
      ]),
    ).toEqual(["down 10,10", "up 10,10", "down 14,12", "up 14,12", "dblclick 14,12"]);
  });
  it("two taps far apart in time are two clicks", () => {
    expect(
      run([
        ["down", 1, 10, 10],
        ["up", 1, 1000],
        ["down", 1, 10, 10],
        ["up", 1, 1000 + DOUBLE_TAP + 200],
      ]),
    ).not.toContain("dblclick 10,10");
  });
});
