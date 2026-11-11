// @vitest-environment jsdom
// The picture editor's tools as Photoshop's (p3.5.7): the groups and letters of the left bar
// (Shift+letter cycles in a group), the selection modes from the keys, the marquee's square and
// centre, the options bar per tool, the left bar's flyouts and colours (our controls, never
// native boxes), and Ctrl+Z waiting for the gesture's revision (the race of 3.5.6).
import type { ImagePlainAction } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEXT_OPTIONS, ImageOptions } from "../src/components/viewers/ImageOptions.js";
import { ImageToolbar, toolLabel } from "../src/components/viewers/ImageToolbar.js";
import { lang } from "../src/i18n.js";
import { ImageCollab, type ImageOutgoing } from "../src/viewers/image-ops.js";
import {
  BRUSHED,
  brushStep,
  DEFAULT_OPTIONS,
  defaultShown,
  type ImageTool,
  marqueeRect,
  SELECTING,
  selModeOf,
  snap45,
  TOOL_GROUPS,
  toolForKey,
  zoomStep,
} from "../src/viewers/image-tools.js";

afterEach(() => {
  cleanup();
  lang.value = "it";
});

describe("the left bar's groups and letters", () => {
  it("has Photoshop's groups, in its order, with its letters", () => {
    expect(TOOL_GROUPS.map((g) => `${g.key}:${g.tools.join("/")}`)).toEqual([
      "v:move",
      "m:marquee-rect/marquee-ellipse",
      "l:lasso/lasso-poly/lasso-magnetic",
      "w:quick-select/wand",
      "c:crop",
      "i:eyedropper",
      "b:brush/pencil",
      "s:clone",
      "e:eraser",
      "g:gradient/bucket",
      "t:text",
      "u:shape-rect/shape-ellipse/shape-line",
      "h:hand",
      "z:zoom",
    ]);
  });

  it("a letter picks the group's tool in use, Shift+letter the next one", () => {
    const shown = defaultShown();
    expect(toolForKey("v", false, "brush", shown)).toBe("move");
    expect(toolForKey("m", false, "brush", shown)).toBe("marquee-rect");
    expect(toolForKey("M", true, "marquee-rect", shown)).toBe("marquee-ellipse");
    expect(toolForKey("m", true, "marquee-ellipse", shown)).toBe("marquee-rect");
    expect(toolForKey("l", true, "lasso-magnetic", shown)).toBe("lasso");
    // From another group the letter gives the tool the group shows.
    expect(toolForKey("g", false, "brush", { ...shown, fill: "bucket" })).toBe("bucket");
    expect(toolForKey("g", true, "brush", { ...shown, fill: "bucket" })).toBe("gradient");
    expect(toolForKey("q", false, "brush", shown)).toBeUndefined();
    expect(toolForKey("v", true, "move", shown)).toBe("move");
  });

  it("knows the selecting and brushed tools, the brush steps and the zoom steps", () => {
    expect([...SELECTING]).toContain("wand");
    expect(SELECTING.has("move")).toBe(false);
    expect(BRUSHED.has("clone")).toBe(true);
    expect([brushStep(9, 1), brushStep(10, 1), brushStep(10, -1), brushStep(1, -1)]).toEqual([
      10, 15, 9, 1,
    ]);
    expect(zoomStep(1, 1)).toBe(2);
    expect(zoomStep(1, -1)).toBeCloseTo(0.6667);
    expect(zoomStep(32, 1)).toBe(32);
  });
});

describe("selection gestures", () => {
  it("Shift adds, Alt subtracts, both intersect; without a selection the bar's mode", () => {
    const k = (shift: boolean, alt: boolean) => ({ shift, alt });
    expect(selModeOf("new", k(true, false), true)).toEqual({ mode: "add", byKeys: true });
    expect(selModeOf("new", k(false, true), true)).toEqual({ mode: "subtract", byKeys: true });
    expect(selModeOf("new", k(true, true), true)).toEqual({ mode: "intersect", byKeys: true });
    expect(selModeOf("add", k(false, false), true)).toEqual({ mode: "add", byKeys: false });
    // No selection yet: the keys shape the marquee instead (square, from the centre).
    expect(selModeOf("new", k(true, true), false)).toEqual({ mode: "new", byKeys: false });
  });

  it("the marquee: square with Shift, from the centre with Alt, any direction", () => {
    expect(marqueeRect([10, 10], [4, 30], false, false)).toEqual({ x: 4, y: 10, w: 6, h: 20 });
    expect(marqueeRect([10, 10], [14, 30], true, false)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(marqueeRect([10, 10], [14, 30], false, true)).toEqual({ x: 6, y: -10, w: 8, h: 40 });
    const [x, y] = snap45([0, 0], [10, 1]);
    expect([Math.round(x), Math.round(y)]).toEqual([10, 0]);
  });
});

describe("the left bar", () => {
  it("one slot per group, the group's flyout on a right click, the colours below", () => {
    const picked: ImageTool[] = [];
    const colours: string[] = [];
    const { container, getByLabelText, getByText } = render(
      <ImageToolbar
        tool="brush"
        shown={defaultShown()}
        onTool={(x) => picked.push(x)}
        fg="#000000"
        bg="#ffffff"
        onColor={(w, h) => colours.push(`${w}${h}`)}
        onSwap={() => colours.push("swap")}
        onDefault={() => colours.push("default")}
      />,
    );
    expect(container.querySelectorAll(".img-tool-slot")).toHaveLength(TOOL_GROUPS.length);
    // The groups with more tools show the corner triangle.
    expect(container.querySelectorAll(".svg-tool.more")).toHaveLength(6);
    const brush = getByLabelText("Pennello (B)");
    expect(brush.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByLabelText("Selezione rettangolare (M)"));
    expect(picked).toEqual(["marquee-rect"]);
    fireEvent.contextMenu(getByLabelText("Lazo (L)"));
    const items = container.querySelectorAll(".img-flyout [role=menuitemradio]");
    expect([...items].map((i) => i.textContent)).toEqual([
      "LazoL",
      "Lazo poligonaleL",
      "Lazo magneticoL",
    ]);
    fireEvent.click(getByText("Lazo magnetico"));
    expect(picked.at(-1)).toBe("lasso-magnetic");
    expect(container.querySelector(".img-flyout")).toBeNull();
    fireEvent.click(getByLabelText("Scambia i colori (X)"));
    fireEvent.click(getByLabelText("Colori predefiniti, nero e bianco (D)"));
    expect(colours).toEqual(["swap", "default"]);
    // Never a native checkbox or radio.
    expect(container.querySelector("input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("speaks English too", () => {
    lang.value = "en";
    expect(toolLabel("clone")).toBe("Clone Stamp tool (S)");
    expect(toolLabel("shape-line")).toBe("Line tool (U)");
  });
});

describe("the options bar", () => {
  const bar = (tool: ImageTool, extra: Partial<Parameters<typeof ImageOptions>[0]> = {}) => {
    const set: unknown[] = [];
    const acts: string[] = [];
    const r = render(
      <ImageOptions
        tool={tool}
        opts={{ ...DEFAULT_OPTIONS }}
        setOpts={(o) => set.push(o)}
        brush={{ size: 12, opacity: 1, hardness: 1, flow: 1, color: "#ff0000" }}
        setBrush={(b) => set.push(b)}
        text={{ ...DEFAULT_TEXT_OPTIONS }}
        setText={() => {}}
        sel={undefined}
        hasMask={false}
        onMask={false}
        setOnMask={() => {}}
        crop={undefined}
        transforming={false}
        act={(w) => acts.push(w)}
        {...extra}
      />,
    );
    return { ...r, set, acts };
  };

  it("changes with the tool, as Photoshop's", () => {
    const sel = bar("marquee-ellipse");
    expect(sel.getByLabelText("Aggiungi alla selezione (Maiusc)")).toBeTruthy();
    expect(sel.getByText("Sfuma")).toBeTruthy();
    expect(sel.getByText("Anti-alias")).toBeTruthy();
    fireEvent.click(sel.getByLabelText("Interseca con la selezione (Maiusc+Alt)"));
    expect(sel.set).toEqual([{ selMode: "intersect" }]);
    cleanup();
    const wand = bar("wand");
    expect(wand.getByText("Tolleranza")).toBeTruthy();
    expect(wand.getByText("Contigui")).toBeTruthy();
    fireEvent.click(wand.getByText("Campiona tutti i livelli"));
    expect(wand.set).toEqual([{ sampleAll: true }]);
    cleanup();
    const brush = bar("brush");
    for (const w of ["Dimensione", "Durezza", "Opacità", "Flusso"])
      expect(brush.getByText(w)).toBeTruthy();
    cleanup();
    const pencil = bar("pencil");
    expect(pencil.queryByText("Durezza")).toBeNull();
    cleanup();
    const grad = bar("gradient");
    fireEvent.click(grad.getByText("Radiale"));
    expect(grad.set).toEqual([{ gradient: "radial" }]);
    cleanup();
    const move = bar("move");
    fireEvent.click(move.getByText("Trasformazione libera (Ctrl+T)"));
    expect(move.acts).toEqual(["transform"]);
    expect(move.container.querySelector("input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("crop and free transform have Apply and Cancel", () => {
    const c = bar("crop", { crop: { x: 0, y: 0, w: 10, h: 10 } });
    fireEvent.click(c.getByText("Applica"));
    fireEvent.click(c.getByText("Annulla"));
    expect(c.acts).toEqual(["apply", "cancel"]);
    cleanup();
    const x = bar("brush", { transforming: true });
    expect(x.queryByText("Dimensione")).toBeNull();
    fireEvent.click(x.getByText("Applica"));
    expect(x.acts).toEqual(["apply"]);
  });
});

describe("one gesture, one undo, Ctrl+Z after its revision (p3.5.7)", () => {
  const tile = (layer: string): ImagePlainAction => ({
    t: "tiles",
    layer,
    tiles: [{ x: 0, y: 0, w: 4, h: 4, png: "a".repeat(64) }],
    what: "transform",
  });

  it("each gesture travels with its own group", () => {
    const sent: ImageOutgoing[] = [];
    const c = new ImageCollab((o) => sent.push(o));
    c.reset(1);
    c.local([tile("a")], "transform", undefined, "g-1");
    c.local([{ t: "props", layer: "a", set: { x: 3 } }], "transform", undefined, "g-2");
    c.flush();
    c.ack(sent[0]?.clientId as string, 2);
    expect(sent.map((s) => s.group)).toEqual(["g-1", "g-2"]);
  });

  it("idle waits for the host to confirm every gesture (a reload or a refusal ends it too)", async () => {
    const sent: ImageOutgoing[] = [];
    const c = new ImageCollab((o) => sent.push(o));
    c.reset(12);
    await c.idle();
    c.local([tile("bg")], "transform", undefined, "g");
    c.flush();
    let done = false;
    const wait = c.idle().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    c.ack(sent[0]?.clientId as string, 13);
    await wait;
    expect(done).toBe(true);
    c.local([tile("bg")]);
    c.flush();
    const w2 = c.idle();
    expect(c.rejected(sent[1]?.clientId as string)).toBe(true);
    await w2;
    c.local([tile("bg")]);
    const w3 = c.idle();
    c.reset(20);
    await w3;
  });
});
