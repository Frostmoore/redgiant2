// @vitest-environment jsdom
// p3.5.4 (the person's test of 3.5.3 on Windows): the page stopped hearing the server and kept
// «Legge il contesto» and spinners forever, and «Ferma» did nothing. A heartbeat finds a dead
// connection, opens it again and follows the conversations from the last event seen; a lost
// connection shows a strip; a «Ferma» on a dead connection goes again; memory near its limit says so.
import { act, cleanup, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Live, PING_EVERY, PONG_WITHIN } from "../src/api.js";
import { lang } from "../src/i18n.js";

/** A WebSocket the test drives: it opens when told, and answers only when told. */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  hear(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  welcome() {
    this.hear({ type: "welcome", protocolVersion: 1, ownerId: "me" });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}
const last = () => FakeSocket.all.at(-1) as FakeSocket;
const event = (sessionId: string, seq: number) => ({
  type: "event",
  sessionId,
  event: { seq, type: "message.user", payload: { text: "hi" } },
});

let live: Live | undefined;
const statuses: string[] = [];
const heard: { type: string }[] = [];
const start = () => {
  live = new Live(
    "token",
    (m) => heard.push(m),
    (s) => statuses.push(s),
    () => {},
  );
  last().open();
  last().welcome();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.all = [];
  statuses.length = 0;
  heard.length = 0;
  lang.value = "it";
});
afterEach(() => {
  live?.close();
  live = undefined;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the heartbeat (p3.5.4)", () => {
  it("keeps a connection that answers", () => {
    start();
    vi.advanceTimersByTime(PING_EVERY);
    expect(last().types()).toContain("ping");
    last().hear({ type: "pong" });
    vi.advanceTimersByTime(PONG_WITHIN + PING_EVERY - 1);
    last().hear({ type: "pong" });
    vi.advanceTimersByTime(PONG_WITHIN);
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe("online");
    // The pong is the channel's own business: the page never sees it.
    expect(heard.some((m) => m.type === "pong")).toBe(false);
  });

  it("drops a connection that stopped answering and follows again from the last event", () => {
    start();
    live?.send({ type: "session.follow", sessionId: "s1" });
    live?.send({ type: "session.follow", sessionId: "s2" });
    for (const seq of [1, 2, 3]) last().hear(event("s1", seq));
    const dead = last();
    // The server goes silent: the browser still calls the socket open.
    vi.advanceTimersByTime(PING_EVERY);
    expect(dead.types()).toContain("ping");
    vi.advanceTimersByTime(PONG_WITHIN);
    expect(dead.closed).toBe(true);
    expect(statuses.at(-1)).toBe("offline");
    // Opened again on its own, after the first delay.
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    last().welcome();
    expect(statuses.at(-1)).toBe("online");
    const follows = last().sent.filter((m) => m.type === "session.follow");
    expect(follows).toEqual([
      { type: "session.follow", sessionId: "s1", afterSeq: 3 },
      { type: "session.follow", sessionId: "s2" },
    ]);
    // The old socket's late words change nothing.
    dead.onclose?.({ code: 1006 });
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("keeps trying while the server does not come back", () => {
    start();
    vi.advanceTimersByTime(PING_EVERY + PONG_WITHIN);
    vi.advanceTimersByTime(1000);
    last().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(2000);
    last().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(4000);
    expect(FakeSocket.all).toHaveLength(4);
    expect(statuses.filter((s) => s === "online")).toHaveLength(1);
  });

  it("sends «Ferma» again when the connection it went on was dead", () => {
    start();
    const dead = last();
    live?.send({ type: "session.interrupt", sessionId: "s1" });
    // Sent, and the server asked at once whether it is there.
    expect(dead.types()).toEqual(["hello", "session.interrupt", "ping"]);
    vi.advanceTimersByTime(PONG_WITHIN);
    expect(dead.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    last().open();
    last().welcome();
    expect(last().types()).toContain("session.interrupt");
  });

  it("does not send «Ferma» twice when the server heard it", () => {
    start();
    live?.send({ type: "session.interrupt", sessionId: "s1" });
    last().hear({ type: "pong" });
    vi.advanceTimersByTime(PING_EVERY + PONG_WITHIN);
    last().hear({ type: "pong" });
    expect(FakeSocket.all).toHaveLength(1);
    expect(
      last()
        .types()
        .filter((x) => x === "session.interrupt"),
    ).toHaveLength(1);
  });

  it("checks at once when the page comes back into view", () => {
    start();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(last().types()).toEqual(["hello", "ping"]);
    vi.advanceTimersByTime(PONG_WITHIN);
    expect(statuses.at(-1)).toBe("offline");
  });
});

describe("what the page shows (p3.5.4)", () => {
  it("a lost connection shows a strip with «Ricarica», not after a quick reconnection", async () => {
    const state = await import("../src/state.js");
    const { ConnectionLost, LOST_AFTER } = await import("../src/components/PageHealth.js");
    state.everOnline.value = true;
    state.status.value = "online";
    render(<ConnectionLost />);
    act(() => {
      state.status.value = "connecting";
    });
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER - 100);
    });
    act(() => {
      state.status.value = "online";
    });
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER);
    });
    expect(screen.queryByText("Collegamento a RedGiant perso: riprovo…")).toBe(null);
    act(() => {
      state.status.value = "offline";
    });
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER);
    });
    expect(screen.getByText("Collegamento a RedGiant perso: riprovo…")).toBeTruthy();
    expect(screen.getByText("Ricarica")).toBeTruthy();
    act(() => {
      state.status.value = "online";
    });
    expect(screen.queryByText("Collegamento a RedGiant perso: riprovo…")).toBe(null);
  });

  it("a stale stream goes when a conversation is followed again", async () => {
    const state = await import("../src/state.js");
    state.sessionView("s9").value = {
      events: [],
      text: "half an answ",
      thinking: "half a thought",
      state: "running",
      synced: true,
    };
    state.applyMessage({ type: "session.synced", sessionId: "s9", lastSeq: 4 });
    state.applyMessage({ type: "session.state", sessionId: "s9", state: "idle" });
    const v = state.sessionView("s9").value;
    expect([v.text, v.thinking, v.state, v.call]).toEqual(["", "", "idle", undefined]);
  });

  it("memory near the page's limit: a notice that says what to close", async () => {
    const { MemoryNotice, memoryHigh, MEMORY_HIGH } = await import(
      "../src/components/PageHealth.js"
    );
    expect(MEMORY_HIGH).toBe(0.8);
    for (const [used, limit, high] of [
      [10, 100, false],
      [79, 100, false],
      [80, 100, true],
      [99, 100, true],
      [5, 0, false],
    ] as const)
      expect(memoryHigh({ used, limit })).toBe(high);
    expect(memoryHigh(undefined)).toBe(false);
    const mem = { usedJSHeapSize: 500 * 1048576, jsHeapSizeLimit: 4096 * 1048576 };
    Object.defineProperty(performance, "memory", { value: mem, configurable: true });
    render(<MemoryNotice every={1000} />);
    expect(screen.queryByText(/usa molta memoria/)).toBe(null);
    mem.usedJSHeapSize = 3600 * 1048576;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/usa molta memoria \(3.600 MB di 4.096 MB\)/)).toBeTruthy();
  });
});
