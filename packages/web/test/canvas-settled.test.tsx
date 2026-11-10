// @vitest-environment jsdom
// p3.5.6: the page answers an agent's look with what the person sees. Right after canvas_act it
// waits for the viewer to take the move and say where it is now (the look read «page 1» while the
// PDF turned to page 2), right after show_file for the new tab's viewer, never more than a moment;
// a tab that gets an open copy forgets what its viewer said of the original («page 1 of 3» beside
// a copy of four slides).

import { render } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canvasSnapshot,
  canvasViewId,
  closeSide,
  openCanvas,
  sideAside,
  sideViews,
} from "../src/state.js";
import {
  CanvasTab,
  lastMove,
  order,
  orders,
  placeOf,
  report,
  setTabKind,
  settled,
  useOrders,
  useReport,
} from "../src/viewers/live.js";

beforeEach(() => {
  for (const v of sideViews.value) closeSide(v.id);
  orders.value = new Map();
  lastMove.value = undefined;
});

const pdf = { kind: "file" as const, scope: "project:p1", path: "docs/modulo.pdf" };

/** A viewer that turns pages a little after the move, as the PDF viewer does (two frames). */
function Pages() {
  const tell = useReport();
  useOrders((d) => {
    if (!d.page) return false;
    const page = d.page;
    setTimeout(() => tell({ page, pages: 2 }), 60);
    return true;
  });
  return null;
}

describe("the page answers once it shows what the agent did (p3.5.6)", () => {
  it("a move: the answer says the page it turned to, not the one before", async () => {
    const id = openCanvas("modulo.pdf", pdf);
    setTabKind(id, "pdf");
    report(id, { page: 1, pages: 2 });
    render(
      <CanvasTab.Provider value={id}>
        <Pages />
      </CanvasTab.Provider>,
    );
    order(openCanvas("modulo.pdf", pdf, true), { page: 2 });
    // Asked at once, as the server does right after canvas_act.
    expect(canvasSnapshot().tabs[0]?.place).toEqual({ page: 1, pages: 2 });
    const started = Date.now();
    await settled([id]);
    expect(canvasSnapshot().tabs[0]?.place).toEqual({ page: 2, pages: 2 });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a move no viewer takes costs the wait only, never more", async () => {
    const id = openCanvas("modulo.pdf", pdf);
    setTabKind(id, "pdf");
    order(id, { time: 3 });
    const started = Date.now();
    await settled([id], 300);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1000);
  });

  it("nothing pending: the answer goes at once", async () => {
    const id = openCanvas("modulo.pdf", pdf);
    setTabKind(id, "pdf");
    const started = Date.now();
    await settled([id]);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("a tab just shown waits for its viewer to say its kind", async () => {
    const id = openCanvas("notes.md", { kind: "file", scope: "project:p1", path: "notes.md" });
    setTimeout(() => setTabKind(id, "markdown"), 80);
    await settled([id]);
    sideAside.value = false;
    expect(canvasSnapshot().tabs[0]).toMatchObject({ title: "notes.md", kind: "markdown" });
  });

  it("an open copy in its original's tab forgets the original's pages; a move keeps them", () => {
    const deck = { kind: "file" as const, scope: "project:p1", path: "d/piano.pptx" };
    const id = openCanvas("piano.pptx", deck);
    report(id, { page: 1, pages: 3 });
    // An agent's move in the same tab keeps where the person is.
    openCanvas("piano.pptx", deck, true);
    expect(placeOf(id)).toEqual({ page: 1, pages: 3 });
    // The tab now shows the copy with the agent's fourth slide: the old count goes.
    const copy = { ...deck, path: "d/piano.pptx.open/piano.odp" };
    expect(openCanvas("piano.pptx", copy)).toBe(id);
    expect(canvasViewId(copy)).toBe(id);
    expect(placeOf(id)).toBeUndefined();
    expect(canvasSnapshot().tabs).toEqual([
      expect.objectContaining({ title: "piano.pptx", target: copy }),
    ]);
    expect(canvasSnapshot().tabs[0]?.place).toBeUndefined();
  });
});
