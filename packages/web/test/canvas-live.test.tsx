// @vitest-environment jsdom
// The canvas seen and moved by agents (G36.12): the page says what it shows only when asked
// (`canvasSnapshot`), an agent's move (`canvas.act`) opens or brings the tab forward and waits for
// its viewer, and the viewers apply it once ready (zoom, cells, a time, play or pause).

import type { Event } from "@redgiant/protocol";
import { fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveText } from "../src/components/Canvas.js";
import { ImageView } from "../src/components/viewers/ImageView.js";
import { MediaView } from "../src/components/viewers/MediaView.js";
import { TableView } from "../src/components/viewers/TableView.js";
import { lang } from "../src/i18n.js";
import {
  activeSide,
  applyMessage,
  buildItems,
  canvasSnapshot,
  canvasViewId,
  closeSide,
  openCanvas,
  sessionView,
  sideAside,
  sideViews,
} from "../src/state.js";
import {
  CanvasTab,
  cellRange,
  lastMove,
  order,
  orders,
  placeOf,
  report,
  setTabKind,
} from "../src/viewers/live.js";
import type { ViewerSource } from "../src/viewers/source.js";

beforeEach(() => {
  lang.value = "it";
  for (const v of sideViews.value) closeSide(v.id);
  orders.value = new Map();
  lastMove.value = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pdf = { kind: "file" as const, scope: "project:p1", path: "docs/report.pdf" };
const clip = { kind: "file" as const, scope: "project:p1", path: "out/clip.mp4" };

describe("what the page says when an agent looks (G36.12)", () => {
  it("every tab, the active one, its kind and where the person is", () => {
    openCanvas("report.pdf", pdf);
    openCanvas("clip.mp4", clip);
    sideAside.value = false;
    setTabKind(canvasViewId(pdf), "pdf");
    report(canvasViewId(pdf), { page: 3, pages: 12, zoom: 150 });
    report(canvasViewId(clip), { time: 4.5, duration: 30, playing: true, selection: "" });
    // A value cleared goes away; bad numbers are not kept.
    report(canvasViewId(pdf), { zoom: undefined, line: Number.NaN });
    const s = canvasSnapshot();
    expect(s.visible).toBe(true);
    expect(s.tabs).toEqual([
      {
        title: "report.pdf",
        target: pdf,
        active: false,
        kind: "pdf",
        place: { page: 3, pages: 12 },
      },
      {
        title: "clip.mp4",
        target: clip,
        active: true,
        place: { time: 4.5, duration: 30, playing: true },
      },
    ]);
    // Closed, it is forgotten.
    closeSide(canvasViewId(pdf));
    expect(placeOf(canvasViewId(pdf))).toBeUndefined();
    expect(canvasSnapshot().tabs).toHaveLength(1);
  });

  it("an empty canvas is not in view", () => {
    expect(canvasSnapshot()).toEqual({ visible: false, tabs: [] });
  });
});

describe("an agent's move", () => {
  const act = (seq: number, payload: unknown) =>
    ({ seq, type: "canvas.act", sessionId: "s1", ts: "", payload }) as unknown as Event;

  it("brings the tab forward (opening it if needed) and leaves the move for its viewer", () => {
    sessionView("s1").value = {
      events: [],
      text: "",
      thinking: "",
      state: "running",
      synced: true,
    };
    openCanvas("report.pdf", { ...pdf, at: { page: 2 } });
    openCanvas("clip.mp4", clip);
    applyMessage({
      type: "event",
      sessionId: "s1",
      event: act(7, { title: "Report", target: pdf, do: { page: 5, zoom: "fit" } }),
    });
    const id = canvasViewId(pdf);
    expect(activeSide.value).toBe(id);
    // The tab stays as it was (its citation's page too): only the move is new.
    expect(sideViews.value.find((v) => v.id === id)).toMatchObject({
      title: "report.pdf",
      target: { at: { page: 2 } },
    });
    expect(orders.value.get(id)?.do).toEqual({ page: 5, zoom: "fit" });
    expect(lastMove.value).toMatchObject({ id, do: { page: 5, zoom: "fit" } });
    // A file not open yet opens.
    applyMessage({
      type: "event",
      sessionId: "s1",
      event: act(8, {
        title: "notes.md",
        target: { kind: "file", scope: "project:p1", path: "notes.md" },
        do: { line: 4 },
      }),
    });
    expect(sideViews.value.map((v) => v.title)).toEqual(["report.pdf", "clip.mp4", "notes.md"]);
    // Replayed from the log (not live), nothing moves; the chat shows no card for it.
    sessionView("s2").value = { events: [], text: "", thinking: "", state: "idle", synced: false };
    applyMessage({
      type: "event",
      sessionId: "s2",
      event: act(1, { title: "x", target: clip, do: { time: 3 } }),
    });
    expect(orders.value.has(canvasViewId(clip))).toBe(false);
    expect(buildItems([act(1, { title: "x", target: clip, do: { time: 3 } })])).toEqual([]);
  });

  it("says in words what the agent did", () => {
    expect(moveText({ page: 3 })).toBe("L'agente: pagina 3");
    expect(moveText({ line: 10, toLine: 14 })).toBe("L'agente: righe 10-14");
    expect(moveText({ time: 75, play: true })).toBe("L'agente: a 1:15, in riproduzione");
    expect(moveText({ zoom: 150, find: "motore" })).toBe("L'agente: zoom 150%, cerca «motore»");
    expect(moveText({ sheet: "Costi", cells: "b2:d4" })).toBe(
      "L'agente: foglio Costi, celle B2:D4",
    );
    expect(moveText({})).toBe("Aperto dall'agente");
    lang.value = "en";
    expect(moveText({ page: 3, zoom: "fit" })).toBe("The agent: page 3, fitted");
  });

  it("the chat shows what canvas_look drew for the agent, under its line", () => {
    const pic = { type: "image", mediaType: "image/png", data: "iVBOR", name: "a.png.png" };
    const ev = (seq: number, type: string, payload: unknown) =>
      ({ seq, type, sessionId: "s", ts: "", payload }) as unknown as Event;
    const items = buildItems([
      ev(1, "tool.call", { callId: "c1", tool: "canvas_look", input: {} }),
      ev(2, "tool.result", {
        callId: "c1",
        ok: true,
        output: "The person's canvas…",
        images: [pic],
      }),
      ev(3, "tool.call", { callId: "c2", tool: "browser_screenshot", input: {} }),
      ev(4, "tool.result", { callId: "c2", ok: true, output: "ok", images: [pic] }),
    ]);
    expect(items[0]).toMatchObject({ tool: "canvas_look", result: { images: [pic] } });
    expect(items[1]).toMatchObject({ result: { ok: true, output: "ok" } });
    expect((items[1] as { result: { images?: unknown } }).result.images).toBeUndefined();
  });

  it("names cells as in the sheet", () => {
    expect(cellRange("B2:D9")).toEqual({ c0: 1, r0: 1, c1: 3, r1: 8 });
    expect(cellRange("c3")).toEqual({ c0: 2, r0: 2, c1: 2, r1: 2 });
    expect(cellRange("A1:")).toBeUndefined();
  });
});

const src = (o: Partial<ViewerSource>): ViewerSource =>
  ({ name: "f", url: "blob:x", kind: "image", format: "png", ...o }) as ViewerSource;

describe("the viewers apply moves and say where the person is", () => {
  it("a picture zooms", async () => {
    const id = "canvas:t:pic.png";
    order(id, { zoom: 200 });
    const view = render(
      <CanvasTab.Provider value={id}>
        <ImageView src={src({ name: "pic.png" })} />
      </CanvasTab.Provider>,
    );
    await waitFor(() => expect(view.getByText("200%")).toBeTruthy());
    expect(orders.value.has(id)).toBe(false);
    expect(placeOf(id)).toEqual({ zoom: 200 });
    order(id, { zoom: "fit" });
    await waitFor(() => expect(placeOf(id)).toEqual({}));
    // A move it cannot use stays for another viewer.
    order(id, { page: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(orders.value.get(id)?.do).toEqual({ page: 2 });
  });

  it("a table marks the cells and brings them into view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("name,city\nRossi,Roma\nBianchi,Milano\nVerdi,Napoli\n")),
    );
    const id = "canvas:t:people.csv";
    order(id, { cells: "B2:B3" });
    const view = render(
      <CanvasTab.Provider value={id}>
        <TableView src={src({ name: "people.csv", kind: "table", format: "csv" })} />
      </CanvasTab.Provider>,
    );
    await waitFor(() =>
      expect([...view.container.querySelectorAll(".vw-mark")].map((e) => e.textContent)).toEqual([
        "Roma",
        "Milano",
      ]),
    );
    expect(placeOf(id)).toEqual({ cells: "B2:B3" });
  });

  it("a video goes to the time and pauses or plays once it is ready", async () => {
    const id = "canvas:t:clip.mp4";
    const play = vi.fn(async () => {});
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
    // jsdom plays nothing: the browser here says it might.
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    order(id, { time: 12, play: true });
    const view = render(
      <CanvasTab.Provider value={id}>
        <MediaView src={src({ name: "clip.mp4", kind: "video", format: "mp4" })} />
      </CanvasTab.Provider>,
    );
    const video = view.container.querySelector("video") as HTMLVideoElement;
    // Not before its metadata.
    expect(play).not.toHaveBeenCalled();
    fireEvent(video, new window.Event("loadedmetadata"));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(video.currentTime).toBe(12);
    expect(placeOf(id)).toMatchObject({ time: 12 });
    order(id, { play: false });
    await waitFor(() => expect(pause).toHaveBeenCalled());
  });
});
