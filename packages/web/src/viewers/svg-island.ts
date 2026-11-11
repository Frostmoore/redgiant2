// The drawing editor's engine in the page (G37.6): @svgedit/svgcanvas (MIT, only that package:
// never the full `svgedit`, which carries LGPL code), under our own interface (SvgEditor.tsx).
// Loaded only when a drawing opens (its own chunk). The bundle carries a few changes to
// svgcanvas, made when it is built (vite.config.ts, `svgcanvasPatch`): attributes and elements of
// other programs kept, spaces in texts kept, command names that survive minification, no NaN on
// tspans, and a hook that tells us each command as it is made. The page never writes the file:
// the person's commands become the host's actions (viewers/svg-ops.ts).
import type { SvgAction, SvgPlainAction } from "@redgiant/protocol";
import SvgCanvas from "@svgedit/svgcanvas/svgcanvas.js";
import {
  actionsOf,
  applyToDom,
  assignVirtualIds,
  beforeOf,
  type Caught,
  markupOf,
  type Namer,
  namespacesOf,
  SVG_NS,
  touchedIds,
  viewBoxOrigin,
} from "./svg-ops.js";
import { windowListeners } from "./window-listeners.js";

export type SvgTool =
  | "select"
  | "rect"
  | "ellipse"
  | "line"
  | "path"
  | "fhpath"
  | "text"
  | "pathedit";

export interface SvgSelection {
  count: number;
  tag?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  angle?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  isGroup?: boolean;
  isPath?: boolean;
}

export interface SvgLayer {
  name: string;
  /** svgcanvas' own layer around the drawing's loose elements (not a layer of the file). */
  own: boolean;
  /** Locked in Inkscape: seen, not selectable. */
  locked: boolean;
  visible: boolean;
  current: boolean;
}

export interface SvgIsland {
  load(text: string): boolean;
  /** Others' actions; "reload" when the page must load the file again. */
  remote(actions: readonly SvgAction[], byAgent: boolean): "ok" | "reload";
  /** Whether the page renamed an element it shares a virtual id with others (load again after). */
  takeReload(): boolean;
  setTool(t: SvgTool): void;
  tool(): SvgTool;
  selection(): SvgSelection;
  setFill(c: string): void;
  setStroke(c: string): void;
  setStrokeWidth(n: number): void;
  setOpacity(n: number): void;
  setAngle(deg: number): void;
  setText(s: string): void;
  setFontSize(n: number): void;
  setFontFamily(f: string): void;
  setBold(on: boolean): void;
  setItalic(on: boolean): void;
  group(): void;
  ungroup(): void;
  order(to: "front" | "back" | "up" | "down"): void;
  align(to: "l" | "c" | "r" | "t" | "m" | "b"): void;
  distribute(axis: "x" | "y"): void;
  remove(): void;
  duplicate(): void;
  addPolygon(sides: number): void;
  nudge(dx: number, dy: number): void;
  selectAll(): void;
  zoom(z: number | "fit"): number;
  getZoom(): number;
  layers(): SvgLayer[];
  setLayer(name: string): void;
  toggleLayer(name: string): void;
  newLayer(name: string): void;
  /** Agents' elements outlined for a while (screen boxes, in the work area's coordinates). */
  boxesOf(ids: readonly string[]): { x: number; y: number; w: number; h: number }[];
  dispose(): void;
}

export interface IslandOptions {
  /** The work area (it scrolls); the island makes svgcanvas' container inside it. */
  area: HTMLElement;
  /** The hidden input text editing types into. */
  textInput: HTMLInputElement;
  onActions(actions: SvgPlainAction[]): void;
  onSelect(s: SvgSelection): void;
  onLayers(): void;
  onEditing(on: boolean): void;
  onTool(t: SvgTool): void;
}

// biome-ignore lint/suspicious/noExplicitAny: svgcanvas is untyped JavaScript
type Canvas = any;
// biome-ignore lint/suspicious/noExplicitAny: its commands too
type Cmd = any;

/** One svgcanvas at a time: its modules keep a single canvas each. */
let live: { dispose(): void } | undefined;

const PAD = 40;

export function mountSvg(o: IslandOptions): SvgIsland {
  live?.dispose();
  const box = document.createElement("div");
  box.className = "svg-canvas-box";
  o.area.replaceChildren(box);
  // svgcanvas has no way to end: what it hangs on the window (its clipboard's «storage»
  // listener) kept every closed editor alive (3.5.11). Noted here, taken off in dispose().
  const globals = windowListeners();
  let canvas: Canvas;
  try {
    canvas = new SvgCanvas(box, {
      initFill: { color: "FFCC00", opacity: 1 },
      initStroke: { color: "1F4E79", opacity: 1, width: 1 },
      text: { stroke_width: 0, font_size: 16, font_family: "sans-serif" },
      initOpacity: 1,
      dimensions: [640, 480],
      show_outside_canvas: true,
      selectNew: true,
      imgPath: "",
      baseUnit: "px",
    });
  } finally {
    globals.stop();
  }
  canvas.textActions.setInputElem(o.textInput);
  // Decimals as the file has them (svgcanvas rounds to 2 by default).
  canvas.saveOptions.round_digits = 8;

  // What the page knows of the file, and how it names it.
  let known = new Set<string>();
  /** A virtual id given a real one here: the real one's way back. */
  const virtualOf = new Map<string, string>();
  let tspans = new Map<string, string>();
  let ns: Record<string, string> = {};
  let reloadAfter = false;
  const caught = new WeakMap<Cmd, Caught>();

  const content = (): Element => canvas.getSvgContent();
  const byId = (id: string): Element | null => {
    if (id === "") return content();
    try {
      return content().querySelector(`[id="${CSS.escape(id)}"]`);
    } catch {
      return null;
    }
  };
  const namer: Namer = {
    ref(el) {
      if (!el) return undefined;
      if (el === content()) return "";
      // svgcanvas' own layer stands for the root.
      if (
        !el.getAttribute("id") &&
        el.parentElement === content() &&
        el.classList.contains("layer")
      )
        return "";
      return el.getAttribute("id") ?? undefined;
    },
    pageOnly: (el) => el.hasAttribute("data-rg-page") || !el.getAttribute("id"),
    known: (id) => known.has(id),
    fresh: (el) => {
      let id: string = canvas.getNextId();
      while (known.has(id) || byId(id)) id = canvas.getNextId();
      void el;
      return id;
    },
    get ns() {
      return ns;
    },
    tspanOf: (id) => tspans.get(id),
  };

  const rootLevelLayer = (el: Element) => el.parentElement === content() && el.tagName === "g";
  /** A command as it is made: what it did, in the file's names. */
  const catchCmd = (cmd: Cmd) => {
    const kind = cmd.constructor?.rgName ?? "";
    const el: Element | undefined = cmd.elem;
    if (!el || el === content()) return;
    if (kind === "InsertElementCommand") {
      if (el.hasAttribute("data-rg-page")) return;
      let xml: string;
      if (!el.getAttribute("id") && rootLevelLayer(el) && el.classList.contains("layer")) {
        // A layer made here: a layer of the file (Inkscape's when the file is Inkscape's).
        const id = namer.fresh("g");
        el.setAttribute("id", id);
        const name = el.querySelector("title")?.textContent ?? id;
        const esc = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        if (ns.inkscape) {
          el.querySelector("title")?.setAttribute("data-rg-page", "1");
          xml = `<g id="${esc(id)}" inkscape:groupmode="layer" inkscape:label="${esc(name)}" />`;
        } else xml = `<g id="${esc(id)}" class="layer"><title>${esc(name)}</title></g>`;
      } else {
        if (!el.getAttribute("id")) return;
        // Every element inside gets an id too (each can be changed later).
        for (const x of Array.from(el.getElementsByTagName("*")))
          if (!x.getAttribute("id") && !x.hasAttribute("data-rg-page"))
            x.setAttribute("id", namer.fresh(x));
        xml = markupOf(el, namer);
      }
      const parent = el.parentElement;
      caught.set(cmd, {
        k: "insert",
        el,
        parent: namer.ref(parent) ?? "",
        before: beforeOf(el, namer),
        xml,
      });
    } else if (kind === "RemoveElementCommand") {
      const id = el.getAttribute("id");
      if (id) caught.set(cmd, { k: "remove", el, id });
    } else if (kind === "MoveElementCommand") {
      const id = el.getAttribute("id");
      if (id)
        caught.set(cmd, {
          k: "move",
          el,
          id,
          parent: namer.ref(el.parentElement) ?? "",
          before: beforeOf(el, namer),
        });
    } else if (kind === "ChangeElementCommand") {
      const id = el.getAttribute("id");
      if (!id || el.hasAttribute("data-rg-page")) return;
      caught.set(cmd, { k: "change", el, id, values: { ...cmd.newValues } });
    }
  };
  const hook = globalThis as { __rgSvgCommand?: (cmd: Cmd) => void };
  hook.__rgSvgCommand = catchCmd;

  const flat = (cmd: Cmd, out: Cmd[] = []): Cmd[] => {
    if (Array.isArray(cmd?.stack)) for (const c of cmd.stack) flat(c, out);
    else out.push(cmd);
    return out;
  };
  const undoMgr = canvas.undoMgr;
  const add = undoMgr.addCommandToHistory.bind(undoMgr);
  undoMgr.addCommandToHistory = (cmd: Cmd) => {
    add(cmd);
    const list = flat(cmd)
      .map((c) => caught.get(c))
      .filter((c): c is Caught => !!c);
    const actions = actionsOf(list, namer, (el, id, ref) => {
      known.add(id);
      virtualOf.set(id, ref);
      if (!el) {
        // A tspan the page no longer has: the server's from now on.
        for (const [t, s] of tspans) if (s === ref) tspans.set(t, id);
      }
      // Another element shares this virtual id's fingerprint: the server counts them again.
      const base = ref.replace(/-\d+$/, "");
      if (content().querySelector(`[id^="${CSS.escape(base)}"]`)) reloadAfter = true;
    });
    for (const a of actions) if (a.t === "insert") for (const id of touchedIds([a])) known.add(id);
    // Our undo is the host's: svgcanvas' own history is not kept.
    undoMgr.resetUndoStack();
    if (actions.length) o.onActions(actions);
  };

  // ---- what the person sees ----
  const selected = (): Element[] =>
    (canvas.getSelectedElements() as (Element | null)[]).filter((e): e is Element => !!e);
  const num = (v: string | null | undefined) => {
    const n = Number.parseFloat(v ?? "");
    return Number.isFinite(n) ? n : undefined;
  };
  const selection = (): SvgSelection => {
    const els = selected();
    const el = els[0];
    if (!el) return { count: 0 };
    const cs = getComputedStyle(el);
    const tag = el.tagName;
    const text = tag === "text" ? (el.textContent ?? "") : undefined;
    return {
      count: els.length,
      tag,
      fill: el.getAttribute("fill") ?? cs.fill,
      stroke: el.getAttribute("stroke") ?? cs.stroke,
      strokeWidth: num(el.getAttribute("stroke-width")) ?? num(cs.strokeWidth) ?? 0,
      opacity: num(el.getAttribute("opacity")) ?? 1,
      angle: Math.round((canvas.getRotationAngle(el) ?? 0) * 100) / 100,
      ...(text !== undefined && {
        text,
        fontSize: num(el.getAttribute("font-size")) ?? num(cs.fontSize),
        fontFamily: el.getAttribute("font-family") ?? cs.fontFamily,
        bold:
          (el.getAttribute("font-weight") ?? cs.fontWeight) === "bold" ||
          Number(cs.fontWeight) >= 600,
        italic: (el.getAttribute("font-style") ?? cs.fontStyle) === "italic",
      }),
      isGroup: tag === "g",
      isPath: tag === "path",
    };
  };
  let mode: SvgTool = "select";
  canvas.bind("selected", () => {
    const s = selection();
    if (canvas.getMode() === "textedit" && s.text !== undefined) o.textInput.value = s.text;
    o.onSelect(s);
  });
  canvas.bind("changed", () => {
    unlockLayers();
    o.onSelect(selection());
    o.onLayers();
  });
  canvas.bind("transition", () => o.onSelect(selection()));
  // Every layer answers the mouse (svgcanvas lets only the current one): a click on another layer's
  // element makes that layer current; a layer Inkscape locked (sodipodi:insensitive) stays locked.
  const layerGroups = (): Element[] =>
    Array.from(content().children).filter(
      (g) => g.tagName === "g" && g.classList.contains("layer"),
    );
  const locked = (g: Element) => g.getAttribute("sodipodi:insensitive") === "true";
  const unlockLayers = () => {
    for (const g of layerGroups())
      (g as SVGElement).style.pointerEvents = locked(g) ? "none" : "all";
  };
  const layerNameOf = (g: Element): string | undefined => {
    const d = canvas.getCurrentDrawing();
    for (let i = 0; i < d.getNumLayers(); i++) {
      const name: string = d.getLayerName(i);
      if (d.getLayerByName(name) === g) return name;
    }
    return undefined;
  };
  const pickLayer = (e: MouseEvent) => {
    if (canvas.getMode() !== "select") return;
    let el = e.target as Element | null;
    while (el?.parentElement && el.parentElement !== content()) el = el.parentElement;
    if (!el || el.parentElement !== content() || !el.classList.contains("layer") || locked(el))
      return;
    const name = layerNameOf(el);
    if (name && name !== canvas.getCurrentDrawing().getCurrentLayerName()) {
      canvas.setCurrentLayer(name);
      unlockLayers();
      o.onLayers();
    }
  };
  box.addEventListener("mousedown", pickLayer, true);
  // Drawing or typing: the agents' edits wait (the host's presence).
  const down = () => o.onEditing(true);
  const up = () => {
    setTimeout(() => {
      o.onEditing(canvas.getMode() === "textedit");
      const m = canvas.getMode() as string;
      const t: SvgTool = m === "textedit" ? "text" : (m as SvgTool);
      if (
        t !== mode &&
        ["select", "rect", "ellipse", "line", "path", "fhpath", "text", "pathedit"].includes(t)
      ) {
        mode = t;
        o.onTool(t);
      }
    }, 0);
  };
  box.addEventListener("mousedown", down);
  window.addEventListener("mouseup", up);
  const onInput = () => canvas.setTextContent(o.textInput.value);
  o.textInput.addEventListener("input", onInput);

  let zoom = 1;
  /** Where the drawing's viewBox starts (p3.5.4): svgcanvas always draws it from 0,0. */
  let origin = { x: 0, y: 0 };
  /** What the last layout was made from: a resize that changes nothing lays out nothing. */
  let laidOut = "";
  /** The one before, and when the last was made: a layout that undoes itself is not repeated. */
  let laidBefore = "";
  let laidAt = 0;
  /**
   * The room the box may fill without overflowing (p3.5.6). `clientWidth` rounds to the nearest
   * pixel: an area 333.5px wide says 334, a box that size overflows by half a pixel, classic
   * scrollbars (Windows) appear, `clientWidth` drops by their width, the box shrinks, they go, and
   * so on every frame, the drawing re-centred each time: «seen twice, slightly offset». The real
   * size, rounded down, never overflows; only the drawing itself brings the scrollbars.
   */
  const room = (): { w: number; h: number } => {
    const a = o.area;
    const r = a.getBoundingClientRect();
    // offsetWidth - clientWidth: the borders and the scrollbar, when there is one.
    return {
      w: Math.max(0, Math.floor(r.width - (a.offsetWidth - a.clientWidth))),
      h: Math.max(0, Math.floor(r.height - (a.offsetHeight - a.clientHeight))),
    };
  };
  let disposed = false;
  const layout = (force = false) => {
    // A resize noticed in the frame the editor closed (3.5.11: svgcanvas then threw on its
    // removed background).
    if (disposed) return;
    const w: number = canvas.contentW ?? 640;
    const h: number = canvas.contentH ?? 480;
    const fill = room();
    const cw = Math.max(fill.w, w * zoom + 2 * PAD);
    const ch = Math.max(fill.h, h * zoom + 2 * PAD);
    const inputs = `${cw} ${ch} ${zoom} ${w} ${h} ${origin.x} ${origin.y}`;
    if (!force) {
      if (inputs === laidOut) return;
      // Back to the layout before within a few frames: this layout changed the area itself (an
      // overflow not foreseen). Staying put keeps the drawing still; the next real resize moves it.
      if (inputs === laidBefore && performance.now() - laidAt < 100) return;
    }
    laidBefore = laidOut;
    laidOut = inputs;
    laidAt = performance.now();
    box.style.width = `${cw}px`;
    box.style.height = `${ch}px`;
    try {
      canvas.updateCanvas(cw, ch);
    } catch (err) {
      // Taken out of the page with the closing tab, before dispose(): nothing to lay out.
      if (box.isConnected) throw err;
      return;
    }
    // A viewBox that does not start at 0,0 (p3.5.4, the person's test: the drawing seen twice,
    // «one sheet over the other, slightly shifted»): svgcanvas set "0 0 w h", which moved the
    // drawing off its page. The file's own origin back, and the selection's handles with it.
    if (origin.x || origin.y) {
      const c = content();
      c.setAttribute("viewBox", `${origin.x} ${origin.y} ${w} ${h}`);
      const x = Number(c.getAttribute("x")) - origin.x * zoom;
      const y = Number(c.getAttribute("y")) - origin.y * zoom;
      canvas.selectorManager?.selectorParentGroup?.setAttribute(
        "transform",
        `translate(${x},${y})`,
      );
    }
  };
  const fit = () => {
    const w: number = canvas.contentW ?? 640;
    const h: number = canvas.contentH ?? 480;
    const fill = room();
    const z = Math.min((fill.w - 2 * PAD) / w, (fill.h - 2 * PAD) / h);
    return Math.max(0.05, Math.min(z, 16));
  };
  const setZoom = (z: number) => {
    zoom = Math.max(0.05, Math.min(z, 32));
    canvas.setZoom(zoom);
    // Always: a file loaded again puts svgcanvas' own position back.
    layout(true);
    // svgcanvas redraws the selection's handles on its own `zoomed`; ask it again.
    const els = selected();
    if (els.length) {
      canvas.clearSelection();
      canvas.addToSelection(els, true);
    }
  };
  const resize = new ResizeObserver(() => layout());
  resize.observe(o.area);

  const island: SvgIsland = {
    load(text) {
      const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
      const root = parsed.documentElement;
      if (parsed.getElementsByTagName("parsererror").length || root.namespaceURI !== SVG_NS)
        return false;
      ns = namespacesOf(root);
      origin = viewBoxOrigin(root.getAttribute("viewBox"));
      assignVirtualIds(root);
      known = new Set(
        Array.from(root.getElementsByTagName("*")).map((e) => e.getAttribute("id") ?? ""),
      );
      known.delete("");
      tspans = new Map();
      for (const t of Array.from(root.getElementsByTagName("text"))) {
        const kids = Array.from(t.children);
        const loose = Array.from(t.childNodes).some(
          (n) => (n.nodeType === 3 || n.nodeType === 4) && n.nodeValue?.trim(),
        );
        const only = kids[0];
        if (kids.length === 1 && only?.localName === "tspan" && !only.children.length && !loose)
          tspans.set(t.getAttribute("id") ?? "", only.getAttribute("id") ?? "");
      }
      // Inkscape's layers are layers here too (the page's own class and title, never sent).
      for (const g of Array.from(root.children)) {
        if (g.localName !== "g" || g.getAttribute("inkscape:groupmode") !== "layer") continue;
        g.classList.add("layer");
        const title = parsed.createElementNS(SVG_NS, "title");
        title.setAttribute("data-rg-page", "1");
        title.textContent = g.getAttribute("inkscape:label") ?? g.getAttribute("id") ?? "";
        g.insertBefore(title, g.firstChild);
      }
      const ok = canvas.setSvgString(new XMLSerializer().serializeToString(parsed), true);
      if (!ok) return false;
      undoMgr.resetUndoStack();
      unlockLayers();
      setZoom(fit());
      o.onLayers();
      o.onSelect(selection());
      return true;
    },
    remote(actions, byAgent) {
      const keep = selected();
      const r = applyToDom(
        {
          root: content(),
          byId,
          ns,
          rootParent: () => canvas.getCurrentDrawing().getCurrentLayer() ?? content(),
          unnamed: (el, id) => {
            const v = virtualOf.get(id);
            if (v) el.setAttribute("id", v);
            else el.removeAttribute("id");
          },
        },
        actions,
      );
      if (r === "reload") return r;
      for (const id of touchedIds(actions)) known.add(id);
      for (const a of actions.flatMap((x) => (x.t === "batch" ? x.ops : [x])))
        if (a.t === "name") virtualOf.set(a.id, a.ref);
      if (
        actions.some((a) =>
          (a.t === "batch" ? a.ops : [a]).some(
            (p) => (p.t === "insert" || p.t === "move") && p.parent === "",
          ),
        )
      )
        canvas.identifyLayers();
      unlockLayers();
      canvas.clearSelection();
      const still = keep.filter((e) => e.isConnected);
      if (still.length) canvas.addToSelection(still, true);
      o.onLayers();
      o.onSelect(selection());
      void byAgent;
      return "ok";
    },
    takeReload() {
      const r = reloadAfter;
      reloadAfter = false;
      return r;
    },
    setTool(t) {
      mode = t;
      if (t === "pathedit") {
        const el = selected()[0];
        if (el?.tagName === "path") canvas.pathActions.toEditMode(el);
        else {
          mode = "select";
          canvas.setMode("select");
        }
        o.onTool(mode);
        return;
      }
      canvas.setMode(t);
      o.onTool(t);
    },
    tool: () => mode,
    selection,
    setFill: (c) => canvas.setColor("fill", c),
    setStroke: (c) => canvas.setColor("stroke", c),
    setStrokeWidth: (n) => canvas.setStrokeWidth(n),
    setOpacity: (n) => {
      canvas.changeSelectedAttribute("opacity", String(n));
      canvas.getCurShape().opacity = n;
    },
    setAngle: (deg) => canvas.setRotationAngle(deg),
    setText: (s) => {
      if (!selected().length) return;
      canvas.changeSelectedAttribute("#text", s);
    },
    setFontSize: (n) => canvas.setFontSize(n),
    setFontFamily: (f) => canvas.setFontFamily(f),
    setBold: (on) => canvas.setBold(on),
    setItalic: (on) => canvas.setItalic(on),
    group: () => canvas.groupSelectedElements(),
    ungroup: () => canvas.ungroupSelectedElement(),
    order(to) {
      if (to === "front") canvas.moveToTopSelectedElement();
      else if (to === "back") canvas.moveToBottomSelectedElement();
      else canvas.moveUpDownSelected(to === "up" ? "Up" : "Down");
    },
    align: (to) => canvas.alignSelectedElements(to, "selected"),
    distribute(axis) {
      const els = selected();
      if (els.length < 3) return;
      const z = canvas.getZoom();
      const c = (e: Element) => {
        const r = e.getBoundingClientRect();
        return axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
      };
      const items = els.map((e) => ({ e, c: c(e) })).sort((a, b) => a.c - b.c);
      const first = items[0]?.c ?? 0;
      const step = ((items.at(-1)?.c ?? 0) - first) / (items.length - 1);
      for (const [i, it] of items.entries()) {
        const d = (first + step * i - it.c) / z;
        if (Math.abs(d) < 1e-6) continue;
        canvas.selectOnly([it.e], true);
        canvas.moveSelectedElements(axis === "x" ? d : 0, axis === "y" ? d : 0, true);
      }
      canvas.clearSelection();
      canvas.addToSelection(els, true);
    },
    remove: () => canvas.deleteSelectedElements(),
    duplicate: () => canvas.cloneSelectedElements(10, 10),
    addPolygon(sides) {
      const n = Math.max(3, Math.min(24, Math.round(sides)));
      const w: number = canvas.contentW ?? 640;
      const h: number = canvas.contentH ?? 480;
      const r = Math.min(w, h) / 8;
      const pts = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        const f = (v: number) => Math.round(v * 1000) / 1000;
        return `${f(w / 2 + r * Math.cos(a))},${f(h / 2 + r * Math.sin(a))}`;
      }).join(" ");
      const el = canvas.addSVGElementsFromJson({
        element: "polygon",
        curStyles: true,
        attr: { id: namer.fresh("polygon"), points: pts },
      });
      canvas.addCommandToHistory(new canvas.history.InsertElementCommand(el));
      canvas.selectOnly([el], true);
      mode = "select";
      canvas.setMode("select");
      o.onTool("select");
    },
    nudge: (dx, dy) => {
      if (selected().length) canvas.moveSelectedElements(dx, dy, true);
    },
    selectAll: () => canvas.selectAllInCurrentLayer(),
    zoom(z) {
      setZoom(z === "fit" ? fit() : z);
      return zoom;
    },
    getZoom: () => zoom,
    layers() {
      const d = canvas.getCurrentDrawing();
      const n: number = d.getNumLayers();
      const cur: string = d.getCurrentLayerName();
      const out: SvgLayer[] = [];
      for (let i = n - 1; i >= 0; i--) {
        const name: string = d.getLayerName(i);
        const g: Element | null = d.getLayerByName(name);
        out.push({
          name,
          own: !!g && !g.getAttribute("id"),
          locked: !!g && locked(g),
          visible: g?.getAttribute("display") !== "none",
          current: name === cur,
        });
      }
      return out;
    },
    setLayer(name) {
      canvas.setCurrentLayer(name);
      unlockLayers();
      canvas.clearSelection();
      o.onLayers();
    },
    toggleLayer(name) {
      const g: Element | null = canvas.getCurrentDrawing().getLayerByName(name);
      canvas.setLayerVisibility(name, g?.getAttribute("display") === "none");
      o.onLayers();
    },
    newLayer(name) {
      canvas.createLayer(name);
      unlockLayers();
      o.onLayers();
    },
    boxesOf(ids) {
      const a = o.area.getBoundingClientRect();
      return ids
        .map((id) => byId(id))
        .filter((e): e is Element => !!e && e !== content())
        .map((e) => {
          const r = e.getBoundingClientRect();
          return {
            x: r.left - a.left + o.area.scrollLeft,
            y: r.top - a.top + o.area.scrollTop,
            w: r.width,
            h: r.height,
          };
        })
        .filter((r) => r.w > 0 || r.h > 0);
    },
    dispose() {
      disposed = true;
      resize.disconnect();
      globals.remove();
      // svgcanvas' modules keep the text field until the next editor: not this page's.
      canvas.textActions.setInputElem(document.createElement("input"));
      box.removeEventListener("mousedown", down);
      box.removeEventListener("mousedown", pickLayer, true);
      window.removeEventListener("mouseup", up);
      o.textInput.removeEventListener("input", onInput);
      if (hook.__rgSvgCommand === catchCmd) hook.__rgSvgCommand = undefined;
      box.remove();
      if (live === island) live = undefined;
    },
  };
  live = island;
  return island;
}
