// @vitest-environment jsdom
// The background commands' strip (p3.3.1): running ones in view with Stop, the finished ones in
// one line that opens, «Remove all finished», the whole strip reduced to one line (remembered),
// closed ones gone; the output window with every line's time on request.
import type { Event } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: unknown[] = [];
const asked: unknown[][] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: unknown) => sent.push(m) }),
  getApi: () => ({
    commandOutput: async (...args: unknown[]) => {
      asked.push(args);
      return {
        log: { started: "2026-11-07 15:03:12.000 +01:00", folder: "/w", by: "Coder", dropped: 0 },
        lines: [
          { n: 1, clock: "15:03:13.000", at: 1, stream: "out", text: "ready on :5173" },
          { n: 2, clock: "15:03:14.500", at: 2.5, stream: "err", text: "warning: x" },
        ],
        running: true,
      };
    },
  }),
}));

const state = await import("../src/state.js");
const { CommandStrip } = await import("../src/components/CommandStrip.js");
const { commandRows, sessionView, commandStripMin } = state;

let seq = 0;
const ev = (type: string, payload: unknown): Event =>
  ({
    id: `e${++seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 10, 7, 14, 3, seq)).toISOString(),
    ownerId: "me",
    projectId: null,
    agentId: "a",
    sessionId: "s",
    type,
    payload,
  }) as unknown as Event;
const started = (id: string, command: string) =>
  ev("command.started", {
    id,
    command,
    file: `/w/${id}.log`,
    path: `.redgiant/commands/${id}.log`,
    cwd: "/w",
    by: "Coder",
  });
const ended = (id: string, status: string, exitCode: number | null) =>
  ev("command.ended", { id, status, exitCode });

const set = (events: Event[]) => {
  sessionView("s").value = { events, text: "", thinking: "", state: "idle", synced: true };
};

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  asked.length = 0;
  localStorage.removeItem("rg.cmdStrip");
  commandStripMin.value = false;
});
afterEach(() => cleanup());

describe("background commands' strip", () => {
  it("rebuilds the commands from the log", () => {
    const rows = commandRows([
      started("c1", "npm run dev"),
      started("c2", "npm test"),
      ended("c2", "failed", 1),
      ev("command.closed", { id: "c2" }),
    ]);
    expect(rows.map((r) => [r.id, r.status, r.exitCode, r.closed])).toEqual([
      ["c1", "running", null, false],
      ["c2", "failed", 1, true],
    ]);
  });

  it("shows running ones with Stop, finished ones in one line, and removes them", () => {
    set([
      started("c1", "npm run dev"),
      started("c2", "npm test"),
      ended("c2", "done", 0),
      started("c3", "make build"),
      ended("c3", "failed", 2),
      started("c4", "old"),
      ended("c4", "done", 0),
      ev("command.closed", { id: "c4" }),
    ]);
    const r = render(<CommandStrip sessionId="s" />);
    expect(r.container.querySelector(".cmd-head")?.textContent).toContain("1 in corso · 2 finiti");
    const rows = r.container.querySelectorAll(".cmd-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("npm run dev");
    // Start time and running time.
    expect(rows[0]?.querySelector(".cmd-time")?.textContent).toMatch(/\d\d:\d\d:\d\d · /);
    fireEvent.click(r.getByText("Ferma"));
    expect(sent).toContainEqual({ type: "command.stop", sessionId: "s", id: "c1" });
    expect(r.container.textContent).not.toContain("old");
    fireEvent.click(r.getByText("2 comandi finiti"));
    expect(r.container.querySelectorAll(".cmd-row.done")).toHaveLength(2);
    expect(r.container.textContent).toContain("fallito, codice d'uscita 2");
    fireEvent.click(r.getByText("Togli tutti i finiti"));
    expect(sent).toContainEqual({ type: "command.close", sessionId: "s", id: "c2" });
    expect(sent).toContainEqual({ type: "command.close", sessionId: "s", id: "c3" });
  });

  it("reduces to one line and remembers it", () => {
    set([started("c1", "npm run dev"), started("c2", "tsc --watch")]);
    const r = render(<CommandStrip sessionId="s" />);
    fireEvent.click(r.container.querySelector(".cmd-head") as HTMLElement);
    expect(r.container.querySelectorAll(".cmd-row")).toHaveLength(0);
    expect(r.container.querySelector(".cmd-head")?.textContent).toContain("2 in corso");
    expect(localStorage.getItem("rg.cmdStrip")).toBe("min");
    cleanup();
    const again = render(<CommandStrip sessionId="s" />);
    expect(again.container.querySelectorAll(".cmd-row")).toHaveLength(0);
    fireEvent.click(again.container.querySelector(".cmd-head") as HTMLElement);
    expect(again.container.querySelectorAll(".cmd-row")).toHaveLength(2);
    expect(localStorage.getItem("rg.cmdStrip")).toBe("open");
  });

  it("opens the output with who, where and when, and every line's time on request", async () => {
    set([started("c1", "npm run dev")]);
    const r = render(<CommandStrip sessionId="s" />);
    fireEvent.click(r.getByText("Output"));
    await waitFor(() => expect(document.body.textContent).toContain("ready on :5173"));
    expect(asked[0]).toEqual(["s", "c1", undefined]);
    const modal = document.querySelector(".cmd-output") as HTMLElement;
    expect(modal.textContent).toContain("Lanciato daCoder");
    expect(modal.textContent).toContain("2026-11-07 15:03:12.000");
    expect(modal.querySelector(".cmd-line.err")?.textContent).toBe("warning: x");
    expect(modal.querySelector(".cmd-line-time")).toBeNull();
    fireEvent.click(r.getByText("Orario di ogni riga"));
    expect(document.querySelector(".cmd-line-time")?.textContent).toContain("15:03:13.000 +1.0s");
  });

  it("is not there without commands", () => {
    set([]);
    const r = render(<CommandStrip sessionId="s" />);
    expect(r.container.querySelector(".cmd-strip")).toBeNull();
  });
});
