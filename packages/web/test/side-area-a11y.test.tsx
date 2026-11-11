// @vitest-environment jsdom
// The canvas's tabs from the keyboard (p3.5.11, G37.9): a real tab list (tabs only, each tied to
// its panel), one tab stop, the arrows choose, Delete closes the tab with the focus and keeps the
// focus in the strip, «?» opens the keyboard map (never while typing), and axe finds nothing
// serious in the strip.
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";
import { axeViolations } from "./helpers/axe.js";

vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => new Proxy({}, { get: () => () => new Promise(() => {}) }) as never,
}));

const { activeSide, sideViews } = await import("../src/state.js");
const { SideArea } = await import("../src/components/SideArea.js");
const { shortcutsOpen } = await import("../src/components/Shortcuts.js");

const frame = () => new Promise((r) => setTimeout(r, 40));
const open = (n: number) => {
  sideViews.value = Array.from({ length: n }, (_, i) => ({
    id: `canvas:platform:f${i}.png`,
    type: "canvas" as const,
    title: `File ${i}`,
    target: { kind: "file" as const, scope: "platform", path: `f${i}.png` },
  }));
  activeSide.value = sideViews.value[0]?.id ?? null;
};

beforeEach(() => {
  lang.value = "it";
  open(3);
});
afterEach(() => {
  cleanup();
  sideViews.value = [];
  shortcutsOpen.value = false;
});

describe("the canvas's tabs", () => {
  it("a tab list of tabs, each with its panel, one tab stop", async () => {
    const { container } = render(<SideArea />);
    const list = container.querySelector("[role=tablist]") as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("File e terminali aperti");
    const tabs = [...list.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    // The close buttons are out of the list and of the tab order (Delete closes).
    for (const b of list.querySelectorAll<HTMLElement>(".icon-button")) {
      expect(b.tabIndex).toBe(-1);
      expect(b.getAttribute("aria-hidden")).toBe("true");
    }
    const panel = document.getElementById(tabs[0]?.getAttribute("aria-controls") ?? "");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    const found = await axeViolations(list);
    expect(found).toEqual([]);
  });

  it("the arrows choose, Delete closes and keeps the focus in the strip", async () => {
    const { container } = render(<SideArea />);
    let tabs = [...container.querySelectorAll<HTMLElement>("[role=tab]")];
    (tabs[0] as HTMLElement).focus();
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(activeSide.value).toBe("canvas:platform:f1.png");
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: "End" });
    expect(activeSide.value).toBe("canvas:platform:f2.png");
    fireEvent.keyDown(tabs[2] as HTMLElement, { key: "Delete" });
    await frame();
    expect(sideViews.value.map((v) => v.id)).toEqual([
      "canvas:platform:f0.png",
      "canvas:platform:f1.png",
    ]);
    tabs = [...container.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(tabs).toHaveLength(2);
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("«?» opens the keyboard map, Escape closes it; never while typing", async () => {
    const { container } = render(
      <div>
        <input aria-label="campo" />
        <SideArea />
      </div>,
    );
    const field = container.querySelector("input") as HTMLElement;
    fireEvent.keyDown(field, { key: "?" });
    expect(shortcutsOpen.value).toBe(false);
    const tab = container.querySelector<HTMLElement>("[role=tab]") as HTMLElement;
    tab.focus();
    fireEvent.keyDown(tab, { key: "?" });
    expect(shortcutsOpen.value).toBe(true);
    await frame();
    const dialog = container.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.getAttribute("aria-label")).toBe("Scorciatoie");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.textContent).toContain("Canc");
    fireEvent.keyDown(window, { key: "Escape" });
    await frame();
    expect(shortcutsOpen.value).toBe(false);
    expect(document.activeElement).toBe(tab);
  });
});
