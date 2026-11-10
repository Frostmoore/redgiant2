// @vitest-environment jsdom
// The drawing editor's layout settles (p3.5.6, the person's test on Windows: the drawing seen twice,
// slightly offset, flickering). svgcanvas is replaced by a stand-in that only records where it was
// asked to draw; the work area is a model of a browser's: a fractional size, classic scrollbars
// that take room when the box overflows, `clientWidth` rounded like Chromium's. The resize
// observer fires whenever the area's client size changes, as the browser does on the next frame.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@svgedit/svgcanvas/svgcanvas.js", () => {
  const NS = "http://www.w3.org/2000/svg";
  class FakeCanvas {
    root: SVGSVGElement;
    svgContent: SVGSVGElement;
    contentW = 640;
    contentH = 480;
    zoom = 1;
    updates: { w: number; h: number; x: number; y: number }[] = [];
    textActions = { setInputElem() {} };
    saveOptions: Record<string, unknown> = {};
    undoMgr = { addCommandToHistory() {}, resetUndoStack() {} };
    selectorManager: { selectorParentGroup: Element };
    constructor(container: HTMLElement) {
      this.root = document.createElementNS(NS, "svg") as SVGSVGElement;
      this.svgContent = document.createElementNS(NS, "svg") as SVGSVGElement;
      const g = document.createElementNS(NS, "g");
      this.root.append(this.svgContent, g);
      this.selectorManager = { selectorParentGroup: g };
      container.append(this.root);
      (globalThis as { __fakeCanvas?: FakeCanvas }).__fakeCanvas = this;
    }
    getSvgContent() {
      return this.svgContent;
    }
    setSvgString(text: string) {
      const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      this.contentW = Number(root.getAttribute("width"));
      this.contentH = Number(root.getAttribute("height"));
      return true;
    }
    setZoom(z: number) {
      this.zoom = z;
    }
    getZoom() {
      return this.zoom;
    }
    // As svgcanvas does: the drawing centred in the box, its viewBox from 0,0.
    updateCanvas(w: number, h: number) {
      const x = (w - this.contentW * this.zoom) / 2;
      const y = (h - this.contentH * this.zoom) / 2;
      this.svgContent.setAttribute("x", String(x));
      this.svgContent.setAttribute("y", String(y));
      this.svgContent.setAttribute("viewBox", `0 0 ${this.contentW} ${this.contentH}`);
      this.selectorManager.selectorParentGroup.setAttribute("transform", `translate(${x},${y})`);
      this.updates.push({ w, h, x, y });
    }
    bind() {}
    getMode() {
      return "select";
    }
    getNextId() {
      return "svg_1";
    }
    getSelectedElements() {
      return [];
    }
    clearSelection() {}
    addToSelection() {}
    getCurrentDrawing() {
      return { getNumLayers: () => 0, getCurrentLayerName: () => "", getLayerName: () => "" };
    }
  }
  return { default: FakeCanvas };
});

const { mountSvg } = await import("../src/viewers/svg-island.js");

interface Fake {
  updates: { w: number; h: number; x: number; y: number }[];
  svgContent: Element;
  selectorManager: { selectorParentGroup: Element };
}
const fake = () => (globalThis as unknown as { __fakeCanvas: Fake }).__fakeCanvas;

let observers: (() => void)[] = [];
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() {
    observers.push(this.cb);
  }
  disconnect() {
    observers = observers.filter((c) => c !== this.cb);
  }
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

/**
 * A work area `width` x `height` CSS px (fractional, as a grid cell often is), scrollbars `bar` px
 * wide when its content overflows; `extra` px of content beyond the box (what an inline svg adds
 * under itself, or anything else not foreseen).
 */
function area(width: number, height: number, bar = 15, extra = 0) {
  const el = document.createElement("div");
  const box = () => el.querySelector<HTMLElement>(".svg-canvas-box");
  const bars = () => {
    const b = box();
    const bw = Number.parseFloat(b?.style.width ?? "") || 0;
    const bh = (Number.parseFloat(b?.style.height ?? "") || 0) + extra;
    let v = false;
    let h = false;
    for (let i = 0; i < 3; i++) {
      h = bw > width - (v ? bar : 0);
      v = bh > height - (h ? bar : 0);
    }
    return { v, h };
  };
  Object.defineProperties(el, {
    clientWidth: { get: () => Math.round(width - (bars().v ? bar : 0)) },
    clientHeight: { get: () => Math.round(height - (bars().h ? bar : 0)) },
    offsetWidth: { get: () => Math.round(width) },
    offsetHeight: { get: () => Math.round(height) },
  });
  el.getBoundingClientRect = () => ({ width, height, left: 0, top: 0 }) as DOMRect;
  return el;
}

/** The page's clock, moved by hand. */
let clock = 0;
vi.spyOn(performance, "now").mockImplementation(() => clock);

/**
 * Frames until the area's client size stops changing (at most `max`), `step` ms apart; each change
 * fires the observer.
 */
function frames(el: HTMLElement, max = 20, step = 0) {
  let size = `${el.clientWidth}x${el.clientHeight}`;
  let n = 0;
  for (; n < max; n++) {
    clock += step;
    const now = `${el.clientWidth}x${el.clientHeight}`;
    if (now === size && n > 0) break;
    size = now;
    for (const cb of observers) cb();
  }
  return n;
}

function mount(el: HTMLElement, svg: string) {
  const island = mountSvg({
    area: el,
    textInput: document.createElement("input"),
    onActions() {},
    onSelect() {},
    onLayers() {},
    onEditing() {},
    onTool() {},
  });
  expect(island.load(svg)).toBe(true);
  return island;
}

const drawing = (w: number, h: number, vb = `0 0 ${w} ${h}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}"><rect width="10" height="10"/></svg>`;

afterEach(() => {
  observers = [];
});

describe("the drawing editor's layout", () => {
  // Frames a second apart: the guard against a layout undoing itself never steps in, what is seen
  // is what the size alone does.
  for (const [name, w, h] of [
    ["a drawing like the person's (an agent's poster)", 210, 148],
    ["a drawing wider than the area", 800, 450],
    ["a drawing the area's own size", 334, 337],
    ["a tall drawing", 400, 900],
  ] as const)
    for (const vb of ["0 0", "-50 -20"])
      it(`settles on a fractional area with classic scrollbars: ${name}, viewBox from ${vb}`, () => {
        const el = area(333.5, 337.21875);
        const island = mount(el, drawing(w, h, `${vb} ${w} ${h}`));
        const before = fake().updates.length;
        const n = frames(el, 20, 1000);
        expect(n).toBeLessThanOrEqual(2);
        expect(fake().updates.length - before).toBeLessThanOrEqual(2);
        // Nothing overflows at the fitted zoom: no scrollbars at all.
        expect(el.clientWidth).toBe(334);
        expect(el.clientHeight).toBe(337);
        // The box never larger than the area really is.
        const last = fake().updates.at(-1);
        expect(last?.w).toBeLessThanOrEqual(333.5);
        expect(last?.h).toBeLessThanOrEqual(337.21875);
        island.dispose();
      });

  it("keeps the file's own origin and the handles with it once settled (p3.5.4)", () => {
    const el = area(333.5, 337.21875);
    const island = mount(el, drawing(800, 450, "-50 -20 800 450"));
    frames(el, 20, 1000);
    const c = fake().svgContent;
    expect(c.getAttribute("viewBox")).toBe("-50 -20 800 450");
    const z = island.getZoom();
    const x = Number(c.getAttribute("x")) + 50 * z;
    const y = Number(c.getAttribute("y")) + 20 * z;
    expect(fake().selectorManager.selectorParentGroup.getAttribute("transform")).toBe(
      `translate(${x},${y})`,
    );
    island.dispose();
  });

  it("zoomed in, the scrollbars stay and the layout is still", () => {
    const el = area(333.5, 337.21875);
    const island = mount(el, drawing(210, 148));
    frames(el, 20, 1000);
    island.zoom(4);
    const before = fake().updates.length;
    expect(frames(el, 20, 1000)).toBeLessThanOrEqual(2);
    expect(fake().updates.length - before).toBeLessThanOrEqual(2);
    expect(el.clientWidth).toBe(319);
    expect(el.clientHeight).toBe(322);
    island.dispose();
  });

  it("an overflow nobody foresaw: the layout that would undo the last one a frame later waits", () => {
    // 7px of content under the box (an inline svg's room for descenders): every box that fills the
    // area overflows it. Without the guard: a new layout every frame, forever.
    const el = area(333.5, 337.21875, 15, 7);
    const island = mount(el, drawing(210, 148));
    const before = fake().updates.length;
    frames(el, 20);
    expect(fake().updates.length - before).toBeLessThanOrEqual(2);
    // Still: one more frame lays out nothing.
    const now = fake().updates.length;
    for (const cb of observers) cb();
    expect(fake().updates.length).toBe(now);
    island.dispose();
  });
});
