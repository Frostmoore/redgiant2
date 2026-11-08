// The canvas seen and moved by the agent (G36.12): canvas_look asks the person's page what it
// shows (only then), draws the file on the server and answers with words and a picture;
// canvas_act records a move the page follows. A path outside the folders asks the person first,
// as show_file does; a tab outside the agent's folders is described, never drawn.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanvasState, Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { pngOf } from "../src/convert-js.js";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
const ROOM = { contextWindow: 65_536 };
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const OUTSIDE = fileURLToPath(new URL("../package.json", import.meta.url));

type Req = { messages: { parts: { type: string; content?: string }[] }[] };
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;

async function god(server: Server) {
  const g = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  return (await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id }))
    .body.sessionId;
}

/** A script: these tool calls one after the other, then the last result as text. */
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

describe("canvas_look and canvas_act (G36.12)", () => {
  it("sees the tabs and where the person is, and the lines they look at", async () => {
    const seen: string[] = [];
    s = await startServer(
      calls(
        [
          { name: "write_file", input: { path: "notes/plan.md", content: lines } },
          { name: "canvas_look", input: {} },
        ],
        seen,
      ),
      ROOM,
    );
    const sessionId = await god(s);
    const state: CanvasState = {
      visible: true,
      tabs: [
        {
          title: "clip.mp4",
          target: { kind: "file", scope: "platform", path: "out/clip.mp4" },
          active: false,
          kind: "video",
          place: { time: 75, duration: 120, playing: true },
        },
        {
          title: "plan.md",
          target: { kind: "file", scope: "platform", path: "notes/plan.md" },
          active: true,
          kind: "markdown",
          place: { line: 120, lines: 200, selection: "line 120" },
        },
      ],
    };
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    // Asked only now: the page answers with its canvas.
    void c
      .waitFor("canvas.query", () => true, 20_000)
      .then((q) => c.send({ type: "canvas.state", requestId: q.requestId, state }));
    await (await s.core.send("me", sessionId, "What am I looking at?")).done;
    const look = seen[1] as string;
    expect(look).toContain("The person's canvas (in view), 2 tabs:");
    expect(look).toContain("1. clip.mp4 (video: out/clip.mp4): playing at 1:15 of 2:00");
    expect(look).toContain(
      "2. [active] plan.md (markdown: notes/plan.md): line 120 of 200, selected: «line 120»",
    );
    // What was not asked comes from where the person is: line 120.
    expect(look).toMatch(/Looking at plan\.md: plan\.md \(\d+ KB\)\. Lines 120-199 of 200/);
    expect(c.messages.filter((m) => m.type === "canvas.query")).toHaveLength(1);
    c.close();
  });

  it("without a page open it says so, and still draws a file it is given", async () => {
    const seen: string[] = [];
    s = await startServer(
      calls(
        [
          { name: "canvas_look", input: {} },
          { name: "canvas_look", input: { path: "pics/dot.png" } },
          { name: "canvas_act", input: { page: 2 } },
        ],
        seen,
      ),
      ROOM,
    );
    const sessionId = await god(s);
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(join(root, "pics"), { recursive: true });
    const data = new Uint8Array(40 * 20 * 4).fill(255);
    await writeFile(join(root, "pics/dot.png"), pngOf({ width: 40, height: 20, data }));
    await (await s.core.send("me", sessionId, "look")).done;
    expect(seen[0]).toMatch(/no RedGiant page open now.*\n\nNothing to look at: give a path/);
    expect(seen[1]).toMatch(/Looking at pics\/dot\.png: dot\.png \(\d+ B\)\. Picture 40×20\./);
    expect(seen[2]).toBe("The person has no RedGiant page open: nothing to move.");
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sessionId}/events`)).body;
    const pictures = events.flatMap((e) =>
      e.type === "tool.result" ? (e.payload.images ?? []) : [],
    );
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ mediaType: "image/png", name: "dot.png.png" });
  });

  it("moves the canvas: a tab of the person's, or a file it opens", async () => {
    const seen: string[] = [];
    s = await startServer(
      calls(
        [
          { name: "write_file", input: { path: "doc/report.txt", content: lines } },
          { name: "canvas_act", input: { tab: 1, time: 30, play: false } },
          { name: "canvas_act", input: { path: "doc/report.txt", line: 40, to_line: 44 } },
          { name: "canvas_act", input: {} },
        ],
        seen,
      ),
      ROOM,
    );
    const sessionId = await god(s);
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    c.send({ type: "session.follow", sessionId });
    await c.waitFor("session.synced");
    const state: CanvasState = {
      visible: false,
      tabs: [
        {
          title: "Clip",
          target: { kind: "file", scope: "platform", path: "out/clip.mp4" },
          active: true,
        },
      ],
    };
    const answer = async () => {
      const q = await c.waitFor("canvas.query", (m) => !answered.has(m.requestId), 20_000);
      answered.add(q.requestId);
      c.send({ type: "canvas.state", requestId: q.requestId, state });
    };
    const answered = new Set<string>();
    void answer();
    await (await s.core.send("me", sessionId, "go")).done;
    expect(seen[1]).toBe(
      "Done: the person's canvas shows Clip (paused at 0:30). canvas_look shows what they see.",
    );
    expect(seen[2]).toMatch(
      /^Done: the person's canvas shows report\.txt \(line 40\), lines 40-44 selected\./,
    );
    expect(seen[3]).toMatch(/^Say what to do/);
    // The page follows the moves live.
    await c.waitFor(
      "event",
      (m) => m.event.type === "canvas.act" && m.event.payload?.title === "report.txt",
    );
    const acts = c.messages.flatMap((m) =>
      m.type === "event" && m.event.type === "canvas.act" ? [m.event.payload] : [],
    );
    expect(acts).toEqual([
      {
        title: "Clip",
        target: { kind: "file", scope: "platform", path: "out/clip.mp4" },
        do: { time: 30, play: false },
      },
      {
        title: "report.txt",
        target: { kind: "file", scope: "platform", path: "doc/report.txt" },
        do: { line: 40, toLine: 44 },
      },
    ]);
    c.close();
  });

  it("a tab outside the agent's folders is not drawn; its path asks the person first", async () => {
    const seen: string[] = [];
    s = await startServer(
      calls(
        [
          { name: "canvas_look", input: {} },
          { name: "canvas_look", input: { path: OUTSIDE, from_line: 1, to_line: 3 } },
        ],
        seen,
      ),
      ROOM,
    );
    const sessionId = await god(s);
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    c.send({ type: "session.follow", sessionId });
    await c.waitFor("session.synced");
    const state: CanvasState = {
      visible: true,
      tabs: [
        {
          title: "package.json",
          target: { kind: "file", scope: "outside", path: OUTSIDE },
          active: true,
        },
      ],
    };
    const answered = new Set<string>();
    const answerAll = async () => {
      for (;;) {
        const q = await c
          .waitFor("canvas.query", (m) => !answered.has(m.requestId), 20_000)
          .catch(() => undefined);
        if (!q) return;
        answered.add(q.requestId);
        c.send({ type: "canvas.state", requestId: q.requestId, state });
      }
    };
    void answerAll();
    c.send({ type: "session.send", sessionId, text: "look" });
    const req = await c.waitFor("permission.request", () => true, 20_000);
    expect(req.request.tool).toBe("canvas_look");
    expect(req.request.reasons[0]).toMatch(/^looks at a file outside the project: .*package\.json/);
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "allow",
      remember: false,
    });
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
      20_000,
    );
    expect(seen[0]).toContain(
      `Tab package.json is outside your workspace: to see it, call canvas_look with path "${OUTSIDE}"`,
    );
    expect(seen[1]).toMatch(/Lines 1-3 of \d+:\n1\| \{\n2\| {3}"name": "@redgiant\/server"/);
    c.close();
  });
});
