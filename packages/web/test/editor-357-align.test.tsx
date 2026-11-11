// @vitest-environment jsdom
// The person's test of 3.5.6 (p3.5.7): Ctrl+Z pressed before the last gesture was confirmed, the
// agents' changes listed compact, every remaining highlight kept after one is undone, and the
// copy bar saying plainly when an edit reaches the original Office file.
import type { DocChange } from "@redgiant/protocol";
import { fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPlainText } from "../src/components/viewers/CopyBar.js";
import { MarkedChanges } from "../src/components/viewers/DocEditor.js";
import { setLang } from "../src/i18n.js";
import { applyMessage, markedChanges, unmarkChange } from "../src/state.js";
import { holdMark } from "../src/viewers/agent-marks.js";
import { OwnUndo } from "../src/viewers/own-undo.js";
import { HIGHLIGHT_SEEN_MS, SEEN_TICK_MS } from "../src/viewers/seen.js";

afterEach(() => {
  vi.useRealTimers();
  setLang("it");
});

const change = (revision: number, over: Partial<DocChange> = {}): DocChange => ({
  revision,
  ts: new Date().toISOString(),
  author: "god",
  authorName: "God",
  groupId: "turn:t1",
  summary: { text: `changed line ${revision}`, kind: "replace", line: revision },
  ...over,
});

describe("Ctrl+Z while the person's last gesture is still on its way (p3.5.7)", () => {
  it("waits for its ack and takes back that gesture, not the one before", () => {
    const u = new OwnUndo();
    u.made(3, "g-a");
    // The drag g-b left; Ctrl+Z before the host confirmed it. Before p3.5.7 the undo went for
    // revision 3 (the gesture before) and the drag stayed on the host.
    expect(u.press("undo", true)).toBeUndefined();
    expect(u.release(true)).toEqual([]);
    u.made(4, "g-b");
    u.made(5, "g-b");
    expect(u.release(false)).toEqual([{ groupId: "g-b" }]);
    // Nothing pending: asked at once.
    u.changed({ revision: 6, undoOf: [4, 5] });
    expect(u.press("undo", false)).toEqual({ revision: 3 });
  });

  it("the file read again lets the waiting keys go", () => {
    const u = new OwnUndo();
    u.made(3, "g-a");
    u.press("undo", true);
    u.forget();
    expect(u.release(false)).toEqual([]);
  });
});

describe("the agents' highlighted changes, compact (p3.5.7)", () => {
  it("twenty changes: a count, «Annulla tutto il turno» beside it, a list that scrolls and folds", () => {
    setLang("it");
    const list = Array.from({ length: 20 }, (_, i) => change(20 - i));
    const undone: number[] = [];
    const turns: string[] = [];
    const { container, rerender } = render(
      <MarkedChanges
        changes={list}
        onShow={() => {}}
        onUndo={(r) => undone.push(r)}
        onUndoTurn={(g) => turns.push(g)}
      />,
    );
    const head = container.querySelector(".doc-marks-head");
    expect(head?.textContent).toContain("20 modifiche evidenziate, di God");
    // One line of buttons above, the changes in their own scrolling list (not in the line).
    expect(head?.querySelectorAll(".doc-mark-undo")).toHaveLength(0);
    expect(container.querySelectorAll(".doc-marks-list .doc-mark-undo")).toHaveLength(20);
    (container.querySelector(".doc-marks-turn") as HTMLElement).click();
    expect(turns).toEqual(["turn:t1"]);
    (container.querySelectorAll(".doc-mark-undo")[2] as HTMLElement).click();
    expect(undone).toEqual([18]);
    fireEvent.click(container.querySelector(".doc-marks-fold") as HTMLElement);
    expect(container.querySelector(".doc-marks-list")).toBeNull();
    setLang("en");
    rerender(
      <MarkedChanges
        changes={[change(1)]}
        onShow={() => {}}
        onUndo={() => {}}
        onUndoTurn={() => {}}
      />,
    );
    expect(container.querySelector(".doc-marks-head")?.textContent).toContain(
      "1 change highlighted, by God",
    );
    // One change alone: its own button is the turn.
    expect(container.querySelector(".doc-marks-turn")).toBeNull();
  });

  it("after «Annulla questa modifica» the other changes of the turn stay highlighted", () => {
    vi.useFakeTimers();
    const file = { scope: "platform", path: "venti.txt" };
    const el = document.createElement("div");
    document.body.append(el);
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    const fade = vi.fn();
    for (const r of [1, 2, 3]) holdMark(file, r, () => el, fade);
    // The person looks a while, then undoes revision 2 just before the others would go.
    vi.advanceTimersByTime(HIGHLIGHT_SEEN_MS - 2 * SEEN_TICK_MS);
    applyMessage({
      type: "doc.changed",
      file,
      revision: 4,
      ops: [
        { family: "text", engine: "codemirror-state", engineVersion: "6", op: { changes: [] } },
      ],
      change: change(4, { author: "person", undoOf: [2], groupId: "undo:x" }),
    } as never);
    // Before p3.5.7 revisions 1 and 3 faded a moment later, while the person was still on them.
    vi.advanceTimersByTime(HIGHLIGHT_SEEN_MS - 2 * SEEN_TICK_MS);
    expect(fade).not.toHaveBeenCalled();
    expect(markedChanges(file).value).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(4 * SEEN_TICK_MS);
    expect(fade).toHaveBeenCalledTimes(3);
    unmarkChange(file);
    el.remove();
  });
});

describe("the copy bar says plainly when the original changes (p3.5.7)", () => {
  it("off, on, and copies with no switch, in both languages", () => {
    setLang("it");
    const odp = "docs/presentazione.pptx.open/presentazione.odp";
    expect(copyPlainText("presentazione.pptx", odp, false)).toBe(
      "Le modifiche sono nella copia ODP; il file presentazione.pptx non cambia finché non accendi «Riscrivi anche l'originale» o usi «Esporta come…».",
    );
    expect(copyPlainText("presentazione.pptx", odp, true)).toBe(
      "Le modifiche sono nella copia ODP e, a ogni salvataggio, vengono scritte anche in presentazione.pptx.",
    );
    expect(copyPlainText("logo.ai", "logo.ai.open/logo.svg", undefined)).toBe(
      "Le modifiche sono nella copia SVG; il file logo.ai non cambia.",
    );
    setLang("en");
    expect(copyPlainText("bilancio.xlsx", "bilancio.xlsx.open/bilancio.ods", false)).toBe(
      "Edits are in the ODS copy; bilancio.xlsx does not change until you turn on «Write the original too» or use «Export as…».",
    );
  });
});
