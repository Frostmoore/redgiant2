// @vitest-environment jsdom
// Sub-agents' tabs (p3.3.1, as Officina shows them): a row of tabs over the conversation, one
// per sub-agent, another row for a sub-agent's own sub-agents; the task on top of its tab and
// a bar instead of the composer; finished tabs close for good (the log says so).
import type { Event } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: unknown[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: unknown) => sent.push(m) }),
  getApi: () => new Proxy({}, { get: () => () => new Promise(() => {}) }) as never,
}));

const state = await import("../src/state.js");
const { Chat } = await import("../src/components/Chat.js");
const { subagentTabs, subStatus, sessionView, agents, subPath, approvals } = state;

let seq = 0;
const ev = (sessionId: string, type: string, payload: unknown, agentId = "god"): Event =>
  ({
    id: `e${++seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 10, 7, 10, 0, seq)).toISOString(),
    ownerId: "me",
    projectId: null,
    agentId,
    sessionId,
    type,
    payload,
    hash: "",
    prevHash: "",
  }) as unknown as Event;
const started = (at: string, child: string, title: string, agent = "sub", via = "run_subagent") =>
  ev(at, "subagent.started", {
    childSessionId: child,
    childAgentId: agent,
    callId: `c_${child}`,
    via,
    title,
    task: `Do ${title}`,
  });
const ended = (at: string, child: string, status: string) =>
  ev(at, "subagent.ended", { childSessionId: child, status, summary: "ok" });
const said = (at: string, text: string, agentId: string) =>
  ev(
    at,
    "message.assistant",
    {
      parts: [{ type: "text", text }],
      metrics: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedReadTokens: 0,
        contextUsed: 1200,
        contextWindow: 100000,
        startedAt: "",
        source: "server",
      },
      costUsd: 0,
      model: "m",
      stopReason: "end_turn",
    },
    agentId,
  );

const set = (id: string, events: Event[], state: "idle" | "running" = "idle") => {
  sessionView(id).value = { events, text: "", thinking: "", state, synced: true };
};

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  subPath.value = {};
  approvals.value = [];
  agents.value = [
    { id: "god", name: "God", kind: "god" },
    { id: "sub", name: "Coder", kind: "agent" },
    { id: "sub2", name: "Helper", kind: "subagent" },
  ] as never;
});
afterEach(() => cleanup());

describe("sub-agents' tabs from the log", () => {
  it("knows each tab's task, end and closing; a new task reopens it", () => {
    const events = [
      started("root", "c1", "Search"),
      started("root", "c2", "Tests", "sub2", "delegate"),
      ended("root", "c1", "done"),
      ev("root", "subagent.closed", { childSessionId: "c1" }),
    ];
    const tabs = subagentTabs(events);
    expect(tabs.map((x) => [x.title, x.ended, x.closed])).toEqual([
      ["Search", "done", true],
      ["Tests", undefined, false],
    ]);
    // A brand-new conversation is all its own; a reused one from its task on.
    expect(tabs[0]?.fromSeq).toBe(0);
    expect(tabs[1]?.fromSeq).toBe(events[1]?.seq);
    const again = subagentTabs([...events, started("root", "c1", "Search again")]);
    const reopened = again.find((x) => x.childSessionId === "c1");
    expect([reopened?.title, reopened?.closed, reopened?.ended]).toEqual([
      "Search again",
      false,
      undefined,
    ]);
    // No end recorded: working while someone works, otherwise it died (a restart).
    const open = tabs[1] as never;
    expect(subStatus(open, true, false)).toBe("running");
    expect(subStatus(open, false, true)).toBe("running");
    expect(subStatus(open, false, false)).toBe("stopped");
  });
});

describe("the tabs over a conversation", () => {
  it("shows no tab bar without sub-agents", () => {
    set("plain", [said("plain", "Ciao", "god")]);
    const r = render(<Chat sessionId="plain" agentId="god" />);
    expect(r.container.querySelector(".sub-rows")).toBeNull();
  });

  it("opens a sub-agent's tab: its task, its conversation, its bar with Stop; no composer", () => {
    set("root", [started("root", "c1", "Search"), started("root", "c2", "Write")], "running");
    set("c1", [said("c1", "Found three files", "sub")], "running");
    set("c2", [said("c2", "Wrote it", "sub")]);
    sessionView("root").value = {
      ...sessionView("root").value,
      events: [...sessionView("root").value.events, ended("root", "c2", "done")],
    };
    const r = render(<Chat sessionId="root" agentId="god" />);
    const tabs = [...r.container.querySelectorAll(".sub-row .sub-tab")];
    expect(tabs.map((x) => x.textContent)).toEqual(["Agente principale", "Search", "Write"]);
    expect(r.container.querySelector(".sub-dot.running")).toBeTruthy();
    expect(r.container.querySelector(".sub-dot.done")).toBeTruthy();
    // Only the finished one has an "x".
    expect(r.container.querySelectorAll(".sub-tab-x")).toHaveLength(1);
    // The main conversation, with its composer, until a tab is chosen.
    expect(r.container.querySelector("textarea")).toBeTruthy();
    fireEvent.click(r.getByText("Search"));
    expect(r.container.querySelector(".sub-task")?.textContent).toContain("Compito da «God»");
    expect(r.container.querySelector(".sub-task")?.textContent).toContain("Do Search");
    expect(r.container.textContent).toContain("Found three files");
    expect(r.container.querySelector("textarea")).toBeNull();
    const bar = r.container.querySelector(".sub-bar") as HTMLElement;
    expect(bar.textContent).toContain("Lavora");
    expect(bar.textContent).toContain("1.2k token");
    fireEvent.click(r.getByText("Ferma"));
    expect(sent).toContainEqual({ type: "session.interrupt", sessionId: "c1" });
    expect(sent).toContainEqual({ type: "session.follow", sessionId: "c1" });
    // The path in words.
    expect(r.container.querySelector(".sub-crumbs")?.textContent).toBe("GodSearch");
  });

  it("closes a finished tab through the log, and a closed tab stays closed", () => {
    set("root", [started("root", "c1", "Search"), ended("root", "c1", "failed")]);
    set("c1", []);
    const r = render(<Chat sessionId="root" agentId="god" />);
    expect(r.container.querySelector(".sub-dot.failed")).toBeTruthy();
    fireEvent.click(r.container.querySelector(".sub-tab-x") as HTMLElement);
    expect(sent).toContainEqual({
      type: "subagent.close",
      sessionId: "root",
      childSessionId: "c1",
    });
    // The server's event arrives (on every device): no tab bar is left.
    set("root", [
      ...sessionView("root").value.events,
      ev("root", "subagent.closed", { childSessionId: "c1" }),
    ]);
    r.rerender(<Chat sessionId="root" agentId="god" />);
    expect(r.container.querySelector(".sub-rows")).toBeNull();
  });

  it("opens a second row for a sub-agent's own sub-agents, with the whole path", () => {
    set("root", [started("root", "c1", "Build", "sub", "delegate")], "running");
    set("c1", [started("c1", "g1", "Unit tests", "sub2")], "running");
    set("g1", [said("g1", "All green", "sub2")], "running");
    const r = render(<Chat sessionId="root" agentId="god" />);
    expect(r.container.querySelectorAll(".sub-row")).toHaveLength(1);
    fireEvent.click(r.getByText("Build"));
    const rows = r.container.querySelectorAll(".sub-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain("Coder");
    expect(rows[1]?.textContent).toContain("Unit tests");
    fireEvent.click(r.getByText("Unit tests"));
    expect(r.container.textContent).toContain("All green");
    expect(r.container.querySelector(".sub-task")?.textContent).toContain("Compito da «Coder»");
    expect(r.container.querySelector(".sub-crumbs")?.textContent).toBe("GodBuildUnit tests");
    // Back to the first level from the path.
    fireEvent.click(r.getByText("God"));
    expect(r.container.querySelectorAll(".sub-row")).toHaveLength(1);
  });

  it("marks a tab waiting for the person's yes, and says so over the conversation", () => {
    set("root", [started("root", "c1", "Deploy")], "running");
    set("c1", [], "running");
    approvals.value = [
      {
        requestId: "r1",
        agentId: "sub",
        agentName: "Coder",
        sessionId: "c1",
        tool: "bash",
        input: {},
        projectId: null,
        reasons: ["it runs a command"],
        danger: [],
        createdAt: "2026-11-07T10:00:00.000Z",
      },
    ] as never;
    const r = render(<Chat sessionId="root" agentId="god" />);
    expect(r.container.querySelector(".sub-waits")).toBeTruthy();
    expect(r.container.textContent).toContain("Il sotto-agente «Deploy» chiede il tuo permesso.");
    fireEvent.click(r.getByText("Apri la scheda"));
    expect(subPath.value.root).toEqual(["c1"]);
  });
});
