// @vitest-environment jsdom
// Heavy tabs kept alive (3.5.11): the tab in view and the most recently seen stay loaded, the
// others are let go and come back where the person was; terminals, sites and agents' apps stay.
// Also the drawing editor's recorder of what svgcanvas hangs on the window.
import { cleanup, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orders, report } from "../src/viewers/live.js";
import {
  mayUnload,
  placeDo,
  touch,
  WARM_TABS,
  type WarmView,
  warmTabs,
} from "../src/viewers/warm.js";

const file = (id: string, path = `${id}.pdf`): WarmView => ({
  id,
  type: "canvas",
  target: { kind: "file", scope: "platform", path },
});

describe("which tabs stay loaded (3.5.11)", () => {
  it("keeps the active tab and the most recently seen, up to WARM_TABS", () => {
    const views = ["a", "b", "c", "d", "e"].map((x) => file(x));
    expect(WARM_TABS).toBe(3);
    expect([...warmTabs(views, ["c", "a", "e", "b"], "d")].sort()).toEqual(["a", "c", "d"]);
    // Tabs never seen come last.
    expect([...warmTabs(views, [], "b")].sort()).toEqual(["a", "b", "c"]);
    // At least the one in view, whatever the cap.
    expect([...warmTabs(views, ["a"], "e", 0)]).toEqual(["e"]);
  });

  it("never lets go of terminals, the screen, sites, agents' apps and ports", () => {
    const views: WarmView[] = [
      { id: "t", type: "terminal" },
      { id: "s", type: "screen" },
      file("site", "web/index.html"),
      file("app", "artefatti/giochino.html"),
      { id: "port", type: "canvas", target: { kind: "port", agentId: "x", port: 3000 } },
      file("a"),
      file("b"),
    ];
    expect(views.filter(mayUnload).map((v) => v.id)).toEqual(["a", "b"]);
    const keep = warmTabs(views, ["b"], "a", 1);
    expect([...keep].sort()).toEqual(["a", "app", "port", "s", "site", "t"]);
  });

  it("puts the tab seen now first, once", () => {
    expect(touch(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touch(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });

  it("turns where the person was into a move (never a text's line: the text keeps its own)", () => {
    expect(placeDo(undefined)).toBeUndefined();
    expect(placeDo({ line: 40, lines: 300 })).toBeUndefined();
    expect(placeDo({ page: 7, pages: 30, zoom: 150 })).toEqual({ page: 7, zoom: 150 });
    expect(placeDo({ time: 0, duration: 60 })).toBeUndefined();
    expect(placeDo({ time: 12.5, playing: true })).toEqual({ time: 12.5 });
    expect(placeDo({ sheet: "Marzo", cells: "B2:C4", zoom: 2 })).toEqual({
      sheet: "Marzo",
      cells: "B2:C4",
    });
  });
});

vi.mock("../src/components/Canvas.js", () => ({
  Canvas: ({ target }: { target: { path: string } }) => (
    <div class="fake-canvas" data-path={target.path} />
  ),
}));
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => new Proxy({}, { get: () => () => new Promise(() => {}) }) as never,
}));

describe("the area lets heavy tabs go and brings them back (3.5.11)", () => {
  afterEach(async () => {
    cleanup();
    const { sideViews } = await import("../src/state.js");
    sideViews.value = [];
  });

  it("draws WARM_TABS editors of five, and the one come back where it was", async () => {
    const { activeSide, sideViews } = await import("../src/state.js");
    const { SideArea } = await import("../src/components/SideArea.js");
    sideViews.value = ["a", "b", "c", "d", "e"].map((x) => ({
      id: `canvas:platform:${x}.pdf`,
      type: "canvas" as const,
      title: x,
      target: { kind: "file" as const, scope: "platform", path: `${x}.pdf` },
    }));
    const drawn = () =>
      [...document.querySelectorAll(".fake-canvas")].map((e) => e.getAttribute("data-path")).sort();
    activeSide.value = "canvas:platform:a.pdf";
    const { rerender } = render(<SideArea />);
    for (const x of ["b", "c", "d", "e"]) {
      activeSide.value = `canvas:platform:${x}.pdf`;
      rerender(<SideArea />);
    }
    await waitFor(() => expect(drawn()).toEqual(["c.pdf", "d.pdf", "e.pdf"]));
    // «a» was at page 7 when it was let go: back on it, its viewer is asked to go there again,
    // without a note in the tab's head.
    report("canvas:platform:a.pdf", { page: 7, pages: 9 });
    activeSide.value = "canvas:platform:a.pdf";
    rerender(<SideArea />);
    await waitFor(() => expect(drawn()).toEqual(["a.pdf", "d.pdf", "e.pdf"]));
    await waitFor(() => expect(orders.value.get("canvas:platform:a.pdf")?.do).toEqual({ page: 7 }));
  });
});

describe("what svgcanvas hangs on the window (3.5.11)", () => {
  it("is recorded while it starts and taken off when the editor closes", async () => {
    const { windowListeners } = await import("../src/viewers/window-listeners.js");
    const target = new EventTarget();
    const seen: string[] = [];
    const rec = windowListeners(target);
    target.addEventListener("storage", () => seen.push("storage"));
    rec.stop();
    target.addEventListener("other", () => seen.push("other"));
    target.dispatchEvent(new Event("storage"));
    rec.remove();
    target.dispatchEvent(new Event("storage"));
    target.dispatchEvent(new Event("other"));
    expect(seen).toEqual(["storage", "other"]);
    // The target's own addEventListener is back.
    expect(Object.hasOwn(target, "addEventListener")).toBe(false);
  });
});
