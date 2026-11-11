// The picture editor's pixel work (p3.5.7), pixel-exact on small pictures: the Move tool's
// selected pixels (the hole is exactly the selection, the piece goes over what is there, moving
// again brings back what the piece covered: the bug of 3.5.6), selection modes, magic wand,
// paint bucket, gradient, clone stamp, outline and feather.
import { describe, expect, it } from "vitest";
import { imagePx as P } from "../src/index.js";

type RGBA = [number, number, number, number];
const R: RGBA = [255, 0, 0, 255];
const G: RGBA = [0, 255, 0, 255];
const B: RGBA = [0, 0, 255, 255];
const T: RGBA = [0, 0, 0, 0];

/** A picture from rows of letters (r, g, b, . transparent). */
function pic(rows: string[]): P.Px {
  const h = rows.length;
  const w = (rows[0] as string).length;
  const px = P.blankPx(w, h);
  const of: Record<string, RGBA> = { r: R, g: G, b: B, ".": T };
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      px.data.set(of[c] as RGBA, (y * w + x) * 4);
    });
  });
  return px;
}
/** Back to letters ("?" for anything else). */
function rows(px: P.Px): string[] {
  const out: string[] = [];
  for (let y = 0; y < px.height; y++) {
    let s = "";
    for (let x = 0; x < px.width; x++) {
      const v = [...px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];
      const k = JSON.stringify(v);
      s +=
        k === JSON.stringify(R)
          ? "r"
          : k === JSON.stringify(G)
            ? "g"
            : k === JSON.stringify(B)
              ? "b"
              : v[3] === 0
                ? "."
                : "?";
    }
    out.push(s);
  }
  return out;
}
const at = (px: P.Px, x: number, y: number) => [
  ...px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4),
];
const selRows = (s: P.Sel) =>
  Array.from({ length: s.height }, (_, y) =>
    [...s.a.subarray(y * s.width, (y + 1) * s.width)]
      .map((v) => (v === 255 ? "#" : v === 0 ? "." : "+"))
      .join(""),
  );

describe("Move with a selection (the selected pixels)", () => {
  const base = (): P.Placed => ({
    x: 0,
    y: 0,
    px: pic(["gggggggg", "grrggggg", "grrggggg", "gggggggg", "gggggggg", "gggggggg"]),
  });
  const sel = P.selOfRect(8, 6, { x: 1, y: 1, w: 2, h: 2 });

  it("cuts exactly the selection and puts the piece over what is there", () => {
    const f = P.float(base(), sel);
    const out = P.floatAt(f, 3, 2);
    expect(out).toMatchObject({ x: 0, y: 0 });
    expect(rows(out.px)).toEqual([
      "gggggggg",
      "g..ggggg",
      "g..ggggg",
      "ggggrrgg",
      "ggggrrgg",
      "gggggggg",
    ]);
  });

  it("moving again while the selection is held leaves no trail (3.5.6 cut a hole at every drop)", () => {
    const f = P.float(base(), sel);
    P.floatAt(f, 3, 2);
    const twice = P.floatAt(f, 5, 3);
    // The first landing place is green again: only the first place is a hole.
    expect(rows(twice.px)).toEqual([
      "gggggggg",
      "g..ggggg",
      "g..ggggg",
      "gggggggg",
      "ggggggrr",
      "ggggggrr",
    ]);
    // What 3.5.6 did: the drop was final, the next drag cut the selection again where it was.
    const dropped = P.floatAt(f, 3, 2);
    const again = P.floatAt(P.float(dropped, P.shiftSel(sel, 3, 2)), 2, 1);
    expect(rows(again.px)[3]).toBe("gggg..gg");
  });

  it("back where it was, the layer is as it was", () => {
    const f = P.float(base(), sel);
    expect(rows(P.floatAt(f, 0, 0).px)).toEqual(rows(base().px));
  });

  it("Alt (a copy) leaves no hole; a Background's hole takes its colour", () => {
    expect(rows(P.floatAt(P.float(base(), sel, true), 4, 0).px).slice(1, 3)).toEqual([
      "grrggrrg",
      "grrggrrg",
    ]);
    expect(rows(P.floatAt(P.float(base(), sel, false, B), 4, 0).px).slice(1, 3)).toEqual([
      "gbbggrrg",
      "gbbggrrg",
    ]);
  });

  it("soft edges: the hole and the piece share the selection's coverage", () => {
    const s = P.emptySel(4, 1);
    s.a.set([0, 255, 128, 0]);
    const l: P.Placed = { x: 0, y: 0, px: pic(["grrg"]) };
    const out = P.floatAt(P.float(l, s), 0, 0);
    expect(at(out.px, 1, 0)).toEqual(R);
    // The half-selected pixel: half cut, then its half put back over its own hole.
    const m = 128 / 255;
    expect(at(out.px, 2, 0)[3]).toBe(Math.round((m + (1 - m) * (1 - m)) * 255));
    const away = P.floatAt(P.float(l, s), 1, 0);
    expect(at(away.px, 2, 0)).toEqual(R);
    // The half-selected red lands half over the green beside it.
    expect(at(away.px, 3, 0)).toEqual([128, 127, 0, 255]);
    expect(at(away.px, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("the layer grows to hold the piece inside the picture", () => {
    const l: P.Placed = { x: 0, y: 0, px: pic(["rg", "gg"]) };
    const s = P.selOfRect(5, 4, { x: 0, y: 0, w: 1, h: 1 });
    const out = P.floatAt(P.float(l, s), 3, 2);
    expect(out).toMatchObject({ x: 0, y: 0 });
    expect(rows(out.px)).toEqual([".g..", "gg..", "...r"]);
  });
});

describe("selections", () => {
  const A = P.selOfRect(6, 3, { x: 0, y: 0, w: 4, h: 2 });
  const Bsel = P.selOfRect(6, 3, { x: 2, y: 1, w: 4, h: 2 });
  it("new, add (Shift), subtract (Alt), intersect (Shift+Alt)", () => {
    expect(selRows(P.combineSel("new", A, Bsel) as P.Sel)).toEqual(["......", "..####", "..####"]);
    expect(selRows(P.combineSel("add", A, Bsel) as P.Sel)).toEqual(["####..", "######", "..####"]);
    expect(selRows(P.combineSel("subtract", A, Bsel) as P.Sel)).toEqual([
      "####..",
      "##....",
      "......",
    ]);
    expect(selRows(P.combineSel("intersect", A, Bsel) as P.Sel)).toEqual([
      "......",
      "..##..",
      "......",
    ]);
    // Nothing left: no selection.
    expect(P.combineSel("subtract", A, A)).toBeUndefined();
    expect(P.combineSel("subtract", undefined, A)).toBeUndefined();
    expect(selRows(P.combineSel("add", undefined, A) as P.Sel)[0]).toBe("####..");
  });

  it("inverse, bounds, moved, point inside", () => {
    expect(selRows(P.invertSel(A))).toEqual(["....##", "....##", "######"]);
    expect(P.selBounds(Bsel)).toEqual({ x: 2, y: 1, w: 4, h: 2 });
    expect(selRows(P.shiftSel(A, 1, 1))).toEqual(["......", ".####.", ".####."]);
    expect(P.inSel(A, 3.9, 1.2)).toBe(true);
    expect(P.inSel(A, 4.1, 1.2)).toBe(false);
  });

  it("a lasso polygon is anti-aliased on its edges, hard without", () => {
    const s = P.selOfPolys(4, 3, [[0.5, 0, 3.5, 0, 3.5, 3, 0.5, 3]]);
    expect(selRows(s)).toEqual(["+##+", "+##+", "+##+"]);
    expect(s.a[0]).toBe(128);
    const hard = P.selOfPolys(4, 3, [[0.6, 0, 3.4, 0, 3.4, 3, 0.6, 3]], false);
    expect(selRows(hard)).toEqual([".##.", ".##.", ".##."]);
  });

  it("the outline follows the pixels' edges", () => {
    const s = P.selOfRect(4, 4, { x: 1, y: 1, w: 2, h: 2 });
    const segs = [...P.selOutline(s)];
    expect(segs).toEqual([1, 1, 3, 1, 1, 3, 3, 3, 1, 1, 1, 3, 3, 1, 3, 3]);
  });

  it("feather softens the edges and keeps the middle", () => {
    const s = P.selOfRect(41, 41, { x: 10, y: 10, w: 21, h: 21 });
    const f = P.featherSel(s, 2);
    const v = (x: number) => f.a[20 * 41 + x] as number;
    expect(v(20)).toBe(255);
    expect(v(10)).toBeGreaterThan(64);
    expect(v(10)).toBeLessThan(200);
    expect(v(2)).toBeLessThan(10);
    // Symmetric.
    expect(v(10)).toBe(v(30));
  });
});

describe("magic wand, quick selection and paint bucket", () => {
  const px = pic(["rrgr", "rggr", "rrrr", "gbbg"]);
  it("contiguous takes what is joined, not contiguous every pixel alike", () => {
    expect(selRows(P.wandSel(px, 0, 0, 0))).toEqual(["##.#", "#..#", "####", "...."]);
    expect(selRows(P.wandSel(px, 2, 0, 0))).toEqual(["..#.", ".##.", "....", "...."]);
    expect(selRows(P.wandSel(px, 2, 0, 0, false))).toEqual(["..#.", ".##.", "....", "#..#"]);
    // A tolerance wide enough takes green with blue (they differ by 255 on two channels).
    expect(selRows(P.wandSel(px, 1, 3, 255))).toEqual(["####", "####", "####", "####"]);
    expect(selRows(P.wandSel(px, 9, 9, 0))).toEqual(["....", "....", "....", "...."]);
  });

  it("the quick selection grows from the colours under the brush", () => {
    const s = P.quickSel(px, 1.5, 3.5, 0.6, 10, P.emptySel(4, 4));
    expect(selRows(s)).toEqual(["....", "....", "....", ".##."]);
  });

  it("the paint bucket fills the wand's area with the colour", () => {
    const l: P.Placed = { x: 0, y: 0, px: pic(["rrgr", "rggr", "rrrr", "gbbg"]) };
    P.fillThrough(l, P.wandSel(l.px, 2, 1, 0), B);
    expect(rows(l.px)).toEqual(["rrbr", "rbbr", "rrrr", "gbbg"]);
    // Half opacity over red.
    const m: P.Placed = { x: 0, y: 0, px: pic(["r"]) };
    P.fillThrough(m, undefined, B, 0.5);
    expect(at(m.px, 0, 0)).toEqual([128, 0, 128, 255]);
  });
});

describe("gradient and clone stamp", () => {
  it("a linear gradient at the pixels' centres, through the selection", () => {
    const l: P.Placed = { x: 0, y: 0, px: P.blankPx(5, 2) };
    P.gradientThrough(l, P.selOfRect(5, 2, { x: 0, y: 0, w: 5, h: 1 }), {
      from: [0, 0],
      to: [5, 0],
      kind: "linear",
      c0: [0, 0, 0, 255],
      c1: [255, 255, 255, 255],
    });
    expect([0, 1, 2, 3, 4].map((x) => at(l.px, x, 0)[0])).toEqual([26, 77, 128, 179, 230]);
    expect(at(l.px, 2, 1)).toEqual([0, 0, 0, 0]);
  });

  it("a radial gradient to transparent keeps its colour", () => {
    const l: P.Placed = { x: 0, y: 0, px: P.blankPx(3, 1) };
    P.gradientThrough(l, undefined, {
      from: [0.5, 0.5],
      to: [2.5, 0.5],
      kind: "radial",
      c0: [255, 0, 0, 255],
      c1: [255, 0, 0, 0],
    });
    expect([0, 1, 2].map((x) => at(l.px, x, 0))).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 128],
      [0, 0, 0, 0],
    ]);
  });

  it("the clone stamp paints the source from its offset through the strokes", () => {
    const l: P.Placed = { x: 0, y: 0, px: pic(["rgbg", "gggg"]) };
    const src = pic(["rgbg", "gggg"]);
    const cover = P.emptySel(4, 2);
    cover.a.set([0, 0, 0, 0, 0, 255, 255, 0]);
    P.stampThrough(l, src, [-1, -1], cover);
    expect(rows(l.px)).toEqual(["rgbg", "grgg"]);
  });
});
