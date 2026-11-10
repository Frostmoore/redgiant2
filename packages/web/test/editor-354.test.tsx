// @vitest-environment jsdom
// p3.5.4, the editors' defects from the person's test of 3.5.3 on Windows: highlights that last
// until seen, «Annulla tutto il turno» from the first edit and an undo icon of one size, the agent
// stopped where the person types told to the person, a broken JSON marked in its tree, open
// copies in their original's tab, «Modifica»'s sentence on a line of its own, a drawing whose
// viewBox does not start at 0,0.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocChange } from "@redgiant/protocol";
import { render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heldText } from "../src/components/viewers/DocEditor.js";
import { Branch } from "../src/components/viewers/TreeBranch.js";
import { setLang } from "../src/i18n.js";
import {
  activeSide,
  applyMessage,
  canvasViewId,
  docView,
  emptyDocView,
  HELD_NOTICE_MS,
  openCanvas,
  reduceDoc,
  sideViews,
} from "../src/state.js";
import { copyOriginal } from "../src/viewers/office-bridge.js";
import { afterSeen, SEEN_TICK_MS } from "../src/viewers/seen.js";
import { viewBoxOrigin } from "../src/viewers/svg-ops.js";
import { jsonPathAt, linesAround, parseTree } from "../src/viewers/tree.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("a highlight lasts until the person could see it", () => {
  it("counts only the time the editor is shown", () => {
    vi.useFakeTimers();
    let shown = false;
    const done = vi.fn();
    afterSeen(2000, done, () => shown);
    // A minute with the page in the background or another tab in front: still there.
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    shown = true;
    vi.advanceTimersByTime(1500);
    expect(done).not.toHaveBeenCalled();
    shown = false;
    vi.advanceTimersByTime(10_000);
    shown = true;
    vi.advanceTimersByTime(500);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * SEEN_TICK_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled (the editor closed)", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const cancel = afterSeen(1000, done, () => true);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});

const change = (revision: number, over: Partial<DocChange> = {}): DocChange => ({
  revision,
  ts: new Date().toISOString(),
  author: "god",
  authorName: "God",
  groupId: "turn:t1",
  summary: { text: "changed line 16", kind: "replace", line: 16 },
  wrote: [[0, 2]],
  ...over,
});

describe("the panel «Modifiche»", () => {
  it("offers «Annulla tutto il turno» from an agent's first edit of a turn", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const f = { scope: "platform", path: "turno.json" };
    const { container, rerender } = render(<DocEditor file={f} />);
    // The host answers the editor's doc.open: one revision of God's turn.
    applyMessage({
      type: "doc.opened",
      file: f,
      family: "text",
      revision: 1,
      snapshot: { family: "text", text: "{}" },
      changes: [change(1)],
      proposals: [],
      presence: [],
      mode: "now",
      modeOwn: false,
    });
    rerender(<DocEditor file={f} />);
    expect(container.querySelectorAll(".doc-undo-turn")).toHaveLength(1);
    expect(container.querySelector(".doc-undo-turn")?.textContent).toBe("Annulla tutto il turno");
  });

  it("draws «Annulla questa modifica» at one size: its words only in its title", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");
    const rule = css.match(/\.doc-undo\.vw-icon \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/width: 28px/);
    expect(rule).toMatch(/height: 28px/);
    // Nothing makes it grow on hover anymore.
    expect(css).not.toMatch(/:hover \.doc-undo span/);
  });
});

describe("an agent's edit that came by a resynchronisation is highlighted too", () => {
  it("opened again at a later revision: its text marked, not only on the first opening", async () => {
    const { TextEditor } = await import("../src/components/viewers/TextEditor.js");
    const f = { scope: "platform", path: "risinc.txt" };
    const opened = (revision: number, text: string, changes: DocChange[]) =>
      applyMessage({
        type: "doc.opened",
        file: f,
        family: "text",
        revision,
        snapshot: { family: "text", text },
        changes,
        proposals: [],
        presence: [],
        mode: "now",
        modeOwn: false,
      });
    const { container } = render(<TextEditor file={f} name="risinc.txt" onReady={() => {}} />);
    opened(1, "uno\ndue\n", [change(1, { author: "person", wrote: [] })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll(".doc-agent-mark")).toHaveLength(0);
    // God's revision 2 never came live: the page asked for the file again.
    opened(2, "uno\ndue\ntre\n", [
      change(2, { wrote: [[8, 11]] }),
      change(1, { author: "person" }),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".doc-agent-mark")?.textContent).toBe("tre");
  });
});

describe("the agent stopped by the person is told to the person (p3.5.4)", () => {
  it("doc.held in the file's view, in the person's words", () => {
    setLang("it");
    const v = reduceDoc(emptyDocView(), {
      type: "doc.held",
      file: { scope: "platform", path: "a.txt" },
      who: "god",
      name: "God",
      code: "busy",
      line: 22,
      revision: 11,
    });
    expect(v.held).toMatchObject({ who: "god", name: "God", code: "busy", line: 22 });
    expect(heldText({ code: "busy", line: 22 }, "God")).toBe(
      "God voleva cambiare la riga 22 mentre ci scrivevi: si è fermato, la tua modifica viene prima.",
    );
    expect(heldText({ code: "conflict", line: 22 }, "God")).toBe(
      "God voleva cambiare la riga 22, che hai appena cambiato tu: si è fermato e la rilegge.",
    );
    expect(heldText({ code: "busy" }, "God")).toMatch(/il punto in cui stai scrivendo/);
    setLang("en");
    expect(heldText({ code: "busy", line: 22 }, "God")).toBe(
      "God wanted to change line 22 while you were typing there: it stopped, your edit comes first.",
    );
    setLang("it");
  });

  it("the shell shows it discreetly, and it goes by itself", async () => {
    vi.useFakeTimers();
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const f = { scope: "platform", path: "held.txt" };
    const { container, rerender } = render(<DocEditor file={f} />);
    applyMessage({ type: "doc.held", file: f, who: "god", name: "God", code: "busy", line: 3 });
    rerender(<DocEditor file={f} />);
    const notice = container.querySelector(".doc-held");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("God voleva cambiare la riga 3 mentre ci scrivevi");
    vi.advanceTimersByTime(HELD_NOTICE_MS + 10);
    expect(docView(f).value.held).toBeUndefined();
  });
});

describe("a broken JSON in the tree (p3.5.4)", () => {
  const broken = '{\n  "negozio": "Bottega di Ada",\n  "iva": 0.22,\n  "livello": "info",\n}\n';

  it("finds the value where the error is", () => {
    expect(jsonPathAt(broken, broken.lastIndexOf(","))).toEqual(["livello"]);
    const deep = '{"a": {"b": [1, 2, {"c": true,}]}}';
    expect(jsonPathAt(deep, deep.indexOf(",}"))).toEqual(["a", "b", "2", "c"]);
    const missing = '{"a": 1 "b": 2}';
    expect(jsonPathAt(missing, missing.indexOf('"b"'))).toEqual(["a"]);
    expect(jsonPathAt("// note\n[1, 2,]", 13)).toEqual(["1"]);
    expect(jsonPathAt("{", 0)).toEqual([]);
  });

  it("marks that node in the tree and opens the way to it", async () => {
    const node = await parseTree(broken, "json");
    const { container } = render(
      <Branch node={node} depth={0} open={0} mark={["livello"]} why="Trailing comma" />,
    );
    const bad = container.querySelector(".bad");
    expect(bad?.textContent).toContain("livello");
    expect(bad?.getAttribute("title")).toBe("Trailing comma");
    expect(container.querySelectorAll(".bad")).toHaveLength(1);
  });

  it("shows the lines around an error where no tree can be built", () => {
    expect(linesAround("a\nb\nc\nd\ne\nf\ng\nh", 5, 2)).toEqual([
      { n: 3, text: "c", bad: false },
      { n: 4, text: "d", bad: false },
      { n: 5, text: "e", bad: true },
      { n: 6, text: "f", bad: false },
      { n: 7, text: "g", bad: false },
    ]);
  });
});

describe("an open copy lives in its original's tab (p3.5.4)", () => {
  it("knows each copy's original", () => {
    expect(copyOriginal("docs/lettera.docx.open/lettera.odt")).toBe("docs/lettera.docx");
    expect(copyOriginal("presentazione.pptx.open/presentazione.odp")).toBe("presentazione.pptx");
    expect(copyOriginal("conti/bilancio.xlsx.open/bilancio.ods")).toBe("conti/bilancio.xlsx");
    expect(copyOriginal("logo.ai.open/logo.svg")).toBe("logo.ai");
    expect(copyOriginal("docs/lettera.odt")).toBeUndefined();
    // A conversion only to see it is not an open copy.
    expect(copyOriginal("film.mov.open/film.webm")).toBeUndefined();
  });

  it("opening the copy takes the original's tab, under the original's name", () => {
    sideViews.value = [];
    const original = { kind: "file" as const, scope: "platform", path: "docs/lettera.docx" };
    const copy = { ...original, path: "docs/lettera.docx.open/lettera.odt" };
    expect(canvasViewId(copy)).toBe(canvasViewId(original));
    openCanvas("lettera.docx", original);
    openCanvas("lettera.odt", copy);
    expect(sideViews.value).toHaveLength(1);
    expect(sideViews.value[0]).toMatchObject({ title: "lettera.docx", target: copy });
    expect(activeSide.value).toBe(canvasViewId(original));
    sideViews.value = [];
  });

  it("says what «Modifica» brings down on a line of its own", async () => {
    setLang("it");
    const { EditCopyNote } = await import("../src/components/viewers/OfficeEditor.js");
    const { container, findByRole } = render(<EditCopyNote />);
    const note = await findByRole("note");
    // jsdom is not a secure page: the fallback, said in full (not squeezed beside the button).
    expect(note.className).toBe("canvas-edit-strip");
    expect(container.textContent).toMatch(/HTTPS/);
  });
});

describe("a drawing whose viewBox does not start at 0,0 (p3.5.4)", () => {
  it("reads where it starts", () => {
    expect(viewBoxOrigin("-20 -10 400 300")).toEqual({ x: -20, y: -10 });
    expect(viewBoxOrigin("5,7,10,10")).toEqual({ x: 5, y: 7 });
    expect(viewBoxOrigin("0 0 210 148")).toEqual({ x: 0, y: 0 });
    expect(viewBoxOrigin(null)).toEqual({ x: 0, y: 0 });
    expect(viewBoxOrigin("a b c")).toEqual({ x: 0, y: 0 });
  });
});
