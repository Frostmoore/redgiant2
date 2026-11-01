// @vitest-environment jsdom
import type { Event } from "@redgiant/protocol";
import { render } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import { MetricsBar } from "../src/components/MetricsBar.js";
import { dictionaries, lang, t } from "../src/i18n.js";
import { renderMarkdown } from "../src/markdown.js";
import {
  activeSide,
  activeTab,
  applyMessage,
  buildItems,
  closeTab,
  explorerOpen,
  openTab,
  sessionView,
  sideViews,
  tabs,
} from "../src/state.js";

const env = (seq: number, type: string, payload: unknown) =>
  ({
    id: `e${seq}`,
    seq,
    ts: "2026-10-31T10:00:00.000Z",
    ownerId: "me",
    projectId: null,
    agentId: "a",
    sessionId: "s",
    payloadHash: "0".repeat(64),
    prevHash: null,
    hash: "0".repeat(64),
    erased: false,
    type,
    payload,
  }) as unknown as Event;

const metrics = {
  startedAt: "2026-10-31T10:00:00.000Z",
  endedAt: "2026-10-31T10:00:02.000Z",
  inputTokens: 1200,
  cachedReadTokens: 1000,
  cacheWriteTokens: 0,
  outputTokens: 300,
  contextUsed: 1500,
  contextWindow: 10_000,
  prefillMs: 700,
  decodeMs: 1300,
  tokPerSec: 230,
  source: "server" as const,
};

describe("buildItems", () => {
  it("turns events into messages, tool calls with their results, and notices", () => {
    const items = buildItems([
      env(1, "session.started", { sessionId: "s", system: "", tools: [] }),
      env(2, "message.user", { text: "hi" }),
      env(3, "message.assistant", {
        parts: [
          { type: "text", text: "ok" },
          { type: "tool_call", callId: "c", name: "bash", input: {}, rawInput: "{}" },
        ],
        stopReason: "tool_use",
        provider: "p",
        model: "m",
        metrics,
        costUsd: 0.01,
      }),
      env(4, "tool.call", { callId: "c", tool: "bash", input: { command: "ls" } }),
      env(5, "permission.requested", {
        requestId: "r",
        callId: "c",
        reason: "manual mode",
        askedTo: "human",
      }),
      env(6, "tool.result", { callId: "c", ok: true, output: "a.txt" }),
      env(7, "task.closed", { taskId: "t1", outcome: "verified" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "notice", "notice"]);
    const tool = items[2];
    expect(tool?.kind === "tool" && tool.result).toEqual({ ok: true, output: "a.txt" });
    const assistant = items[1];
    expect(assistant?.kind === "assistant" && assistant.parts).toEqual([
      { type: "text", text: "ok" },
    ]);
  });

  it("deduplicates replayed events and clears the stream when the message lands", () => {
    applyMessage({ type: "delta", sessionId: "x", kind: "text", text: "Hel" });
    applyMessage({ type: "delta", sessionId: "x", kind: "text", text: "lo" });
    expect(sessionView("x").value.text).toBe("Hello");
    const e = {
      ...env(9, "message.assistant", {
        parts: [{ type: "text", text: "Hello" }],
        stopReason: "end_turn",
        provider: "p",
        model: "m",
        metrics,
        costUsd: 0,
      }),
      sessionId: "x",
    } as Event;
    applyMessage({ type: "event", sessionId: "x", event: e });
    applyMessage({ type: "event", sessionId: "x", event: e });
    expect(sessionView("x").value.events).toHaveLength(1);
    expect(sessionView("x").value.text).toBe("");
  });
});

describe("MetricsBar", () => {
  it("shows tokens, cache, context share, timings and cost, with proportional segments", () => {
    lang.value = "en";
    const { container, getByTestId } = render(<MetricsBar m={metrics} costUsd={0.0123} />);
    const text = getByTestId("metrics").textContent ?? "";
    expect(text).toContain("in 1.2k (cache 1.0k)");
    expect(text).toContain("out 300");
    expect(text).toContain("context 15% / 10k");
    expect(text).toContain("prefill 700ms");
    expect(text).toContain("generation 1.3s · 230 tok/s");
    expect(text).toContain("$0.01");
    const widths = [...container.querySelectorAll<HTMLElement>(".seg")].map((s) => s.style.width);
    expect(widths).toEqual(["10%", "2%", "3%"]);
  });
});

describe("markdown", () => {
  it("never lets model output run scripts", () => {
    const html = renderMarkdown("**hi** <script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(html).toContain("<strong>hi</strong>");
    expect(html).not.toMatch(/script|onerror/);
  });
});

describe("i18n", () => {
  it("has every key in both languages, none empty", () => {
    const keys = Object.keys(dictionaries.en);
    expect(Object.keys(dictionaries.it).sort()).toEqual(keys.sort());
    for (const l of ["en", "it"] as const)
      for (const k of keys) expect(dictionaries[l][k as keyof typeof dictionaries.en]).not.toBe("");
    lang.value = "it";
    expect(t("confirmDelete", { path: "a.txt" })).toBe("Eliminare a.txt?");
  });
});

describe("layout", () => {
  beforeEach(() => {
    tabs.value = [];
    activeTab.value = null;
    sideViews.value = [];
    explorerOpen.value = false;
  });

  it("opens each thing once, in its place: tabs in the middle, files and terminals on the right", () => {
    openTab({ id: "chat:s1", type: "chat", title: "S1", sessionId: "s1", agentId: "god" });
    openTab({ id: "board:p", type: "board", title: "B", projectId: "p" });
    openTab({ id: "chat:s1", type: "chat", title: "S1", sessionId: "s1", agentId: "god" });
    expect(tabs.value.map((x) => x.id)).toEqual(["chat:s1", "board:p"]);
    expect(activeTab.value).toBe("chat:s1");
    // The old views land in the settings, as sections of one tab.
    openTab({ id: "budgets", type: "budgets", title: "B" });
    openTab({ id: "extensions", type: "extensions", title: "E" });
    expect(tabs.value.filter((x) => x.type === "settings")).toEqual([
      { id: "settings", type: "settings", title: "", section: "extensions" },
    ]);
    openTab({
      id: "edit:project:p:a.txt",
      type: "editor",
      title: "a.txt",
      scope: "project:p",
      path: "a.txt",
    });
    expect(sideViews.value.map((v) => v.id)).toEqual(["edit:project:p:a.txt"]);
    expect(activeSide.value).toBe("edit:project:p:a.txt");
    openTab({ id: "files", type: "files", title: "F" });
    expect(explorerOpen.value).toBe(true);
    closeTab("chat:s1");
    expect(tabs.value.map((x) => x.id)).toEqual(["board:p", "settings"]);
  });
});
