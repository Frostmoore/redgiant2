// @vitest-environment jsdom
// The area next to the chat (p3.3.2): a divider that changes its width (mouse, finger, keyboard;
// kept on this device, within limits, a double click back to normal), «Maximize» over the whole
// window with «Back to chat» and Esc, a file on the whole screen, tabs whose long titles end
// with «…» and keep the whole title in their tooltip.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => new Proxy({}, { get: () => () => new Promise(() => {}) }) as never,
}));

const state = await import("../src/state.js");
const { SideArea } = await import("../src/components/SideArea.js");
const {
  CHAT_MIN,
  SIDE_MIN,
  activeSide,
  clampSideWidth,
  closeSide,
  loadSideWidth,
  sideMax,
  sideViews,
  sideWidth,
  sideWidthByKey,
} = state;

// jsdom lays nothing out: the chat and the area measure 1600 px together, the area 800.
const sizes = new Map<string, number>([
  ["side-area", 800],
  ["main", 800],
]);
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    for (const [cls, w] of sizes) if (this.classList.contains(cls)) return w;
    return 0;
  },
});
// jsdom has no PointerEvent: a mouse event with a pointer's id is enough here.
if (!("PointerEvent" in window)) {
  class PointerEventLike extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.assign(window, { PointerEvent: PointerEventLike });
}

// The area beside the chat, as in the page.
const Shell = () => (
  <div class="body">
    <main class="main" />
    <SideArea />
  </div>
);

const LONG = "7 · Confronto: PSD reale vs PNG convertito";
const open = (n = 1) => {
  sideViews.value = Array.from({ length: n }, (_, i) => ({
    id: `canvas:platform:f${i}.png`,
    type: "canvas" as const,
    title: i === 0 ? LONG : `File ${i}`,
    target: { kind: "file" as const, scope: "platform", path: `f${i}.png` },
  }));
  activeSide.value = sideViews.value[0]?.id ?? null;
};

beforeEach(() => {
  lang.value = "it";
  localStorage.clear();
  sideWidth.value = null;
  sideMax.value = false;
  open();
});
afterEach(() => {
  cleanup();
  sideViews.value = [];
});

describe("the area's width (p3.3.2)", () => {
  it("stays between its own minimum and what leaves the chat its room", () => {
    expect(clampSideWidth(100, 1600)).toBe(SIDE_MIN);
    expect(clampSideWidth(900, 1600)).toBe(900);
    expect(clampSideWidth(5000, 1600)).toBe(1600 - CHAT_MIN);
    // A window too small for both: the area keeps its minimum.
    expect(clampSideWidth(500, 600)).toBe(SIDE_MIN);
  });

  it("moves with the arrows (the left one widens it), Shift further, Home and End to the ends", () => {
    expect(sideWidthByKey("ArrowLeft", false, 800, 1600)).toBe(824);
    expect(sideWidthByKey("ArrowRight", false, 800, 1600)).toBe(776);
    expect(sideWidthByKey("ArrowLeft", true, 800, 1600)).toBe(920);
    expect(sideWidthByKey("Home", false, 800, 1600)).toBe(SIDE_MIN);
    expect(sideWidthByKey("End", false, 800, 1600)).toBe(1600 - CHAT_MIN);
    expect(sideWidthByKey("ArrowRight", false, SIDE_MIN, 1600)).toBe(SIDE_MIN);
    expect(sideWidthByKey("a", false, 800, 1600)).toBeNull();
  });

  it("is changed from the keyboard on the focused divider and kept on this device", () => {
    const { container } = render(<Shell />);
    const divider = container.querySelector(".side-resizer") as HTMLElement;
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.tabIndex).toBe(0);
    fireEvent.focus(divider);
    expect(divider.getAttribute("aria-valuemax")).toBe(String(1600 - CHAT_MIN));
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(sideWidth.value).toBe(824);
    expect(localStorage.getItem("rg.sideWidth")).toBe("824");
    const area = container.querySelector(".side-area") as HTMLElement;
    expect(area.style.flexBasis).toBe("824px");
    fireEvent.keyDown(divider, { key: "End" });
    expect(sideWidth.value).toBe(1600 - CHAT_MIN);
    // Enter: the normal width again, nothing kept.
    fireEvent.keyDown(divider, { key: "Enter" });
    expect(sideWidth.value).toBeNull();
    expect(localStorage.getItem("rg.sideWidth")).toBeNull();
    expect(area.style.flexBasis).toBe("");
  });

  it("follows a drag (mouse or finger) within its limits, a double click back to normal", () => {
    const { container } = render(<Shell />);
    const divider = container.querySelector(".side-resizer") as HTMLElement;
    fireEvent.pointerDown(divider, { button: 0, clientX: 800, pointerId: 3 });
    expect(document.body.classList.contains("side-resizing")).toBe(true);
    fireEvent.pointerMove(divider, { clientX: 700, pointerId: 3 });
    expect(sideWidth.value).toBe(900);
    // Not yet kept: only when the drag ends.
    expect(localStorage.getItem("rg.sideWidth")).toBeNull();
    fireEvent.pointerMove(divider, { clientX: -2000, pointerId: 3 });
    expect(sideWidth.value).toBe(1600 - CHAT_MIN);
    fireEvent.pointerMove(divider, { clientX: 1500, pointerId: 3 });
    expect(sideWidth.value).toBe(SIDE_MIN);
    fireEvent.pointerUp(divider, { clientX: 1500, pointerId: 3 });
    expect(document.body.classList.contains("side-resizing")).toBe(false);
    expect(localStorage.getItem("rg.sideWidth")).toBe(String(SIDE_MIN));
    fireEvent.dblClick(divider);
    expect(sideWidth.value).toBeNull();
    expect(localStorage.getItem("rg.sideWidth")).toBeNull();
  });

  it("comes back as it was left, on this device", () => {
    localStorage.setItem("rg.sideWidth", "640");
    expect(loadSideWidth()).toBe(640);
    localStorage.setItem("rg.sideWidth", "nonsense");
    expect(loadSideWidth()).toBeNull();
    localStorage.removeItem("rg.sideWidth");
    expect(loadSideWidth()).toBeNull();
  });
});

describe("Maximize (p3.3.2)", () => {
  it("puts the area over the window; «Back to chat» and Esc bring the chat back", () => {
    const { container, getByRole, queryByRole } = render(<Shell />);
    const area = container.querySelector(".side-area") as HTMLElement;
    fireEvent.click(getByRole("button", { name: "Ingrandisci" }));
    expect(sideMax.value).toBe(true);
    expect(area.classList.contains("max")).toBe(true);
    // The divider and the button itself are gone; the tabs and «Back to chat» stay.
    expect(container.querySelector(".side-resizer")).toBeNull();
    expect(queryByRole("button", { name: "Ingrandisci" })).toBeNull();
    expect(container.querySelectorAll('[role="tab"]').length).toBe(1);
    fireEvent.click(getByRole("button", { name: "Torna alla chat" }));
    expect(sideMax.value).toBe(false);
    expect(area.classList.contains("max")).toBe(false);

    fireEvent.click(getByRole("button", { name: "Ingrandisci" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sideMax.value).toBe(false);
  });

  it("leaves Esc to a field, an editor or a window that has it", () => {
    sideMax.value = true;
    const { container } = render(
      <div>
        <input class="field" />
        <Shell />
      </div>,
    );
    const field = container.querySelector(".field") as HTMLElement;
    fireEvent.keyDown(field, { key: "Escape" });
    expect(sideMax.value).toBe(true);
    const back = document.createElement("div");
    back.className = "ui-modal-back";
    document.body.append(back);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sideMax.value).toBe(true);
    back.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sideMax.value).toBe(false);
  });

  it("ends when the last tab closes: never an empty window", () => {
    open(2);
    sideMax.value = true;
    closeSide(sideViews.value[0]?.id ?? "");
    expect(sideMax.value).toBe(true);
    closeSide(sideViews.value[0]?.id ?? "");
    expect(sideMax.value).toBe(false);
  });
});

describe("the tabs and the file on the whole screen (p3.3.2)", () => {
  it("keep a long title whole in the tooltip, the text on one line inside the tab", () => {
    open(12);
    const { container } = render(<Shell />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(12);
    expect(tabs[0]?.getAttribute("title")).toBe(LONG);
    expect(tabs[0]?.querySelector(":scope > span:last-child")?.textContent).toBe(LONG);
    // The tabs scroll inside their own strip; «Maximize» is outside it, always reachable.
    const strip = container.querySelector(".side-tabs") as HTMLElement;
    expect(strip.querySelector(".side-max")).toBeNull();
    expect(container.querySelector(".side-bar > .side-max")).not.toBeNull();
  });

  // Passes alone and in CI; under the whole suite on Rig the lazy canvas sometimes remounts
  // between the click and the label: retried rather than slowed down for everyone.
  it("puts a file on the whole screen with the Fullscreen API, and back", {
    retry: 2,
  }, async () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    let full: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => full,
    });
    const request = vi.fn(async function (this: Element) {
      full = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exit = vi.fn(async () => {
      full = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.assign(HTMLElement.prototype, { requestFullscreen: request });
    Object.assign(document, { exitFullscreen: exit });
    try {
      const { container, findByRole } = render(<Shell />);
      // The canvas loads with its first tab (3.5.11); its effects run once it is drawn.
      const button = await findByRole("button", { name: "Schermo intero" }, { timeout: 5000 });
      // The lazy canvas is drawn (and its effects ran) before the click.
      await waitFor(() => expect(container.querySelector(".canvas")).not.toBeNull());
      await new Promise((r) => setTimeout(r, 20));
      fireEvent.click(button);
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.contexts[0]).toBe(container.querySelector(".canvas"));
      // On a busy machine (the whole suite on Rig) the label can take more than a second to flip.
      const slow = { timeout: 5000 };
      fireEvent.click(await findByRole("button", { name: "Esci dallo schermo intero" }, slow));
      await waitFor(() => expect(exit).toHaveBeenCalledTimes(1), slow);
      await findByRole("button", { name: "Schermo intero" }, slow);
    } finally {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    }
  });
});
