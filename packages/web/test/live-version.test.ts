// @vitest-environment jsdom
// A page whose server comes back as another version reloads by itself (3.5.3): after an update
// the launcher then opens no second page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Live, reconnectCap, versionChanged } from "../src/api.js";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
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
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const socket = (i: number): FakeSocket => {
  const s = FakeSocket.all.at(i);
  if (!s) throw new Error(`no socket ${i}`);
  return s;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.all = [];
});

describe("the page and the server's version", () => {
  it.each([
    [undefined, "3.5.3", false, "no welcome seen yet"],
    ["3.5.2", "3.5.3", true, "another version"],
    ["3.5.3", "3.5.3", false, "the same version (a plain restart)"],
    ["3.5.3", undefined, false, "a server that says no version"],
    [null, null, false, "from the source"],
    [null, "3.5.3", true, "from the source to an installed version"],
  ] as const)("%s then %s: %s (%s)", (seen, now, want, _why) => {
    expect(versionChanged(seen, now)).toBe(want);
  });

  it("waits at most 5 s on this computer, 30 s elsewhere", () => {
    expect(reconnectCap("localhost")).toBe(5000);
    expect(reconnectCap("127.0.0.1")).toBe(5000);
    expect(reconnectCap("redgiant.example.com")).toBe(30000);
  });

  it("says it reloads, and reloads when the server comes back as another version", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const reload = vi.fn();
    const status: string[] = [];
    new Live(
      "tok",
      () => {},
      (s) => status.push(s),
      reload,
    );
    const first = socket(0);
    first.open();
    expect(first.sent[0]).toMatchObject({ type: "hello", token: "tok", reloads: true });
    first.receive({ type: "welcome", protocolVersion: 1, ownerId: "me", version: "3.5.2" });
    // A restart of the same version: back online, no reload.
    first.drop();
    vi.advanceTimersByTime(1000);
    const same = socket(1);
    same.open();
    same.receive({ type: "welcome", protocolVersion: 1, ownerId: "me", version: "3.5.2" });
    expect(reload).not.toHaveBeenCalled();
    expect(status.at(-1)).toBe("online");
    // The update: the server is back as 3.5.3, the page loads again and stops reconnecting.
    same.drop();
    vi.advanceTimersByTime(1000);
    const updated = socket(2);
    updated.open();
    updated.receive({ type: "welcome", protocolVersion: 1, ownerId: "me", version: "3.5.3" });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("tries again every 5 s at most while a server on this computer is away", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    new Live(
      "tok",
      () => {},
      () => {},
      () => {},
    );
    // jsdom's page is on localhost.
    for (let i = 0; i < 6; i++) {
      socket(-1).drop();
      vi.advanceTimersByTime(5000);
    }
    expect(FakeSocket.all).toHaveLength(7);
  });
});
