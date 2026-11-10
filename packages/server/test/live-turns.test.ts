// p3.5.4 (the person on 3.5.3, Windows: «I have to reload almost every turn», and canvas_look
// finding an empty canvas while a PDF was open on page 2): a page that follows a conversation
// receives every event of every turn, whatever else opened, rebuilt or let go of that
// conversation in between, and a slow open file never holds back its follows or its canvas.
import type { CanvasState, Event, ServerMessage } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
type Page = Awaited<ReturnType<typeof wsClient>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

const lastUser = (req: CompletionRequest) => {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === "user" && m.parts.some((p) => p.type === "text"))
      return m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  }
  return "";
};
const resultsAfterUser = (req: CompletionRequest) => {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    if (m.parts.every((p) => p.type === "tool_result")) n++;
    else break;
  }
  return n;
};

let orchestratorId = "";
/**
 * Every turn reads the folder once, then answers. God hands a task to the orchestrator when the
 * message says «delega»; the orchestrator does it and closes it.
 */
const script = (req: CompletionRequest): FakeTurn => {
  const asked = lastUser(req);
  const n = resultsAfterUser(req);
  if (asked.includes("<task_report")) return { text: "Noted." };
  if (req.system.startsWith("You are God") && asked.includes("delega")) {
    if (n === 0)
      return {
        toolCalls: [
          {
            name: "delegate",
            input: { agent_id: orchestratorId, title: "Files", task: "List the files" },
          },
        ],
      };
    return { text: "Handed over." };
  }
  const task_id = asked.match(/(task_[0-9a-f]+)/)?.[1];
  if (task_id && req.system.startsWith("You are the orchestrator")) {
    if (n === 0) return { toolCalls: [{ name: "list_files", input: { path: "." } }] };
    if (n === 1)
      return {
        toolCalls: [{ name: "complete_task", input: { task_id, verify_command: "node -e 0" } }],
      };
    return { text: "Task done." };
  }
  if (n === 0) return { toolCalls: [{ name: "list_files", input: { path: "." } }] };
  return { text: `Answer to: ${asked.slice(0, 40)}` };
};

/** The events of one session this page received. */
const eventsOf = (page: Page, sessionId: string): Event[] =>
  page.messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));

async function logOf(server: Server, sessionId: string): Promise<Event[]> {
  const r = await server.api<Event[]>("GET", `/api/sessions/${sessionId}/events`);
  return r.body;
}

/** Pages that followed from `afterSeq`: what they should have starts after it. */
const resumedAfter = new WeakMap<Page, number>();

/** Waits until the pages heard the turn end (`session.state` idle after running). */
async function turn(server: Server, pages: Page[], sessionId: string, text: string) {
  const from = pages.map((p) => p.messages.length);
  const by = pages[0] as Page;
  by.send({ type: "session.send", sessionId, text });
  for (const [i, p] of pages.entries()) {
    const start = from[i] as number;
    const end = Date.now() + 10_000;
    for (;;) {
      const tail = p.messages.slice(start);
      const ran = tail.findIndex(
        (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "running",
      );
      const idle =
        ran >= 0 &&
        tail
          .slice(ran)
          .some(
            (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "idle",
          );
      if (idle) break;
      if (Date.now() > end) throw new Error(`page ${i} never heard the turn «${text}» end`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // The answer is in the log: every page has every event of it, once, in order.
  const log = await logOf(server, sessionId);
  for (const p of pages) {
    const after = resumedAfter.get(p) ?? -1;
    expectSame(
      eventsOf(p, sessionId),
      log.filter((e) => e.seq > after),
      text,
    );
  }
}

function expectSame(heard: Event[], log: Event[], label: string) {
  const seqs = heard.map((e) => e.seq);
  expect(new Set(seqs).size, `duplicates after «${label}»`).toBe(seqs.length);
  expect(seqs, `the page's events after «${label}»`).toEqual(log.map((e) => e.seq));
}

async function boot() {
  s = await startServer(script, { contextWindow: 65_536 });
  const server = s;
  const god = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const project = await server.api<{ id: string }>("POST", "/api/projects", { name: "Alpha" });
  const orch = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: god.body.id,
    projectId: project.body.id,
    name: "Lead",
  });
  orchestratorId = orch.body.id;
  return { server, godId: god.body.id, orchId: orch.body.id, projectId: project.body.id };
}

/** Waits until every conversation is idle and stays so (tasks report back to God). */
async function settle(server: Server) {
  const end = Date.now() + 15_000;
  for (;;) {
    if (server.core.busySessions().length === 0) {
      await new Promise((r) => setTimeout(r, 300));
      if (server.core.busySessions().length === 0) return;
    }
    if (Date.now() > end) throw new Error("still working");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function follow(page: Page, sessionId: string) {
  page.send({ type: "session.follow", sessionId });
  await page.waitFor("session.synced", (m) => m.sessionId === sessionId);
}

async function newSession(server: Server, agentId: string) {
  const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId });
  return body.sessionId;
}

async function open(server: Server) {
  const p = await wsClient(server.url);
  await p.waitFor("welcome");
  return p;
}

const PDF_ON_PAGE_2: CanvasState = {
  visible: true,
  tabs: [
    {
      title: "report.pdf",
      target: { kind: "file", scope: "project:alpha", path: "report.pdf" },
      active: true,
      kind: "pdf",
    },
  ],
};

/** The page answers every canvas question with what it shows (as `state.ts` does). */
function answerCanvas(p: Page, state: CanvasState) {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const m of p.messages)
      if (m.type === "canvas.query" && !answered.has(m.requestId)) {
        answered.add(m.requestId);
        p.send({ type: "canvas.state", requestId: m.requestId, state });
      }
  }, 10);
  return () => clearInterval(timer);
}

describe("a followed conversation, turn after turn (p3.5.4)", () => {
  it("God's conversation: every event of three turns", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    await follow(p, id);
    await turn(server, [p], id, "first");
    await turn(server, [p], id, "second");
    await turn(server, [p], id, "third");
    p.close();
  });

  it("an orchestrator's and the Chat's conversations", async () => {
    const { server, orchId } = await boot();
    const chat = await server.api<{ id: string }>("GET", "/api/chat/agent");
    const p = await open(server);
    for (const agentId of [orchId, chat.body.id]) {
      const id = await newSession(server, agentId);
      await follow(p, id);
      await turn(server, [p], id, "first");
      await turn(server, [p], id, "second");
    }
    p.close();
  });

  it("God's and the orchestrator's conversations after God hands over tasks", async () => {
    const { server, godId, orchId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    await follow(p, id);
    await turn(server, [p], id, "first: delega");
    await settle(server);
    // The orchestrator's work conversation, opened by the page as the person does.
    const work = p.messages.find(
      (m) => m.type === "session.activity" && m.agentId === orchId,
    ) as Extract<ServerMessage, { type: "session.activity" }>;
    expect(work).toBeTruthy();
    await follow(p, work.sessionId);
    await turn(server, [p], id, "second: delega");
    await settle(server);
    await turn(server, [p], id, "third");
    await turn(server, [p], work.sessionId, "and you, orchestrator?");
    await settle(server);
    for (const sid of [id, work.sessionId])
      expectSame(eventsOf(p, sid), await logOf(server, sid), `everything in ${sid}`);
    p.close();
  });

  it("a conversation opened or rebuilt by other ways while the page follows it", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    await follow(p, id);
    await turn(server, [p], id, "first");
    // A channel (Telegram) and an automation write in it: the page sees their turns.
    await (await server.core.send("me", id, "from the phone", { human: true })).done;
    await (await server.core.send("me", id, "nightly check", { from: "automation" })).done;
    await settle(server);
    expectSame(eventsOf(p, id), await logOf(server, id), "a channel and an automation");
    // The agent's model changed: the conversation leaves memory and the next message (from the
    // channel) builds it again; the page still follows the conversation.
    server.core.agentModelChanged(godId);
    await (await server.core.send("me", id, "again from the phone", { human: true })).done;
    await settle(server);
    expectSame(eventsOf(p, id), await logOf(server, id), "rebuilt by a channel");
    // Its own model chosen from the composer: rebuilt at once, still followed.
    await server.api("PATCH", `/api/sessions/${id}`, { model: { provider: "fake", model: "m2" } });
    await turn(server, [p], id, "after the model changed");
    // A long pause: a followed conversation never leaves memory.
    expect(server.core.closeIdle(0)).toBe(0);
    await turn(server, [p], id, "after a pause");
    p.close();
  });

  it("follows again without doubles once a rebuilt conversation was let go", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    await follow(p, id);
    await turn(server, [p], id, "first");
    // Rebuilt with another model while followed, then let go and followed again (a tab closed
    // and opened): before, the rebuilt copy kept the old listener and every delta came twice.
    await server.api("PATCH", `/api/sessions/${id}`, { model: { provider: "fake", model: "m2" } });
    p.send({ type: "session.unfollow", sessionId: id });
    const had = eventsOf(p, id).at(-1)?.seq ?? -1;
    p.send({ type: "session.follow", sessionId: id, afterSeq: had });
    await p.waitFor("session.synced", (m) => m.sessionId === id && m.lastSeq === had);
    const from = p.messages.length;
    await turn(server, [p], id, "second");
    const deltas = p.messages
      .slice(from)
      .flatMap((m) => (m.type === "delta" && m.sessionId === id ? [m.text] : []))
      .join("");
    expect(deltas).toBe("Answer to: second");
    // Let go for good: nothing more reaches the page, and the conversation may leave memory.
    p.send({ type: "session.unfollow", sessionId: id });
    p.send({ type: "ping" });
    await p.waitFor("pong");
    const before = p.messages.length;
    await (await server.core.send("me", id, "from the phone", { human: true })).done;
    const after = p.messages
      .slice(before)
      .filter((m) => m.type === "event" || m.type === "delta" || m.type === "session.state");
    expect(after).toEqual([]);
    expect(server.core.closeIdle(0)).toBe(1);
    p.close();
  });

  it("two pages, one reconnecting from afterSeq between turns", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const a = await open(server);
    const b = await open(server);
    await follow(a, id);
    await follow(b, id);
    await turn(server, [a, b], id, "first");
    // b loses its connection and comes back with what it has.
    const had = eventsOf(b, id);
    b.close();
    const b2 = await open(server);
    b2.send({ type: "session.follow", sessionId: id, afterSeq: had.at(-1)?.seq });
    await b2.waitFor("session.synced", (m) => m.sessionId === id);
    resumedAfter.set(b2, had.at(-1)?.seq ?? -1);
    await turn(server, [a, b2], id, "second");
    expect([...had, ...eventsOf(b2, id)].map((e) => e.seq)).toEqual(
      (await logOf(server, id)).map((e) => e.seq),
    );
    a.close();
    b2.close();
  });

  it("an open file the editor is slow with holds back neither follows nor the canvas", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    const stop = answerCanvas(p, PDF_ON_PAGE_2);
    // The editor takes its time with the PDF (read again, or an agent's edit of it first).
    const editor = server.core.editor;
    let release!: () => void;
    const slow = new Promise<void>((ok) => {
      release = ok;
    });
    const subscribe = editor.subscribe.bind(editor);
    editor.subscribe = async (...args) => {
      await slow;
      return subscribe(...args);
    };
    const pdf = { scope: "project:alpha", path: "report.pdf" };
    p.send({ type: "doc.open", file: pdf });
    p.send({ type: "doc.presence", file: pdf, editing: false, from: 2 });
    // Behind it: the chat is followed and the agent's canvas_look gets its answer.
    await follow(p, id);
    await turn(server, [p], id, "while the PDF opens");
    expect(await server.core.canvasLive.ask("me")).toEqual(PDF_ON_PAGE_2);
    release();
    stop();
    p.close();
  });

  it("canvas_look after a turn and after the page reloads", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    const p = await open(server);
    let stop = answerCanvas(p, PDF_ON_PAGE_2);
    await follow(p, id);
    await turn(server, [p], id, "first");
    expect(await server.core.canvasLive.ask("me")).toEqual(PDF_ON_PAGE_2);
    await turn(server, [p], id, "second");
    expect(await server.core.canvasLive.ask("me")).toEqual(PDF_ON_PAGE_2);
    // The page reloads: the old connection goes, the new one answers alone.
    stop();
    const had = eventsOf(p, id).at(-1)?.seq ?? -1;
    p.close();
    const again = await open(server);
    stop = answerCanvas(again, PDF_ON_PAGE_2);
    again.send({ type: "session.follow", sessionId: id, afterSeq: had });
    await again.waitFor("session.synced", (m) => m.sessionId === id);
    resumedAfter.set(again, had);
    await turn(server, [again], id, "after the reload");
    const started = Date.now();
    expect(await server.core.canvasLive.ask("me")).toEqual(PDF_ON_PAGE_2);
    // Answered at once, never after waiting for the closed page.
    expect(Date.now() - started).toBeLessThan(1000);
    stop();
    again.close();
  });

  it("canvas_look with two browser tabs: the one with files wins over an empty one", async () => {
    const { server } = await boot();
    const empty = await open(server);
    const person = await open(server);
    // The empty tab answers at once; the person's page, with the canvas behind the chat, later.
    const stopEmpty = answerCanvas(empty, { visible: false, tabs: [] });
    const behind = { ...PDF_ON_PAGE_2, visible: false };
    const asked = server.core.canvasLive.ask("me");
    await person.waitFor("canvas.query");
    await new Promise((r) => setTimeout(r, 100));
    const stopPerson = answerCanvas(person, behind);
    expect(await asked).toEqual(behind);
    // In view: that one, whoever answers first.
    stopPerson();
    const stopShown = answerCanvas(person, PDF_ON_PAGE_2);
    expect(await server.core.canvasLive.ask("me")).toEqual(PDF_ON_PAGE_2);
    stopEmpty();
    stopShown();
    empty.close();
    person.close();
  });

  it("the history of a long conversation in one message, and then only what is new", async () => {
    const { server, godId } = await boot();
    const id = await newSession(server, godId);
    for (let i = 0; i < 12; i++) await (await server.core.send("me", id, `turn ${i}`)).done;
    const log = await logOf(server, id);
    expect(log.length).toBeGreaterThan(50);
    // A page that reloads (F5): everything, in one message, then the state.
    const p = await open(server);
    p.send({ type: "session.follow", sessionId: id, history: true });
    const h = await p.waitFor("session.history", (m) => m.sessionId === id);
    expect(h.events.map((e) => e.seq)).toEqual(log.map((e) => e.seq));
    expect(h.lastSeq).toBe(log.at(-1)?.seq);
    expect(h.incremental).toBe(false);
    await p.waitFor("session.state", (m) => m.sessionId === id);
    expect(p.messages.filter((m) => m.type === "event" || m.type === "session.synced")).toEqual([]);
    // Live events after it come one by one, as always.
    resumedAfter.set(p, h.lastSeq);
    await turn(server, [p], id, "live");
    expect(eventsOf(p, id).length).toBeGreaterThan(0);
    const had = (await logOf(server, id)).at(-1)?.seq as number;
    p.close();
    // Reconnected with what it has: only what came since, said to be incremental.
    await (await server.core.send("me", id, "while away")).done;
    const again = await open(server);
    again.send({ type: "session.follow", sessionId: id, afterSeq: had, history: true });
    const more = await again.waitFor("session.history", (m) => m.sessionId === id);
    expect(more.incremental).toBe(true);
    expect(more.events.map((e) => e.seq)).toEqual(
      (await logOf(server, id)).filter((e) => e.seq > had).map((e) => e.seq),
    );
    again.close();
  });
});
