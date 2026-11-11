// @vitest-environment jsdom
// Artifacts and widgets in the page (3.5.9): an answer's ```widget blocks become widgets (pure),
// a frame's «send to chat» goes at once only right after a click in it, the canvas opens an
// artifact as App and Source.
import type { Event } from "@redgiant/protocol";
import { answerSegments } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n.js";

const sent: { type: string; [k: string]: unknown }[] = [];
const calls: [string, unknown[]][] = [];

vi.mock("../src/api.js", async (orig) => {
  const real = await orig<typeof import("../src/api.js")>();
  class Api {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in for the whole API
      return new Proxy(
        {},
        {
          get:
            (_t, name) =>
            async (...args: unknown[]) => {
              calls.push([String(name), args]);
              if (name === "canvasLink") return { url: "/preview/T/conti.html", artifact: true };
              if (name === "widgetLink") return { url: "/preview/W/widget.html" };
              if (name === "canvasVersion") return { version: 1 };
              return [];
            },
        },
      );
    }
  }
  class Live {
    send(m: { type: string }) {
      sent.push(m);
    }
    close() {}
  }
  return { ...real, Api, Live };
});

const state = await import("../src/state.js");
const { buildItems, splitWidgets, streamingWithoutWidgets } = state;
const { ClickGuard, frameMessage } = await import("../src/artifact-frame.js");

beforeAll(async () => {
  await state.signIn("token").catch(() => {});
});
beforeEach(() => {
  setLang("it");
  sent.length = 0;
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const answer = (seq: number, text: string) =>
  ({
    seq,
    sessionId: "s1",
    ts: "2026-11-11T10:00:00.000Z",
    type: "message.assistant",
    payload: {
      parts: [{ type: "text", text }],
      stopReason: "end_turn",
      provider: "fake",
      model: "m",
      metrics: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ttftMs: 0,
        totalMs: 0,
      },
      costUsd: 0,
    },
  }) as unknown as Event;

describe("widgets in answers (3.5.9)", () => {
  it("turns a closed ```widget block into a widget after the answer, the text kept around it", () => {
    const items = buildItems([
      answer(
        7,
        "Ecco:\n\n```widget Umidità interna\n<input id=t>\n<p>ok</p>\n```\n\nProva i valori.",
      ),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "widget"]);
    const a = items[0] as Extract<(typeof items)[number], { kind: "assistant" }>;
    expect(a.parts).toEqual([{ type: "text", text: "Ecco:\n\nProva i valori." }]);
    expect(items[1]).toEqual({
      kind: "widget",
      key: "e7w0",
      sessionId: "s1",
      seq: 7,
      index: 0,
      title: "Umidità interna",
    });
  });

  it("numbers several blocks across the answer's parts; an unclosed or huge one stays text", () => {
    const { parts, widgets } = splitWidgets([
      { type: "text", text: "```widget A\n<b>1</b>\n```" },
      { type: "text", text: "x\n~~~widget\n<i>2</i>\n~~~\n```widget C\n<p>never closed" },
    ]);
    expect(widgets).toEqual([
      { index: 0, title: "A" },
      { index: 1, title: "" },
    ]);
    expect(parts[1]).toEqual({ type: "text", text: "x\n\n```html\n<p>never closed" });
    const big = `\`\`\`widget\n${"a".repeat(64 * 1024 + 1)}\n\`\`\``;
    expect(splitWidgets([{ type: "text", text: big }]).widgets).toEqual([]);
    // Code blocks of other kinds are not widgets.
    expect(answerSegments("```html\n<p>x</p>\n```")).toEqual([
      { kind: "text", text: "```html\n<p>x</p>\n```" },
    ]);
  });

  it("while the answer streams, a widget shows as a line, never as its code", () => {
    const open = streamingWithoutWidgets("Ecco:\n```widget Umidità\n<script>let a=1");
    expect(open).not.toContain("<script>");
    expect(open).toContain("Sto preparando un widget");
    expect(streamingWithoutWidgets("niente")).toBe("niente");
  });

  it("keeps a message sent through a widget marked as such", () => {
    const items = buildItems([
      {
        seq: 9,
        sessionId: "s1",
        ts: "2026-11-11T10:00:00.000Z",
        type: "message.user",
        payload: { text: "Analizza: 21 °C, 60%", via: "artifact" },
      } as unknown as Event,
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "Analizza: 21 °C, 60%", via: "artifact" });
  });
});

describe("the click rule of «send to chat» (3.5.9)", () => {
  it("lets one message go within 1.5 s of a click in the frame, one per click", () => {
    vi.useFakeTimers();
    const g = new ClickGuard();
    expect(g.take(false, false)).toBe(false);
    g.clicked();
    vi.advanceTimersByTime(1400);
    expect(g.take(true, false)).toBe(true);
    // A second message for the same click: refused.
    expect(g.take(true, false)).toBe(false);
    g.clicked();
    vi.advanceTimersByTime(1600);
    expect(g.take(true, false)).toBe(false);
  });

  it("with focus already in the frame, the browser's own activation counts once in 5 s", () => {
    vi.useFakeTimers();
    const g = new ClickGuard();
    expect(g.take(true, true)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(g.take(true, true)).toBe(false);
    vi.advanceTimersByTime(3500);
    expect(g.take(true, true)).toBe(true);
    // Not activated, or the frame not focused: no.
    vi.advanceTimersByTime(6000);
    expect(g.take(false, true)).toBe(false);
    expect(g.take(true, false)).toBe(false);
  });

  it("listens only to its own frame, and only to messages of the right shape", () => {
    const win = {};
    const frame = { contentWindow: win };
    const ok = {
      jsonrpc: "2.0",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "ciao" }] },
    };
    expect(frameMessage({ source: win, data: ok }, frame)?.method).toBe("ui/message");
    expect(frameMessage({ source: {}, data: ok }, frame)).toBeUndefined();
    expect(frameMessage({ source: win, data: { method: "ui/open-link" } }, frame)).toBeUndefined();
  });

  it("sends at once after a click, otherwise asks under the widget with Manda / Lascia stare", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { WidgetCard } = await import("../src/components/ArtifactFrame.js");
    const r = render(<WidgetCard sessionId="s1" seq={7} index={0} title="Umidità" />);
    const iframe = (await waitFor(() => {
      const f = r.container.querySelector("iframe");
      if (!f) throw new Error("no frame yet");
      return f;
    })) as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe.getAttribute("src")).toBe("/preview/W/widget.html");
    // The page's listeners are set after the frame is drawn.
    await new Promise((ok) => setTimeout(ok, 60));
    const post = (text: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: {
            jsonrpc: "2.0",
            method: "ui/message",
            params: { role: "user", content: [{ type: "text", text }] },
          },
        }),
      );
    // No click: it waits in the strip.
    post("Analizza la mia situazione");
    await waitFor(() => r.getByText("Manda"));
    expect(sent.filter((m) => m.type === "session.send")).toEqual([]);
    fireEvent.click(r.getByText("Lascia stare"));
    expect(r.queryByText("Manda")).toBeNull();
    // A click in the frame: the page's blur with the frame focused.
    iframe.focus();
    window.dispatchEvent(new globalThis.Event("blur"));
    await new Promise((ok) => setTimeout(ok, 5));
    post("Analizza la mia situazione");
    await waitFor(() =>
      expect(sent.find((m) => m.type === "session.send")).toMatchObject({
        sessionId: "s1",
        text: "Analizza la mia situazione",
        via: "artifact",
      }),
    );
    // Too long: never sent.
    post("x".repeat(4001));
    expect(sent.filter((m) => m.type === "session.send")).toHaveLength(1);
    // Size: the frame says its height, the page follows it.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 321 } },
      }),
    );
    await waitFor(() => expect(iframe.style.height).toBe("321px"));
  });
});

describe("artifacts in the canvas (3.5.9)", () => {
  it("knows an artifact by its folder", async () => {
    const { canvasKind } = await import("../src/components/Canvas.js");
    expect(canvasKind({ kind: "file", scope: "platform", path: "artefatti/conti.html" })).toBe(
      "artifact",
    );
    expect(canvasKind({ kind: "file", scope: "platform", path: "site/index.html" })).toBe("site");
  });

  it("opens an artifact as App, in the artifacts' frame, and as Source in the editor", async () => {
    const { Canvas } = await import("../src/components/Canvas.js");
    const r = render(
      <Canvas
        title="conti.html"
        target={{ kind: "file", scope: "platform", path: "artefatti/conti.html" }}
      />,
    );
    // The frame once the file's version is known (it reloads when the file changes).
    const frame = (await waitFor(() => {
      const f = r.container.querySelector(".artifact-frame iframe");
      if (!f?.getAttribute("src")?.includes("v=1")) throw new Error("no frame yet");
      return f;
    })) as HTMLIFrameElement;
    await new Promise((ok) => setTimeout(ok, 60));
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(r.getByText("App").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(r.getByText("Fanne un progetto")).toBeTruthy();
    // An error from the frame: counted in the bar and sent on for the agent.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          jsonrpc: "2.0",
          method: "redgiant/error",
          params: { kind: "error", message: "y is not defined", where: "line 3" },
        },
      }),
    );
    await waitFor(() => r.getByText("1 errore"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "artifactErrors")?.[1][0]).toMatchObject({
        ref: { kind: "file", scope: "platform", path: "artefatti/conti.html" },
        errors: [{ kind: "error", message: "y is not defined", where: "line 3" }],
      }),
    );
    fireEvent.click(r.getByText("Sorgente"));
    await waitFor(() => expect(r.container.querySelector(".artifact-frame")).toBeNull());
    expect(r.container.querySelector(".doc-shell, .doc-fallback, .empty")).toBeTruthy();
  });
});
