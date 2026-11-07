// show_file (G34.1): an agent opens a file in the person's canvas; outside its folders the
// guardian asks the person first, and only a file shown that way can be opened from outside.
import { fileURLToPath } from "node:url";
import type { Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
