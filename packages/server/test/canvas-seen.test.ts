// p3.5.6: canvas_look sees what the person sees (the person's test of 3.5.5 on Windows). A page
// slow to answer is waited for and never called «no page open»; a move or a tab shown in the same
// answer comes before the look; a file named by its path is seen where the person is in its tab;
// the pages are counted on the file as it is; an edit of an open copy shows the copy in its tab.
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ToolContext } from "@redgiant/agent";
import { CONCURRENT_TOOLS, READ_ONLY_TOOLS } from "@redgiant/hierarchy";
import type { CanvasState } from "@redgiant/protocol";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasLive, type CanvasSeen } from "../src/canvas-live.js";
import { type CanvasToolsHost, canvasTools, stateText, tabShowing } from "../src/canvas-tools.js";
import { originalOfAnyCopy, originalOfSheetCopy } from "../src/editor/copies.js";
import { startServer, wsClient } from "./helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PDF_ON_2: CanvasState = {
  visible: true,
  tabs: [
    {
      title: "modulo.pdf",
      target: { kind: "file", scope: "platform", path: "modulo.pdf" },
      active: true,
      kind: "pdf",
      place: { page: 2, pages: 2 },
    },
  ],
};

describe("CanvasLive: a page slow to answer (p3.5.6)", () => {
  it("a page busy for 2 s (an editor loading) is waited for, not called «no page open»", async () => {
    const live = new CanvasLive();
    live.onQuery((owner, id) => {
      setTimeout(() => live.answer(owner, id, PDF_ON_2), 2000);
      return true;
    }, "me");
    const started = Date.now();
    const seen = await live.see("me");
    expect(seen).toEqual({ state: PDF_ON_2, pages: 1 });
    expect(Date.now() - started).toBeLessThan(2600);
  });

  it("a page that never answers: its last word with its age, or that it is open but silent", async () => {
    let now = 1_000_000;
    const live = new CanvasLive(() => now);
    const times = { soft: 30, hard: 80 };
    let silent = false;
    live.onQuery((owner, id) => {
      if (!silent) setTimeout(() => live.answer(owner, id, PDF_ON_2), 5);
      return true;
    }, "me");
    // Nothing known yet and silent: open, but no answer.
    silent = true;
    expect(await live.see("me", times)).toEqual({ pages: 1 });
    expect(stateText({ pages: 1 })).toMatch(
      /^The person has a RedGiant page open, but it did not answer in time/,
    );
    silent = false;
    expect(await live.see("me", times)).toEqual({ state: PDF_ON_2, pages: 1 });
    silent = true;
    now += 7000;
    const late = await live.see("me", times);
    expect(late).toEqual({ state: PDF_ON_2, pages: 1, ageMs: 7000 });
    expect(stateText(late)).toMatch(
      /^The person's page did not answer in time \(it may be busy\); this is what it showed 7 s ago\. The person's canvas \(in view\), 1 tab:\n1\. \[active\] modulo\.pdf/,
    );
    // `ask` (a tab to edit) never takes an old answer for a fresh one.
    expect(await live.ask("me", times)).toBeUndefined();
  });

  it("no page at all: at once; a page that just went is waited for while it comes back", async () => {
    const live = new CanvasLive();
    const started = Date.now();
    expect(await live.see("me")).toEqual({ pages: 0 });
    expect(Date.now() - started).toBeLessThan(100);
    expect(stateText({ pages: 0 })).toBe(
      "The person has no RedGiant page open now: their canvas cannot be seen.",
    );
    // The page reloads: its connection goes, a new one comes 300 ms later and gets the question.
    const off = live.onQuery(() => true, "me");
    off();
    const asked = live.see("me");
    await wait(300);
    live.onQuery((owner, id) => {
      setTimeout(() => live.answer(owner, id, PDF_ON_2), 5);
      return true;
    }, "me");
    expect(await asked).toEqual({ state: PDF_ON_2, pages: 1 });
  });

  it("a page shown in view answers for all; an empty one in the background waits for the soft time", async () => {
    const live = new CanvasLive();
    const hidden = { visible: false, tabs: [] };
    live.onQuery((owner, id) => {
      setTimeout(() => live.answer(owner, id, hidden), 5);
      return true;
    });
    // A connection that never answers (the CLI): the answer in hand is enough after `soft`.
    live.onQuery(() => true);
    const started = Date.now();
    expect(await live.see("me", { soft: 100, hard: 5000 })).toEqual({ state: hidden, pages: 2 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("tools that run together (p3.5.6)", () => {
  it("the canvas's moves run in the model's order, before a look in the same answer", () => {
    for (const t of ["show_file", "canvas_act"]) {
      expect(READ_ONLY_TOOLS.has(t)).toBe(true);
      expect(CONCURRENT_TOOLS.has(t)).toBe(false);
    }
    for (const t of ["canvas_look", "read_file", "grep"])
      expect(CONCURRENT_TOOLS.has(t)).toBe(true);
  });
});

describe("open copies in their original's tab", () => {
  it.each([
    ["docs/bilancio.xlsx.open/bilancio.ods", "docs/bilancio.xlsx"],
    ["d/piano.pptx.open/piano.odp", "d/piano.pptx"],
    ["d/relazione.docx.open/relazione.odt", "d/relazione.docx"],
    ["d/logo.ai.open/logo.svg", "d/logo.ai"],
    ["d/sedia.fbx.open/sedia.glb", "d/sedia.fbx"],
    ["d/bilancio.ods", undefined],
    ["d/bilancio.xlsx.open/altro.ods", undefined],
    ["d/foto.png.open/foto.ora", undefined],
  ])("%s → %s", (copy, original) => {
    expect(originalOfAnyCopy(copy)).toBe(original);
  });

  it("a sheet's copy only", () => {
    expect(originalOfSheetCopy("a\\b.xlsx.open\\b.ods")).toBe("a/b.xlsx");
    expect(originalOfSheetCopy("a/b.docx.open/b.odt")).toBeUndefined();
  });
});

describe("canvas_look on what the person has open (p3.5.6)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const ctx: ToolContext = { ownerId: "me", projectId: null, agentId: "a", sessionId: "s" };

  async function tools(seen: CanvasSeen, look: CanvasToolsHost["look"]) {
    dir = await mkdtemp(join(tmpdir(), "rg-seen-"));
    await mkdir(join(dir, "deck.pptx.open"), { recursive: true });
    for (const f of ["modulo.pdf", "notes.md", "deck.pptx", "deck.pptx.open/deck.odp"])
      await writeFile(join(dir, f), "x");
    const root = dir;
    const asked: unknown[] = [];
    const host: CanvasToolsHost = {
      state: async () => seen,
      targetOf: async (_o, abs) => ({ kind: "file", scope: "platform", path: abs }),
      fileOf: async (_o, t) => join(root, t.path),
      look: async (abs, ask, c) => {
        // The temporary folder may reach the tool by another name (macOS /private/var, Windows
        // short names): compared as real paths, with forward slashes.
        const file = relative(realpathSync.native(root), realpathSync.native(abs));
        asked.push({ file: file.split(sep).join("/"), ...ask });
        return look(abs, ask, c);
      },
      act: async () => {},
    };
    const [lookTool, actTool] = canvasTools({ ownerId: "me" }, new LocalWorkspace(root), host);
    const run = async (t: typeof lookTool, input: unknown) => {
      const out = await t?.run(input as never, ctx);
      return typeof out === "string" ? out : String(out?.content);
    };
    return {
      asked,
      look: (input: unknown) => run(lookTool, input),
      act: (input: unknown) => run(actTool, input),
    };
  }

  it("a file named by its path is seen at the page of its tab", async () => {
    const t = await tools({ state: PDF_ON_2, pages: 1 }, async () => ({
      kind: "pdf",
      text: "PDF: page 2 of 2.",
      page: 2,
      pages: 2,
    }));
    const out = await t.look({ path: "modulo.pdf" });
    expect(t.asked).toEqual([expect.objectContaining({ file: "modulo.pdf", page: 2 })]);
    expect(out).toContain("Looking at modulo.pdf (open in the person's tab modulo.pdf): ");
    // A page the agent asks for is its own.
    await t.look({ path: "modulo.pdf", page: 1 });
    expect(t.asked[1]).toMatchObject({ page: 1 });
  });

  it("the pages are counted on the file as it is: a slide added, the tab says 4", async () => {
    const deck: CanvasState = {
      visible: true,
      tabs: [
        {
          title: "deck.pptx",
          target: { kind: "file", scope: "platform", path: "deck.pptx.open/deck.odp" },
          active: true,
          kind: "office",
          place: { page: 1, pages: 3 },
        },
      ],
    };
    const t = await tools({ state: deck, pages: 1 }, async () => ({
      kind: "paged",
      text: "Document: page 1 of 4.",
      page: 1,
      pages: 4,
    }));
    const out = await t.look({});
    expect(out).toContain("1. [active] deck.pptx (office: deck.pptx.open/deck.odp): page 1 of 4\n");
    expect(out).not.toContain("of 3");
    // The original named by its path: the tab of its copy is where the person is.
    const tab = await tabShowing(deck, join(dir as string, "deck.pptx"), async (x) =>
      join(dir as string, x.path),
    );
    expect(tab?.title).toBe("deck.pptx");
  });

  it("a page too busy to answer: its last word, or that it is open; never «no page open»", async () => {
    const t = await tools({ pages: 1 }, async () => ({ kind: "text", text: "" }));
    expect(await t.look({})).toMatch(/^The person has a RedGiant page open, but it did not answer/);
    expect(await t.act({ page: 2 })).toMatch(/^The person's page did not answer in time/);
    const old = await tools({ state: PDF_ON_2, pages: 1, ageMs: 4000 }, async () => ({
      kind: "pdf",
      text: "PDF: page 2 of 2.",
      page: 2,
      pages: 2,
    }));
    expect(await old.look({})).toMatch(/^The person's page did not answer in time .* 4 s ago\./);
  });
});

describe("a move and a look in one answer (p3.5.6)", () => {
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("show_file, then canvas_look: the page is asked once the tab is open", async () => {
    const seen: string[] = [];
    let step = 0;
    s = await startServer(
      (req: { messages: { parts: { type: string; content?: string }[] }[] }) => {
        for (const p of req.messages.at(-1)?.parts ?? [])
          if (p.type === "tool_result") seen.push(String(p.content));
        if (step++ === 0)
          return {
            toolCalls: [
              { name: "write_file", input: { path: "notes/plan.md", content: "one\ntwo\n" } },
            ],
          };
        if (step === 2)
          return {
            toolCalls: [
              { name: "show_file", input: { path: "notes/plan.md" } },
              { name: "canvas_look", input: {} },
            ],
          };
        return { text: "Done." };
      },
      { contextWindow: 65_536 },
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sessionId = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    c.send({ type: "session.follow", sessionId });
    await c.waitFor("session.synced");
    // The page: the tabs it was shown so far, as state.ts keeps them.
    const answered = new Set<string>();
    const timer = setInterval(() => {
      for (const m of c.messages)
        if (m.type === "canvas.query" && !answered.has(m.requestId)) {
          answered.add(m.requestId);
          const shown = c.messages.flatMap((x) =>
            x.type === "event" && x.event.type === "canvas.show" ? [x.event.payload] : [],
          );
          c.send({
            type: "canvas.state",
            requestId: m.requestId,
            state: {
              visible: true,
              tabs: shown.map((p, i) => ({
                title: p.title,
                target: p.target,
                active: i === shown.length - 1,
              })),
            },
          });
        }
    }, 5);
    await (await s.core.send("me", sessionId, "show it and look")).done;
    clearInterval(timer);
    const look = seen.find((r) => r.startsWith("The person's canvas")) ?? seen.join("\n");
    expect(look).toContain("1. [active] plan.md (file: notes/plan.md)");
    expect(look).toContain("Looking at plan.md");
    c.close();
  });
});
