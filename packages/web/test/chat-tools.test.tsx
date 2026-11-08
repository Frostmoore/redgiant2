// @vitest-environment jsdom
// The chat's tools of G36: replying to a passage (G36.22), «Continua da qui» (G36.23) and
// «Intanto», the side question that never enters the conversation (G36.24).
import type { Event } from "@redgiant/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: Record<string, unknown>[] = [];
const calls: [string, unknown[]][] = [];
const answers: Record<string, unknown> = {};
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: Record<string, unknown>) => sent.push(m) }),
  getApi: () =>
    new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push([name, args]);
            return Promise.resolve(answers[name] ?? []);
          },
      },
    ) as never,
}));

const state = await import("../src/state.js");
const { Chat } = await import("../src/components/Chat.js");
const { findPassage, addQuote } = await import("../src/components/ChatTools.js");
const { buildItems, asidesOf, sessionView, agents, sessionRows, approvals, subPath } = state;

let seq = 0;
const ev = (type: string, payload: unknown, sessionId = "s1"): Event =>
  ({
    id: `e${++seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 10, 8, 10, 0, seq)).toISOString(),
    ownerId: "me",
    projectId: null,
    agentId: "god",
    sessionId,
    type,
    payload,
    hash: "",
    prevHash: "",
  }) as unknown as Event;
const metrics = {
  inputTokens: 1000,
  outputTokens: 200,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  contextUsed: 1200,
  contextWindow: 100000,
  startedAt: "2026-11-08T10:00:00.000Z",
  source: "server",
};
const user = (text: string, extra: Record<string, unknown> = {}) =>
  ev("message.user", { text, ...extra });
const said = (text: string) =>
  ev("message.assistant", {
    parts: [{ type: "text", text }],
    metrics,
    costUsd: 0,
    provider: "fake",
    model: "m",
    stopReason: "end_turn",
  });

const set = (id: string, events: Event[], s: "idle" | "running" = "idle") => {
  sessionView(id).value = { events, text: "", thinking: "", state: s, synced: true };
};

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  calls.length = 0;
  subPath.value = {};
  approvals.value = [];
  sessionRows.value = [];
  agents.value = [{ id: "god", name: "God", kind: "god" }] as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("from the log", () => {
  it("shows quotes, where a branch starts, and the side questions apart", () => {
    const a = said("Plan: A then B.");
    const events = [
      user("plan?"),
      a,
      user("", { quotes: [{ seq: a.seq, text: "A", reply: "skip it" }] }),
      ev("session.forked", {
        fromSessionId: "s0",
        throughSeq: 1,
        fromTitle: "Old",
        how: "continue",
      }),
      ev("aside", {
        id: "x1",
        question: "q?",
        answer: "a.",
        provider: "fake",
        model: "m",
        costUsd: 0.01,
      }),
      ev("aside", {
        id: "x2",
        question: "q2?",
        answer: "",
        provider: "fake",
        model: "m",
        costUsd: 0,
        error: "budget",
      }),
      ev("aside.promoted", { asideId: "x1" }),
    ];
    const items = buildItems(events);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "fork"]);
    expect(items[1]).toMatchObject({ seq: a.seq, ts: a.ts });
    expect(items[2]).toMatchObject({ quotes: [{ seq: a.seq, text: "A", reply: "skip it" }] });
    expect(items[3]).toMatchObject({ fromSessionId: "s0", fromTitle: "Old", how: "continue" });
    expect(asidesOf(events).map((x) => [x.id, x.promoted, x.error ?? null])).toEqual([
      ["x1", true, null],
      ["x2", false, "budget"],
    ]);
  });

  it("finds a passage by its place, else by its words", () => {
    const all = "One. Two. Three.";
    expect(findPassage(all, { text: "Two.", start: 5, end: 9 })).toEqual({ from: 5, to: 9 });
    // The message changed around it: found by its words.
    expect(findPassage(`Zero. ${all}`, { text: "Two.", start: 5, end: 9 })).toEqual({
      from: 11,
      to: 15,
    });
    // The selection read two paragraphs with a line break the text nodes do not have.
    expect(findPassage("FirstSecond", { text: "First\n\nSecond" })).toEqual({ from: 0, to: 5 });
    expect(findPassage(all, { text: "Four" })).toBe(null);
    let drafts = addQuote([], { seq: 2, text: "Two." });
    drafts = addQuote(drafts, { seq: 2, text: " Two. " });
    expect(drafts).toHaveLength(1);
  });
});

describe("in the page", () => {
  it("«Rispondi a questo» from a selection: the quote goes with its reply", async () => {
    const a = said("Plan: first A, then B.");
    set("s1", [user("plan?"), a]);
    const { container } = render(<Chat sessionId="s1" agentId="god" />);
    const bubble = container.querySelector(`.bubble.assistant[data-seq="${a.seq}"]`);
    expect(bubble).toBeTruthy();
    const text = bubble?.querySelector(".md p")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 13);
    Range.prototype.getBoundingClientRect = () => new DOMRect(40, 40, 60, 16);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new globalThis.Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 250));
    });
    fireEvent.click(screen.getByText("Rispondi a questo"));
    expect(container.querySelector(".quote-draft .quote-text")?.textContent).toBe("first A");
    fireEvent.input(screen.getByPlaceholderText("La tua risposta a questo passaggio"), {
      target: { value: "only A" },
    });
    // No text of its own needed: the reply under the quote is the message.
    const send = container.querySelector(".box-bar .send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(send);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent.at(-1)).toMatchObject({
      type: "session.send",
      sessionId: "s1",
      text: "",
      quotes: [{ seq: a.seq, at: a.ts, start: 6, end: 13, text: "first A", reply: "only A" }],
    });
    expect(container.querySelector(".quote-draft")).toBe(null);
  });

  it("a sent quote goes back to the passage", () => {
    const a = said("Plan: first A, then B.");
    set("s1", [
      user("plan?"),
      a,
      user("and B?", { quotes: [{ seq: a.seq, text: "first A", reply: "fine" }] }),
    ]);
    const { container } = render(<Chat sessionId="s1" agentId="god" />);
    const ref = container.querySelector(".bubble.user .quote-ref") as HTMLButtonElement;
    expect(ref.textContent).toBe("first A");
    expect(container.querySelector(".bubble.user .quote-reply")?.textContent).toBe("fine");
    fireEvent.click(ref);
    const bubble = container.querySelector(`.bubble.assistant[data-seq="${a.seq}"]`) as HTMLElement;
    expect(bubble.scrollIntoView).toHaveBeenCalled();
    expect(bubble.classList.contains("quote-flash")).toBe(true);
  });

  it("«Continua da qui» opens a new conversation from that message", async () => {
    const a = said("Here is the answer.");
    set("s1", [user("question"), a]);
    answers.forkSession = { sessionId: "s2" };
    render(<Chat sessionId="s1" agentId="god" />);
    const buttons = screen.getAllByText("Continua da qui");
    await act(async () => {
      fireEvent.click(buttons.at(-1) as HTMLElement);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.find(([n]) => n === "forkSession")?.[1]).toEqual(["s1", { fromSeq: a.seq }]);
    expect(state.tabs.value.some((tab) => tab.id === "chat:s2")).toBe(true);
  });

  it("a branch says where it starts and goes back to the original", () => {
    sessionRows.value = [
      {
        id: "s0",
        agentId: "god",
        title: "Original",
        projectId: null,
        createdAt: "",
        lastAt: null,
        pinned: false,
        archived: false,
        running: false,
      },
    ];
    set("s3", [
      user("first"),
      said("ok"),
      ev("session.forked", { fromSessionId: "s0", throughSeq: 2, how: "continue" }, "s3"),
    ]);
    render(<Chat sessionId="s3" agentId="god" />);
    expect(screen.getByText("Da qui continua la conversazione nuova.")).toBeTruthy();
    fireEvent.click(screen.getByText("Torna a «Original»"));
    expect(state.activeTab.value).toBe("chat:s0");
  });

  it("«Intanto»: asked in its own panel, also while the agent works; brought into the chat later", async () => {
    const events = [
      user("work"),
      said("Working on it."),
      ev("aside", {
        id: "x1",
        question: "which port?",
        answer: "**7703**",
        provider: "fake",
        model: "m",
        costUsd: 0.002,
      }),
    ];
    set("s1", events, "running");
    answers.aside = { aside: { id: "x2", answer: "yes" } };
    const { container } = render(<Chat sessionId="s1" agentId="god" />);
    fireEvent.click(screen.getByText("Intanto"));
    const panel = container.querySelector(".aside-panel") as HTMLElement;
    expect(panel.textContent).toContain("which port?");
    expect(panel.querySelector(".md strong")?.textContent).toBe("7703");
    // Not into the chat while the agent works.
    const bring = screen.getByText("Porta nella chat") as HTMLButtonElement;
    expect(bring.disabled).toBe(true);
    const box = screen.getByPlaceholderText(
      "Una domanda al volo, mentre l'agente lavora…",
    ) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "is it slow?" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.find(([n]) => n === "aside")?.[1]).toEqual(["s1", "is it slow?"]);
    // Nothing went to the conversation.
    expect(sent.filter((m) => m.type === "session.send")).toEqual([]);
    set("s1", events, "idle");
    await act(async () => {
      fireEvent.click(screen.getByText("Porta nella chat"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.find(([n]) => n === "promoteAside")?.[1]).toEqual(["s1", "x1"]);
  });
});
