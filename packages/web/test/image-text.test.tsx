// @vitest-environment jsdom
// Typing on the picture (p3.5.8, Photoshop's Type tool): the text area over the canvas at the
// text's place and size times the zoom; typing goes live to the island; Esc, Ctrl+Enter commit
// (Enter is a new line); a new text left empty is dropped; a text layer opened again and left
// as it was sends nothing; the options change the whole text, point text keeping its anchor;
// one commit is one gesture to the host (one DocOp); the options bar is our controls only.
import { DEFAULT_TEXT, type ImageText, TEXT_FONTS } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_OPTIONS,
  FontMenu,
  ImageOptions,
  type TextOptions,
} from "../src/components/viewers/ImageOptions.js";
import { lang } from "../src/i18n.js";
import { ImageCollab, type ImageOutgoing } from "../src/viewers/image-ops.js";
import {
  cssFamily,
  overlayBox,
  TextEditing,
  type TextEditOpen,
  type TextEditResult,
  textEditActions,
} from "../src/viewers/image-text-edit.js";
import { DEFAULT_OPTIONS } from "../src/viewers/image-tools.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  lang.value = "it";
});

const spec = (o: Partial<ImageText> = {}): ImageText => ({
  ...DEFAULT_TEXT,
  text: "",
  size: 20,
  ox: 0,
  oy: 0,
  ...o,
});

/** A host with a fake measure: 10 px a character, one line of size × leading per line. */
function setup(zoom = 2) {
  const stage = document.createElement("div");
  document.body.append(stage);
  const live: TextEditOpen[] = [];
  const commits: TextEditResult[] = [];
  const cancels: (string | undefined)[] = [];
  const z = { v: zoom };
  const ed = new TextEditing({
    stage,
    zoom: () => z.v,
    measure: (t) => {
      const lines = t.text.split("\n");
      // Paragraph text: one line per line, those beyond the box hidden.
      return t.box
        ? {
            w: t.box.w,
            h: t.box.h,
            hidden: Math.max(0, lines.length - Math.floor(t.box.h / (t.size * t.lineHeight))),
          }
        : {
            w: Math.max(...lines.map((l) => l.length * 10)),
            h: lines.length * t.size * t.lineHeight,
          };
    },
    onLive: (s) => live.push(s),
    onCommit: (r) => commits.push(r),
    onCancel: (id) => cancels.push(id),
  });
  const type = (text: string) => {
    const el = ed.textarea as HTMLTextAreaElement;
    el.value = text;
    fireEvent.input(el);
  };
  const key = (k: string, mod = {}) =>
    fireEvent.keyDown(ed.textarea as HTMLTextAreaElement, { key: k, ...mod });
  return { stage, ed, live, commits, cancels, type, key, z };
}

describe("typing on the picture", () => {
  it("a click opens a text area at the text's place, its size times the zoom, the caret in it", () => {
    const { stage, ed } = setup(2);
    ed.open({ spec: spec({ size: 20, lineHeight: 1.2 }), bx: 30, by: 40 });
    const el = stage.querySelector("textarea.img-text-edit") as HTMLTextAreaElement;
    expect(el).toBeTruthy();
    expect(document.activeElement).toBe(el);
    expect(el.style.left).toBe("60px");
    expect(el.style.top).toBe("80px");
    expect(el.style.fontSize).toBe("40px");
    expect(el.style.lineHeight).toBe("48px");
    expect(el.style.whiteSpace).toBe("pre");
    // Not the browser's letters once the island draws them.
    ed.live = true;
    ed.restyle();
    expect(el.style.color).toBe("transparent");
  });

  it("types live; Enter is a new line; Esc commits once, and the text area goes", () => {
    const { stage, ed, live, commits, type, key } = setup();
    ed.open({ spec: spec(), bx: 5, by: 6 });
    type("Ciao");
    expect(live.at(-1)?.spec.text).toBe("Ciao");
    key("Enter");
    expect(commits).toHaveLength(0);
    type("Ciao\nmondo");
    key("Escape");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.layer).toBeUndefined();
    expect(commits[0]).toMatchObject({ bx: 5, by: 6, changed: true });
    expect(commits[0]?.spec.text).toBe("Ciao\nmondo");
    expect(stage.querySelector("textarea")).toBeNull();
    expect(ed.active).toBe(false);
    // Nothing more on a second Esc.
    ed.commit();
    expect(commits).toHaveLength(1);
  });

  it("Ctrl+Enter commits; a new text left empty is dropped", () => {
    const a = setup();
    a.ed.open({ spec: spec(), bx: 0, by: 0 });
    a.type("x");
    a.key("Enter", { ctrlKey: true });
    expect(a.commits).toHaveLength(1);
    const b = setup();
    b.ed.open({ spec: spec(), bx: 0, by: 0 });
    b.type("   ");
    b.key("Escape");
    expect(b.commits).toHaveLength(0);
    expect(b.cancels).toEqual([undefined]);
  });

  it("a text layer opened again and left as it was sends nothing; changed, it commits its layer", () => {
    const a = setup();
    a.ed.open({ layer: "t1", spec: spec({ text: "Uno" }), bx: 1, by: 2 });
    expect((a.ed.textarea as HTMLTextAreaElement).value).toBe("Uno");
    a.key("Escape");
    expect(a.commits).toHaveLength(0);
    expect(a.cancels).toEqual(["t1"]);
    const b = setup();
    b.ed.open({ layer: "t1", spec: spec({ text: "Uno" }), bx: 1, by: 2 });
    b.ed.setSpec({ bold: true });
    b.ed.commit();
    expect(b.commits[0]).toMatchObject({ layer: "t1", spec: { text: "Uno", bold: true } });
    // Opening another text commits the one being typed.
    const c = setup();
    c.ed.open({ spec: spec(), bx: 0, by: 0 });
    c.type("Primo");
    c.ed.open({ spec: spec(), bx: 50, by: 50 });
    expect(c.commits.map((r) => r.spec.text)).toEqual(["Primo"]);
    expect(c.stage.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("the editor's keys never see the typing", () => {
    const { stage, ed, key } = setup();
    const seen: string[] = [];
    stage.addEventListener("keydown", (e) => seen.push(e.key));
    ed.open({ spec: spec(), bx: 0, by: 0 });
    key("v");
    key("z", { ctrlKey: true });
    expect(seen).toEqual([]);
  });

  it("follows the zoom; centred point text keeps its centre as it grows; paragraph text its box", () => {
    const { ed, type, z } = setup(1);
    ed.open({ spec: spec({ align: "center" }), bx: 100, by: 10 });
    type("abcd");
    // 40 px wide, centred on 100: its box starts at 80.
    expect(ed.state?.bx).toBe(80);
    z.v = 3;
    ed.restyle();
    const el = ed.textarea as HTMLTextAreaElement;
    expect(el.style.fontSize).toBe("60px");
    const box = overlayBox(ed.state as TextEditOpen, { w: 40, h: 24 }, 3);
    expect(el.style.left).toBe(`${box.left}px`);
    ed.cancel();
    ed.open({ spec: spec({ box: { w: 200, h: 80 } }), bx: 10, by: 10 });
    const p = ed.textarea as HTMLTextAreaElement;
    expect(p.style.width).toBe("600px");
    expect(p.style.height).toBe("240px");
    expect(p.style.whiteSpace).toBe("pre-wrap");
    expect(p.classList.contains("paragraph")).toBe(true);
  });

  it("a commit is one gesture to the host: one DocOp (a new layer, or the text and its pixels)", () => {
    const { ed, commits, type, key } = setup();
    const sent: ImageOutgoing[] = [];
    const collab = new ImageCollab((o) => sent.push(o));
    collab.reset(3);
    ed.open({ spec: spec(), bx: 5, by: 6 });
    type("Saldi");
    key("Escape");
    const r = commits[0] as TextEditResult;
    const out = { x: 4, y: 5, w: 50, h: 22, text: { ...r.spec, ox: 1, oy: 1 } };
    collab.local(
      textEditActions(undefined, out, "a".repeat(64), { id: "p-1", name: "Saldi", above: "bg" }),
      "text",
    );
    collab.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toMatchObject({
      t: "add",
      above: "bg",
      layer: { id: "p-1", name: "Saldi", text: { text: "Saldi", ox: 1, oy: 1 } },
    });
    collab.ack(sent[0]?.clientId as string, 4);
    const edit = textEditActions("p-1", out, "b".repeat(64), { rename: "Saldi!" });
    collab.local(edit, "text");
    collab.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.action).toMatchObject({
      t: "batch",
      what: "text",
      ops: [
        { t: "props", layer: "p-1", set: { name: "Saldi!", text: { text: "Saldi" } } },
        { t: "pixels", layer: "p-1", x: 4, y: 5, w: 50, h: 22, what: "text" },
      ],
    });
  });
});

describe("the caret, the selection and the overflow", () => {
  it("opens with the caret at a character, or a range selected (backwards too)", () => {
    const a = setup();
    a.ed.open({ layer: "t", spec: spec({ text: "Ciao mondo" }), bx: 0, by: 0 }, 4);
    expect(a.ed.selection).toEqual([4, 4]);
    a.type("Ciao bel mondo");
    a.ed.cancel();
    a.ed.open({ layer: "t", spec: spec({ text: "Ciao mondo" }), bx: 0, by: 0 }, [8, 2]);
    expect(a.ed.selection).toEqual([2, 8]);
    expect(a.ed.textarea?.selectionDirection).toBe("backward");
    a.ed.cancel();
    a.ed.open({ layer: "t", spec: spec({ text: "abc" }), bx: 0, by: 0 }, 99);
    expect(a.ed.selection).toEqual([3, 3]);
  });

  it("shows Photoshop's overflow mark while paragraph text is longer than its box", () => {
    const { stage, ed, type } = setup(2);
    ed.open({ spec: spec({ size: 10, lineHeight: 1, box: { w: 100, h: 20 } }), bx: 10, by: 10 });
    type("uno\ndue");
    expect(stage.querySelector(".img-text-overflow")).toBeNull();
    type("uno\ndue\ntre");
    const m = stage.querySelector(".img-text-overflow") as HTMLElement;
    expect(m).toBeTruthy();
    expect(ed.overflowing).toBe(true);
    // The box's bottom right corner, times the zoom; drawn, not a character.
    expect([m.style.left, m.style.top]).toEqual(["220px", "60px"]);
    expect(m.querySelector("svg path")).toBeTruthy();
    expect(m.textContent).toBe("");
    type("uno");
    expect(stage.querySelector(".img-text-overflow")).toBeNull();
    type("1\n2\n3");
    ed.commit();
    expect(stage.querySelector(".img-text-overflow")).toBeNull();
  });
});

describe("the font menu", () => {
  it("lists every family, each name in its own font; picks one; Esc closes it alone", () => {
    const picked: string[] = [];
    let opened = 0;
    const r = render(
      <FontMenu value="sans" onChange={(f) => picked.push(f)} onOpen={() => opened++} />,
    );
    const btn = r.getByLabelText("Carattere: Liberation Sans");
    expect(btn.style.fontFamily).toContain("RG sans");
    fireEvent.click(btn);
    expect(opened).toBe(1);
    const items = r.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(TEXT_FONTS.map((f) => f.name));
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(
      TEXT_FONTS.map((f) => String(f.id === "sans")),
    );
    for (const [i, f] of TEXT_FONTS.entries())
      expect((items[i] as HTMLElement).style.fontFamily).toBe(cssFamily(f.id));
    expect(cssFamily("mono")).toContain("monospace");
    expect(cssFamily("noto-serif")).toContain("serif");
    fireEvent.click(r.getByRole("menuitemradio", { name: "Montserrat" }));
    expect(picked).toEqual(["montserrat"]);
    expect(r.queryByRole("menu")).toBeNull();
    fireEvent.click(btn);
    const outer: string[] = [];
    document.addEventListener("keydown", (e) => outer.push(e.key));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(r.queryByRole("menu")).toBeNull();
    expect(outer).toEqual([]);
    expect(r.container.querySelector("select")).toBeNull();
  });
});

describe("the Text tool's options bar", () => {
  const bar = (over: Partial<Parameters<typeof ImageOptions>[0]> = {}) => {
    const set: TextOptions[] = [];
    const colors: string[] = [];
    const r = render(
      <ImageOptions
        tool="text"
        opts={{ ...DEFAULT_OPTIONS }}
        setOpts={() => {}}
        brush={{ size: 12, opacity: 1, hardness: 1, flow: 1, color: "#ff0000" }}
        setBrush={() => {}}
        text={{ ...DEFAULT_TEXT_OPTIONS }}
        setText={(o) => set.push(o)}
        textColor="#123456"
        setTextColor={(c) => colors.push(c)}
        sel={undefined}
        hasMask={false}
        onMask={false}
        setOnMask={() => {}}
        crop={undefined}
        transforming={false}
        act={() => {}}
        {...over}
      />,
    );
    return { ...r, set, colors };
  };

  it("font, size, leading, alignment, bold, italic and colour; our controls only", () => {
    const { container, getByLabelText, set } = bar();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
    expect(getByLabelText("Carattere: Liberation Sans")).toBeTruthy();
    fireEvent.change(getByLabelText("Dimensione del testo"), { target: { value: "72" } });
    expect(set.at(-1)).toMatchObject({ size: 72 });
    fireEvent.change(getByLabelText("Interlinea %"), { target: { value: "150" } });
    expect(set.at(-1)).toMatchObject({ lineHeight: 1.5 });
    fireEvent.click(getByLabelText("Al centro"));
    expect(set.at(-1)).toMatchObject({ align: "center" });
    fireEvent.click(getByLabelText("Grassetto"));
    expect(set.at(-1)).toMatchObject({ bold: true });
    fireEvent.click(getByLabelText("Corsivo"));
    expect(set.at(-1)).toMatchObject({ italic: true });
    expect((getByLabelText("Colore del testo") as HTMLElement).style.background).toContain(
      "rgb(18, 52, 86)",
    );
    // Drawn icons, no symbol characters.
    expect(getByLabelText("Grassetto").querySelector("svg")).toBeTruthy();
    expect(getByLabelText("Allinea a destra").querySelector("svg")).toBeTruthy();
  });

  it("says how to type, and while typing that the options change the whole text", () => {
    expect(bar().container.textContent).toContain("trascina un riquadro");
    cleanup();
    expect(bar({ typing: true }).container.textContent).toContain("cambiano tutto il testo");
    cleanup();
    lang.value = "en";
    expect(bar({ typing: true }).container.textContent).toContain("change the whole text");
  });
});
