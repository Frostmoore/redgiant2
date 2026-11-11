// Typing on the picture (p3.5.8, Photoshop's Type tool): a transparent text area laid over the
// canvas, at the text's place and size times the zoom, inside the stage (so it follows zoom and
// scrolling). The text area holds the caret, the selection and the keys; the letters themselves
// are drawn by the island with the shared renderer (`renderText`) as the person types, so what
// shows is what the layer will be. Until the font file has arrived the text area shows its own
// letters (the same family through a FontFace, else Arial's metrics). Enter makes a new line;
// Esc, Ctrl+Enter or a click elsewhere commits; a new text left empty is dropped.
import {
  type ImageLayerInfo,
  type ImagePlainAction,
  type ImageText,
  TEXT_FONTS,
} from "@redgiant/protocol";

/**
 * The CSS family of a text family (its files registered with FontFace by the island), then the
 * browser's family of the same kind while they are on their way.
 */
export function cssFamily(font: string): string {
  const kind = TEXT_FONTS.find((f) => f.id === font)?.kind ?? "sans-serif";
  const near =
    kind === "monospace"
      ? `"Liberation Mono", "Courier New", monospace`
      : kind === "serif"
        ? `"Liberation Serif", "Times New Roman", serif`
        : `"Liberation Sans", Arial, Helvetica, sans-serif`;
  return `"RG ${font}", ${near}`;
}

/** Photoshop's overflow mark: a small square with a plus, drawn (no symbol character). */
function overflowMark(): HTMLElement {
  const m = document.createElement("span");
  m.className = "img-text-overflow";
  m.setAttribute("aria-hidden", "true");
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M5 2v6M2 5h6");
  svg.append(path);
  m.append(svg);
  return m;
}

export interface TextEditOpen {
  /** The layer edited; undefined: a new text. */
  layer?: string;
  /** The text and its look (ox, oy are not used here). */
  spec: ImageText;
  /** The box's top left in the picture (before the rotation). */
  bx: number;
  by: number;
}

export interface TextEditResult extends TextEditOpen {
  /** The text or its look differ from what was opened (or it is new). */
  changed: boolean;
}

export interface TextEditHost {
  /** Where the text area goes: the stage, sized as the picture times the zoom. */
  stage: HTMLElement;
  zoom(): number;
  /**
   * The box of a text (its lines' width and height in the picture's pixels), and how many lines
   * of paragraph text do not fit it.
   */
  measure(spec: ImageText): { w: number; h: number; hidden?: number };
  /** The text changed (typing, the options bar): the island draws it again. */
  onLive(s: TextEditOpen): void;
  onCommit(r: TextEditResult): void;
  /** Editing ended without a change (or a new text left empty). */
  onCancel(layer: string | undefined): void;
}

/**
 * Where the text area sits and how it looks, in the stage's pixels: point text gets room for
 * the caret on the side it grows, paragraph text its own box.
 */
export function overlayBox(
  s: TextEditOpen,
  size: { w: number; h: number },
  zoom: number,
): { left: number; top: number; width: number; height: number; originX: number; originY: number } {
  const t = s.spec;
  const pad = t.box ? 0 : Math.max(2, t.size * 0.6);
  const leftPic = t.box ? s.bx : t.align === "left" ? s.bx : s.bx - pad;
  const widthPic = t.box ? t.box.w : size.w + (t.align === "center" ? 2 * pad : pad);
  const heightPic = t.box ? t.box.h : size.h;
  return {
    left: leftPic * zoom,
    top: s.by * zoom,
    width: Math.max(1, widthPic * zoom),
    height: Math.max(1, heightPic * zoom),
    originX: (s.bx + size.w / 2 - leftPic) * zoom,
    originY: (size.h / 2) * zoom,
  };
}

export class TextEditing {
  private el: HTMLTextAreaElement | undefined;
  private s: TextEditOpen | undefined;
  private first = "";
  private firstSpec = "";
  /** The island draws the letters (the font is here): the text area's own are transparent. */
  live = false;

  constructor(private readonly host: TextEditHost) {}

  get active(): boolean {
    return !!this.s;
  }
  get layer(): string | undefined {
    return this.s?.layer;
  }
  get state(): TextEditOpen | undefined {
    return this.s && { ...this.s, spec: { ...this.s.spec } };
  }
  get textarea(): HTMLTextAreaElement | undefined {
    return this.el;
  }

  /**
   * Starts typing in a text: the caret at `sel` (an index of the text, or a range selected),
   * at its end without one.
   */
  open(s: TextEditOpen, sel?: number | [number, number]): void {
    if (this.s) this.commit();
    this.s = { ...s, spec: { ...s.spec } };
    this.first = s.spec.text;
    this.firstSpec = JSON.stringify({ ...s.spec, text: "" });
    const el = document.createElement("textarea");
    el.className = "img-text-edit";
    el.spellcheck = false;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("aria-label", "text");
    el.wrap = s.spec.box ? "soft" : "off";
    el.value = s.spec.text;
    el.addEventListener("input", this.input);
    el.addEventListener("keydown", this.key);
    // The editor's own keys (tools, undo…) never see the typing.
    el.addEventListener("keyup", (e) => e.stopPropagation());
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el = el;
    this.host.stage.append(el);
    this.style();
    el.focus();
    const n = el.value.length;
    const [a, b] = sel === undefined ? [n, n] : typeof sel === "number" ? [sel, sel] : sel;
    const lo = Math.max(0, Math.min(n, Math.min(a, b)));
    const hi = Math.max(0, Math.min(n, Math.max(a, b)));
    el.setSelectionRange(lo, hi, a > b ? "backward" : "forward");
    this.host.onLive(this.state as TextEditOpen);
  }

  /** The caret and the selection in the text (start, end). */
  get selection(): [number, number] | undefined {
    const el = this.el;
    return el ? [el.selectionStart, el.selectionEnd] : undefined;
  }

  /** The options bar's change: the size, the font, the colour… of the whole text. */
  setSpec(o: Partial<ImageText>): void {
    const s = this.s;
    if (!s) return;
    this.reanchor(() => Object.assign(s.spec, o));
    if (this.el) this.el.wrap = s.spec.box ? "soft" : "off";
    this.style();
    this.host.onLive(this.state as TextEditOpen);
  }

  /** The zoom or the place changed: the text area follows. */
  restyle(): void {
    this.style();
  }

  /** Ends editing: the text goes to its layer (or nothing, when it is new and empty). */
  commit(): void {
    const s = this.s;
    if (!s) return;
    this.close();
    const changed =
      s.layer === undefined ||
      s.spec.text !== this.first ||
      JSON.stringify({ ...s.spec, text: "" }) !== this.firstSpec;
    if ((s.layer === undefined && !s.spec.text.trim()) || !changed) this.host.onCancel(s.layer);
    else this.host.onCommit({ ...s, changed });
  }

  /** Ends editing leaving the layer as it was. */
  cancel(): void {
    const s = this.s;
    if (!s) return;
    this.close();
    this.host.onCancel(s.layer);
  }

  private close() {
    this.s = undefined;
    const el = this.el;
    this.el = undefined;
    el?.remove();
    this.mark?.remove();
    this.mark = undefined;
  }

  /** The overflow mark shown now (paragraph text longer than its box). */
  private mark: HTMLElement | undefined;

  /**
   * Point text keeps its anchor while it changes (Photoshop's): the left edge, the centre or the
   * right edge, by its alignment.
   */
  private reanchor(change: () => void) {
    const s = this.s as TextEditOpen;
    const before = s.spec.box ? undefined : this.host.measure(s.spec).w;
    change();
    if (before === undefined || s.spec.box) return;
    const after = this.host.measure(s.spec).w;
    if (s.spec.align === "center") s.bx += (before - after) / 2;
    else if (s.spec.align === "right") s.bx += before - after;
  }

  private readonly input = () => {
    const s = this.s;
    const el = this.el;
    if (!s || !el) return;
    this.reanchor(() => {
      s.spec.text = el.value;
    });
    this.style();
    el.scrollTop = 0;
    el.scrollLeft = 0;
    this.host.onLive(this.state as TextEditOpen);
  };

  private readonly key = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this.commit();
    }
  };

  private style() {
    const s = this.s;
    const el = this.el;
    if (!s || !el) return;
    const t = s.spec;
    const zoom = this.host.zoom();
    const size = this.host.measure(t);
    // An empty line still has its height (the caret's).
    const box = overlayBox(s, { w: size.w, h: Math.max(size.h, t.size * t.lineHeight) }, zoom);
    const st = el.style;
    st.left = `${box.left}px`;
    st.top = `${box.top}px`;
    st.width = `${box.width}px`;
    st.height = `${box.height}px`;
    st.fontFamily = cssFamily(t.font);
    st.fontSize = `${t.size * zoom}px`;
    st.lineHeight = `${t.size * t.lineHeight * zoom}px`;
    st.fontWeight = t.bold ? "700" : "400";
    st.fontStyle = t.italic ? "italic" : "normal";
    st.textAlign = t.align;
    st.whiteSpace = t.box ? "pre-wrap" : "pre";
    st.color = this.live ? "transparent" : t.color.slice(0, 7);
    st.caretColor = t.color.slice(0, 7);
    st.transformOrigin = `${box.originX}px ${box.originY}px`;
    st.transform = t.rotate ? `rotate(${t.rotate}deg)` : "";
    el.classList.toggle("paragraph", !!t.box);
    // Photoshop's overflow mark in the box's bottom right corner (turned with the text).
    if (t.box && size.hidden) {
      this.mark ??= overflowMark();
      if (!this.mark.isConnected) this.host.stage.append(this.mark);
      const a = ((t.rotate ?? 0) * Math.PI) / 180;
      const dx = t.box.w / 2;
      const dy = t.box.h / 2;
      const cx = s.bx + dx + dx * Math.cos(a) - dy * Math.sin(a);
      const cy = s.by + dy + dx * Math.sin(a) + dy * Math.cos(a);
      this.mark.style.left = `${cx * zoom}px`;
      this.mark.style.top = `${cy * zoom}px`;
    } else {
      this.mark?.remove();
    }
  }

  /** Whether the overflow mark shows. */
  get overflowing(): boolean {
    return !!this.mark?.isConnected;
  }
}

/**
 * What a committed text sends to the host, as one gesture: a new text layer, or a text layer's
 * text and its pixels (one revision, one Ctrl+Z).
 */
export function textEditActions(
  layer: string | undefined,
  out: { x: number; y: number; w: number; h: number; text: ImageText },
  png: string | null,
  o: {
    /** A new layer's id, name and place. */
    id?: string;
    name?: string;
    above?: string | null;
    /** An edited layer's new name (it followed its text). */
    rename?: string;
    what?: "text" | "transform";
  } = {},
): ImagePlainAction[] {
  if (layer === undefined) {
    const info: ImageLayerInfo = {
      id: o.id ?? "text",
      name: o.name ?? "Text",
      x: out.x,
      y: out.y,
      w: out.w,
      h: out.h,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
      text: out.text,
    };
    return [{ t: "add", layer: info, above: o.above ?? null, png, mask: null }];
  }
  return [
    {
      t: "props",
      layer,
      set: { text: out.text, ...(o.rename !== undefined && { name: o.rename }) },
    },
    {
      t: "pixels",
      layer,
      x: out.x,
      y: out.y,
      w: out.w,
      h: out.h,
      png,
      what: o.what ?? "text",
    },
  ];
}
