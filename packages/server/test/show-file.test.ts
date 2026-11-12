// show_file (G34.1): an agent opens a file in the person's canvas; outside its folders the
// guardian asks the person first, and only a file shown that way can be opened from outside.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { copyOfAnyOriginal, originalOfAnyCopy } from "../src/editor/copies.js";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
// Room for every tool's description, fixed here so that no summary starts mid-turn.
const ROOM = { contextWindow: 65_536 };
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const resultOf = (req: { messages: { parts: { type: string }[] }[] }) => {
  const part = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
    | { content: string }
    | undefined;
  return part?.content;
};

// A file outside every workspace and outside the system's scratch folder, on every OS.
const OUTSIDE = fileURLToPath(new URL("../package.json", import.meta.url));

async function god(server: Server) {
  const g = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
    agentId: g.body.id,
  });
  return body.sessionId;
}

describe("show_file (G34.1)", () => {
  it("opens a workspace file as an event, served in ranges for the players", async () => {
    const bytes = "0123456789".repeat(100);
    let answer = "";
    s = await startServer((req) => {
      const r = resultOf(req);
      if (r === undefined)
        return {
          toolCalls: [{ name: "write_file", input: { path: "out/clip.mp4", content: bytes } }],
        };
      if (!r.startsWith("Opened"))
        return { toolCalls: [{ name: "show_file", input: { path: "out/clip.mp4" } }] };
      answer = r;
      return { text: "It is in the canvas." };
    }, ROOM);
    const sessionId = await god(s);
    await (await s.core.send("me", sessionId, "Show me the clip")).done;
    // The agent is told what the person sees (p3.3.1).
    expect(answer).toMatch(/in its video player: no conversion is needed/);
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sessionId}/events`)).body;
    const shown = events.find((e) => e.type === "canvas.show");
    expect(shown?.payload).toEqual({
      title: "clip.mp4",
      target: { kind: "file", scope: "platform", path: "out/clip.mp4" },
    });
    // No question asked: the file is the agent's own.
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    const link = await s.api<{ url: string }>("POST", "/api/canvas/link", {
      kind: "file",
      scope: "platform",
      path: "out/clip.mp4",
    });
    const whole = await fetch(`${s.url}${link.body.url}`);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe(bytes);
    const part = await fetch(`${s.url}${link.body.url}`, { headers: { Range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(await part.text()).toBe("0123456789");
    const tail = await fetch(`${s.url}${link.body.url}`, { headers: { Range: "bytes=-5" } });
    expect(await tail.text()).toBe("56789");
    expect(
      (await fetch(`${s.url}${link.body.url}`, { headers: { Range: "bytes=5000-" } })).status,
    ).toBe(416);
    // Only the file's own change counts for a viewer.
    const v = await s.api<{ version: number }>(
      "GET",
      "/api/canvas/version?scope=platform&path=out/clip.mp4&only=file",
    );
    expect(v.body.version).toBeGreaterThan(0);
  });

  it("asks the person before showing a file outside the agent's folders; that file only", async () => {
    s = await startServer((req) => {
      const r = resultOf(req);
      if (r === undefined) return { toolCalls: [{ name: "show_file", input: { path: OUTSIDE } }] };
      return { text: r };
    }, ROOM);
    const sessionId = await god(s);
    // Never shown: the "outside" scope opens nothing.
    expect(
      (await s.api("POST", "/api/canvas/link", { kind: "file", scope: "outside", path: OUTSIDE }))
        .status,
    ).toBe(400);
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId, text: "show me the package file" });
    const req = await c.waitFor("permission.request");
    expect(req.request.reasons[0]).toMatch(/shows a file outside the project: .*package\.json/);
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "allow",
      remember: false,
    });
    const shown = await c.waitFor("event", (m) => m.event.type === "canvas.show");
    expect(shown.event.payload).toEqual({
      title: "package.json",
      target: { kind: "file", scope: "outside", path: OUTSIDE },
    });
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    c.close();
    const link = await s.api<{ url: string }>("POST", "/api/canvas/link", {
      kind: "file",
      scope: "outside",
      path: OUTSIDE,
    });
    expect(link.status).toBe(200);
    const page = await fetch(`${s.url}${link.body.url}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('"name": "@redgiant/server"');
    // Nothing next to it: the link opens that one file.
    const next = link.body.url.replace(/package\.json$/, "tsconfig.json");
    expect((await fetch(`${s.url}${next}`)).status).toBe(403);
    expect(
      (
        await s.api<{ version: number }>(
          "GET",
          `/api/canvas/version?scope=outside&path=${encodeURIComponent(OUTSIDE)}`,
        )
      ).body.version,
    ).toBeGreaterThan(0);
  });

  it("shows nothing when the person says no", async () => {
    s = await startServer(
      (req) =>
        resultOf(req) === undefined
          ? { toolCalls: [{ name: "show_file", input: { path: OUTSIDE } }] }
          : { text: "Not shown." },
      ROOM,
    );
    const sessionId = await god(s);
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId, text: "show it" });
    const req = await c.waitFor("permission.request");
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "deny",
      remember: false,
    });
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    c.close();
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sessionId}/events`)).body;
    expect(events.some((e) => e.type === "canvas.show")).toBe(false);
    expect(
      (await s.api("POST", "/api/canvas/link", { kind: "file", scope: "outside", path: OUTSIDE }))
        .status,
    ).toBe(400);
  });
});

describe("p3.5.12: an original with an open copy shows the copy (the person's test of 3.5.11)", () => {
  it("show_file and show on a PPTX open its ODP copy in its tab and say so; older copies are said", async () => {
    let said: string[] = [];
    let step = 0;
    s = await startServer((req) => {
      const r = resultOf(req);
      if (r !== undefined) said.push(r);
      step++;
      if (step === 1) return { toolCalls: [{ name: "show_file", input: { path: "deck.pptx" } }] };
      if (step === 2) return { toolCalls: [{ name: "show", input: { path: "deck.pptx" } }] };
      return { text: "Shown." };
    }, ROOM);
    const root = s.core.platformPath("me");
    await mkdir(join(root, "deck.pptx.open"), { recursive: true });
    await writeFile(join(root, "deck.pptx"), "the original, two slides");
    await writeFile(join(root, "deck.pptx.open", "deck.odp"), "the copy, three slides");
    const ask = (path: string) =>
      s?.api<{ copy: string | null; stale?: boolean }>(
        "GET",
        `/api/editor/copy?scope=platform&path=${encodeURIComponent(path)}`,
      );
    // No record of when it was made: a copy, not said older.
    expect((await ask("deck.pptx"))?.body).toEqual({
      copy: "deck.pptx.open/deck.odp",
      stale: false,
    });
    // Made from the original as it is now: fresh.
    const st = await stat(join(root, "deck.pptx"));
    const manifest = (size: number) =>
      writeFile(
        join(root, "deck.pptx.open", "conversion.json"),
        JSON.stringify({
          source: "deck.pptx",
          sourceSize: size,
          sourceModifiedAt: st.mtime.toISOString(),
          format: "pptx",
          outputs: [{ path: "deck.pptx.open/deck.odp", ext: "odp" }],
          losses: [],
          via: ["libreoffice"],
          convertedAt: st.mtime.toISOString(),
        }),
      );
    await manifest(st.size);
    expect((await ask("deck.pptx"))?.body.stale).toBe(false);
    // The original changed outside since: older.
    await manifest(st.size + 1);
    expect((await ask("deck.pptx"))?.body.stale).toBe(true);
    // No copy for a file without one, nor for the copy itself.
    await writeFile(join(root, "notes.docx"), "x");
    expect((await ask("notes.docx"))?.body).toEqual({ copy: null });
    expect((await ask("deck.pptx.open/deck.odp"))?.body).toEqual({ copy: null });

    const sessionId = await god(s);
    said = [];
    await (await s.core.send("me", sessionId, "Show me the deck")).done;
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sessionId}/events`)).body;
    const shown = events.filter((e) => e.type === "canvas.show").map((e) => e.payload);
    const copy = { kind: "file", scope: "platform", path: "deck.pptx.open/deck.odp" };
    expect(shown).toEqual([
      { title: "deck.pptx", target: copy },
      { title: "deck.pptx", target: copy },
    ]);
    expect(said[0]).toMatch(/deck\.pptx has an open copy, deck\.pptx\.open\/deck\.odp/);
    expect(said[0]).toMatch(/changed outside after the copy was made.*«Rifai la copia»/);
    expect(said[1]).toMatch(/^Shown in the canvas: deck\.pptx\..*has an open copy/s);
  });

  it("«Rifai la copia» makes the copy again from the original (a 3D file's GLB)", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const root = s.core.platformPath("me");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "tri.obj"), "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n");
    const made = await s.api<{ path: string }>("POST", "/api/editor/model/copy", {
      scope: "platform",
      path: "tri.obj",
    });
    expect(made.body.path).toBe("tri.obj.open/tri.glb");
    const before = await readFile(join(root, "tri.obj.open", "tri.glb"));
    await writeFile(join(root, "tri.obj"), "v 0 0 0\nv 2 0 0\nv 2 2 0\nv 0 2 0\nf 1 2 3 4\n");
    const r = await s.api<{ job: string }>("POST", "/api/editor/copy/remake", {
      scope: "platform",
      path: "tri.obj",
    });
    expect(r.status).toBe(202);
    let job: { state: string } = { state: "running" };
    for (let i = 0; i < 200 && job.state === "running"; i++) {
      job = (await s.api<{ state: string }>("GET", `/api/jobs/${r.body.job}`)).body;
      if (job.state === "running") await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(job.state).toBe("done");
    const after = await readFile(join(root, "tri.obj.open", "tri.glb"));
    expect(Buffer.compare(before, after)).not.toBe(0);
    // A file with no open copy kind is refused.
    await writeFile(join(root, "a.txt"), "x");
    const bad = await s.api<{ job: string }>("POST", "/api/editor/copy/remake", {
      scope: "platform",
      path: "a.txt",
    });
    const failed = await (async () => {
      let j: { state: string } = { state: "running" };
      for (let i = 0; i < 200 && j.state === "running"; i++) {
        j = (await s?.api<{ state: string }>("GET", `/api/jobs/${bad.body.job}`))?.body ?? j;
        if (j.state === "running") await new Promise((ok) => setTimeout(ok, 50));
      }
      return j.state;
    })();
    expect(failed).toBe("failed");
  });
});

describe("p3.5.12: which originals have a copy shown in their tab, and back", () => {
  it.each([
    ["deck.pptx", "deck.pptx.open/deck.odp"],
    ["a/lettera.docx", "a/lettera.docx.open/lettera.odt"],
    ["bilancio.xlsx", "bilancio.xlsx.open/bilancio.ods"],
    ["logo.ai", "logo.ai.open/logo.svg"],
    ["fig.eps", "fig.eps.open/fig.svg"],
    ["art/poster.psd", "art/poster.psd.open/poster.ora"],
    ["tri.obj", "tri.obj.open/tri.glb"],
    ["photo.png", undefined],
    ["notes.txt", undefined],
    ["deck.pptx.open/deck.odp", undefined],
  ])("%s → %s", (original, copy) => {
    expect(copyOfAnyOriginal(original)).toBe(copy);
    if (copy) expect(originalOfAnyCopy(copy)).toBe(original);
  });
  it("a PNG's own layers are not a copy shown instead of it", () => {
    expect(originalOfAnyCopy("photo.png.open/photo.ora")).toBeUndefined();
  });
});
