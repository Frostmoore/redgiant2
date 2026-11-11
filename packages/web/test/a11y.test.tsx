// @vitest-environment jsdom
// Accessible editors (p3.5.11, G37.9): axe on our rendered pieces (the rules jsdom can judge),
// the keyboard in toolbars, tab lists and menus (one tab stop, the arrows, Home and End, Escape
// giving the focus back), our window keeping and returning the focus, the PDF's page keys and
// field names, Univer's DOM made readable, one live region that never says the same thing twice,
// and the keyboard map in both languages.
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  announce,
  installKeyboard,
  menuOwner,
  resetAnnounce,
  rovingKey,
  syncRoving,
  typingIn,
} from "../src/a11y.js";
import { keyName, SHORTCUTS, Shortcuts, shortcutsOpen } from "../src/components/Shortcuts.js";
import { Modal } from "../src/components/ui.js";
import { MarkedChanges } from "../src/components/viewers/DocEditor.js";
import { pictureWords } from "../src/components/viewers/ImageEditor.js";
import { ImageToolbar } from "../src/components/viewers/ImageToolbar.js";
import { nameFields, pageKey } from "../src/components/viewers/PdfEditor.js";
import { type Key, lang, t } from "../src/i18n.js";
import { defaultShown } from "../src/viewers/image-tools.js";
import { patchSheetDom } from "../src/viewers/univer-a11y.js";
import { axeViolations } from "./helpers/axe.js";

/** The frames the keyboard helpers wait for. */
const frame = () => new Promise((r) => setTimeout(r, 40));
const key = (el: Element, k: string, o: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key: k, bubbles: true, ...o });

beforeEach(() => {
  lang.value = "it";
});
afterEach(() => {
  cleanup();
  shortcutsOpen.value = false;
  resetAnnounce();
  lang.value = "it";
  document.body.innerHTML = "";
});

describe("axe on our pieces", () => {
  it("the picture editor's left bar, with a flyout open", async () => {
    const { container } = render(
      <ImageToolbar
        tool="brush"
        shown={defaultShown()}
        onTool={() => {}}
        fg="#000000"
        bg="#ffffff"
        onColor={() => {}}
        onSwap={() => {}}
        onDefault={() => {}}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.contextMenu(container.querySelector("[data-group=lasso]") as HTMLElement);
    expect(container.querySelector("[role=menu]")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("the agents' changes, the keyboard map, a window", async () => {
    const { container } = render(
      <MarkedChanges
        changes={[
          {
            revision: 3,
            ts: Date.now(),
            author: "god",
            authorName: "God",
            groupId: "turn:1",
            summary: { kind: "edit", lines: 2 },
          } as never,
        ]}
        onShow={() => {}}
        onUndo={() => {}}
        onUndoTurn={() => {}}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    // The count is the one live part: the list's buttons are not announced at each change.
    expect(container.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(container.querySelector("[role=status]")?.classList.contains("doc-marks-count")).toBe(
      true,
    );
    cleanup();
    shortcutsOpen.value = true;
    const map = render(<Shortcuts />);
    expect(await axeViolations(map.container)).toEqual([]);
    expect(map.container.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe(
      "Scorciatoie",
    );
  });

  it("the helper finds a real problem (an icon button with no name)", async () => {
    const { container } = render(
      <div>
        <button type="button">
          <svg aria-hidden="true" />
        </button>
      </div>,
    );
    const found = await axeViolations(container);
    expect(found.map((f) => f.id)).toContain("button-name");
  });
});

/** A toolbar, a tab list and a menu button, as the editors draw them. */
function Bars({ onTab }: { onTab: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  return (
    <div>
      <div role="toolbar" aria-label="Strumenti">
        <button type="button">Uno</button>
        <button type="button" aria-pressed="true">
          Due
        </button>
        <button type="button" disabled>
          Spento
        </button>
        <select aria-label="Esporta">
          <option>PNG</option>
        </select>
        <span class="svg-menu">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Aggiungi
          </button>
          {open && (
            <div role="menu" aria-label="Aggiungi">
              <button type="button" role="menuitem" onClick={() => setOpen(false)}>
                Cubo
              </button>
              <button type="button" role="menuitem">
                Sfera
              </button>
            </div>
          )}
        </span>
      </div>
      <div role="tablist" aria-label="Fogli">
        {["A", "B", "C"].map((n, i) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={tab === i}
            onClick={() => {
              setTab(i);
              onTab(i);
            }}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

describe("the keyboard in the canvas", () => {
  it("toolbars: one tab stop, the arrows, Home and End; fields keep their own stop", () => {
    const { container } = render(<Bars onTab={() => {}} />);
    const off = installKeyboard(container as HTMLElement);
    const [one, two, , add] = [...container.querySelectorAll<HTMLElement>("[role=toolbar] button")];
    // Focus coming in makes the item the one stop.
    (one as HTMLElement).focus();
    expect((one as HTMLElement).tabIndex).toBe(0);
    expect((two as HTMLElement).tabIndex).toBe(-1);
    key(one as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(two);
    // The disabled button is skipped; the select is not an arrow stop.
    key(two as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(add);
    key(add as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(one);
    key(one as HTMLElement, "End");
    expect(document.activeElement).toBe(add);
    key(add as HTMLElement, "Home");
    expect(document.activeElement).toBe(one);
    expect(container.querySelector("select")?.tabIndex).toBe(0);
    // Ctrl with an arrow is not ours.
    key(one as HTMLElement, "ArrowRight", { ctrlKey: true });
    expect(document.activeElement).toBe(one);
    off();
  });

  it("tab lists: the arrows choose the tab", () => {
    const chosen: number[] = [];
    const { container } = render(<Bars onTab={(n) => chosen.push(n)} />);
    const off = installKeyboard(container as HTMLElement);
    const tabs = [...container.querySelectorAll<HTMLElement>("[role=tab]")];
    (tabs[0] as HTMLElement).focus();
    key(tabs[0] as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(tabs[2]);
    expect(chosen).toEqual([2]);
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    off();
  });

  it("menus: Enter opens and focuses the first item, arrows move, Escape closes and returns", async () => {
    const { container } = render(<Bars onTab={() => {}} />);
    const off = installKeyboard(container as HTMLElement);
    const add = [...container.querySelectorAll<HTMLElement>("button")].find(
      (b) => b.textContent === "Aggiungi",
    ) as HTMLElement;
    add.focus();
    key(add, "Enter");
    // Enter makes a click (the browser's); here it is made by hand.
    fireEvent.click(add);
    await frame();
    const menu = container.querySelector("[role=menu]") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menuOwner(menu)).toBe(add);
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(document.activeElement).toBe(items[0]);
    key(items[0] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(items[1] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key(items[0] as HTMLElement, "Escape");
    await frame();
    await frame();
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(add);
    // The down arrow opens it too.
    key(add, "ArrowDown");
    await frame();
    expect(container.querySelector("[role=menu]")).not.toBeNull();
    off();
  });

  it("the picture editor's groups: the right arrow opens the flyout, Escape returns", async () => {
    const picked: string[] = [];
    const { container } = render(
      <ImageToolbar
        tool="lasso"
        shown={defaultShown()}
        onTool={(x) => picked.push(x)}
        fg="#000000"
        bg="#ffffff"
        onColor={() => {}}
        onSwap={() => {}}
        onDefault={() => {}}
      />,
    );
    const off = installKeyboard(container as HTMLElement);
    const lasso = container.querySelector<HTMLElement>("[data-group=lasso]") as HTMLElement;
    lasso.focus();
    key(lasso, "ArrowRight");
    await frame();
    const checked = container.querySelector<HTMLElement>("[role=menuitemradio][aria-checked=true]");
    expect(checked).not.toBeNull();
    expect(document.activeElement).toBe(checked);
    key(checked as HTMLElement, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Lazo poligonale");
    key(document.activeElement as HTMLElement, "Escape");
    await frame();
    await frame();
    expect(container.querySelector(".img-flyout")).toBeNull();
    expect(document.activeElement).toBe(lasso);
    // The column moves with up and down.
    key(lasso, "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.group).toBe("select");
    expect(picked).toEqual([]);
    off();
  });

  it("rovingKey and syncRoving on any group", () => {
    document.body.innerHTML =
      '<div id="g"><button aria-selected="false">a</button><button aria-selected="true">b</button></div>';
    const g = document.getElementById("g") as HTMLElement;
    syncRoving(g, "button");
    const [a, b] = [...g.querySelectorAll("button")];
    expect(a?.tabIndex).toBe(-1);
    expect(b?.tabIndex).toBe(0);
    b?.focus();
    const e = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    Object.defineProperty(e, "target", { value: b });
    expect(rovingKey(e, g, "button")).toBe(a);
    expect(document.activeElement).toBe(a);
    expect(e.defaultPrevented).toBe(true);
  });

  it("typing in a field or an editor is never a shortcut", () => {
    document.body.innerHTML =
      '<input id="i"><input id="c" type="color"><div class="cm-editor"><div id="e" contenteditable="true"></div></div><button id="b"></button>';
    expect(typingIn(document.getElementById("i"))).toBe(true);
    expect(typingIn(document.getElementById("e"))).toBe(true);
    expect(typingIn(document.getElementById("c"))).toBe(false);
    expect(typingIn(document.getElementById("b"))).toBe(false);
  });
});

describe("our window", () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Apri
        </button>
        {open && (
          <Modal title="Prova" onClose={() => setOpen(false)}>
            <button type="button">Primo</button>
            <button type="button">Ultimo</button>
          </Modal>
        )}
      </div>
    );
  }

  it("takes the focus, keeps Tab inside, gives the focus back on Escape", async () => {
    const { getByText, container } = render(<Opener />);
    const opener = getByText("Apri");
    opener.focus();
    fireEvent.click(opener);
    await frame();
    expect(document.activeElement).toBe(getByText("Primo"));
    // The X (in the head) is the window's first stop, «Ultimo» its last: Tab goes round.
    const last = getByText("Ultimo");
    const x = container.querySelector(".ui-modal-x") as HTMLElement;
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: "Escape" });
    await frame();
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("PDF, pictures, sheets", () => {
  it("page keys", () => {
    expect(pageKey("PageDown", 1, 5)).toBe(2);
    expect(pageKey("PageDown", 5, 5)).toBe(5);
    expect(pageKey("PageUp", 1, 5)).toBe(1);
    expect(pageKey("PageUp", 3, 5)).toBe(2);
    expect(pageKey("Home", 3, 5)).toBe(1);
    expect(pageKey("End", 3, 5)).toBe(5);
    expect(pageKey("a", 3, 5)).toBeUndefined();
  });

  it("a form's fields get a name, their own words", async () => {
    document.body.innerHTML =
      '<div class="annotationLayer"><input name="data_nascita"><select name="citta"><option>Roma</option></select><input title="Firma"><input></div>';
    const layer = document.querySelector(".annotationLayer") as HTMLElement;
    expect((await axeViolations(layer)).map((f) => f.id)).toContain("label");
    nameFields(layer);
    const [a, b, c, d] = [...layer.querySelectorAll("input, select")];
    expect(a?.getAttribute("aria-label")).toBe("data nascita");
    expect(b?.getAttribute("aria-label")).toBe("citta");
    expect(c?.getAttribute("aria-label")).toBeNull();
    expect(d?.getAttribute("aria-label")).toBe("Campo del modulo");
    expect(await axeViolations(layer)).toEqual([]);
  });

  it("the picture in words", () => {
    expect(pictureWords({ w: 1200, h: 800 }, { name: "Testo", w: 400, h: 120 }, 3, undefined)).toBe(
      "Immagine 1200 × 800 px, 3 livelli. Livello attivo: Testo, 400 × 120 px.",
    );
    lang.value = "en";
    expect(pictureWords({ w: 10, h: 10 }, undefined, 1, { w: 4.4, h: 2 })).toBe(
      "Picture 10 × 10 px, 1 layers. Selection 4 × 2 px.",
    );
  });

  it("Univer's sheet bar: names, roles and tab stops", async () => {
    document.body.innerHTML = `<div id="u">
      <div data-u-comp="defined-name"><input type="text" value="A1"><a type="button" aria-haspopup="dialog" aria-expanded="false">v</a></div>
      <button data-u-comp="sheet-bar-append-button"><svg></svg></button>
      <div type="button" aria-haspopup="menu" aria-expanded="false" data-slot="dropdown-menu-trigger"><button data-u-comp="sheet-bar-append-button"><svg></svg></button></div>
      <div data-u-comp="sheet-bar-scroll-buttons"><button data-u-comp="sheet-bar-append-button"></button><button data-u-comp="sheet-bar-append-button"></button></div>
      <div role="track"></div>
      <canvas id="univer-sheet-main" tabindex="1" width="400" height="300"></canvas>
      <canvas id="univer-doc-main" tabindex="1" width="0" height="0"></canvas>
    </div>`;
    const u = document.getElementById("u") as HTMLElement;
    const before = (await axeViolations(u)).map((f) => f.id);
    expect(before).toEqual(expect.arrayContaining(["button-name", "label", "aria-roles"]));
    patchSheetDom(u);
    patchSheetDom(u);
    expect(await axeViolations(u)).toEqual([]);
    const names = [...u.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Aggiungi un foglio",
      "Tutti i fogli",
      "Fogli precedenti",
      "Fogli successivi",
    ]);
    expect(
      u.querySelector("[data-slot=dropdown-menu-trigger] button")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect((u.querySelector("#univer-sheet-main") as HTMLElement).tabIndex).toBe(0);
    expect((u.querySelector("#univer-doc-main") as HTMLElement).tabIndex).toBe(-1);
  });
});

describe("what is said", () => {
  it("one live region, the same words once in a moment", async () => {
    announce("Salvato", 1000);
    announce("Salvato", 1500);
    const regions = document.querySelectorAll("[data-a11y-announce]");
    expect(regions).toHaveLength(1);
    await frame();
    expect(regions[0]?.textContent).toBe("Salvato");
    expect(regions[0]?.getAttribute("aria-live")).toBe("polite");
    (regions[0] as Element).textContent = "";
    announce("Salvato", 1800);
    await frame();
    expect(regions[0]?.textContent).toBe("");
    announce("Salvato", 4000);
    await frame();
    expect(regions[0]?.textContent).toBe("Salvato");
  });
});

describe("the keyboard map", () => {
  it("every row in both languages, keys as words, opened with «?»", () => {
    for (const l of ["it", "en"] as const) {
      lang.value = l;
      for (const s of SHORTCUTS) {
        expect(t(s.title)).not.toBe("");
        for (const [keys, what] of s.rows) {
          expect(t(what as Key)).not.toBe("");
          const printed = keyName(keys);
          expect(printed).not.toMatch(/@k/);
          // No arrow symbols or other drawn characters: key names are words.
          expect(printed).not.toMatch(/[←-⇿⌀-⏿☀-➿]/);
        }
      }
    }
    lang.value = "it";
    expect(keyName("@kDelete")).toBe("Canc");
    lang.value = "en";
    expect(keyName("@kPageDown / @kPageUp")).toBe("Page Down / Page Up");
  });
});
