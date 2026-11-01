import { ProviderError } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

type Row = {
  id: string;
  title: string | null;
  pinned: boolean;
  archived: boolean;
  lastAt: string | null;
};

describe("the list of conversations", () => {
  it("titles sessions after their first message, pins and archives them, and searches them", async () => {
    s = await startServer(() => ({ text: "The checkout total is computed in cart.py." }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "Where is the 100% checkout total?\nDetails follow.")).done;
    await (await s.core.send("me", sid, "Thanks")).done;
    let [row] = (await s.api<Row[]>("GET", "/api/sessions")).body;
    expect(row).toMatchObject({
      title: "Where is the 100% checkout total?",
      pinned: false,
      archived: false,
    });
    expect(row?.lastAt).toBeTruthy();

    await s.api("PATCH", `/api/sessions/${sid}`, { pinned: true, title: "Checkout" });
    await s.api("PATCH", `/api/sessions/${sid}`, { archived: true });
    [row] = (await s.api<Row[]>("GET", "/api/sessions")).body;
    expect(row).toMatchObject({ title: "Checkout", pinned: true, archived: true });
    // Archiving hides a conversation from the list, never from the log.
    expect((await s.core.history("me", sid)).length).toBeGreaterThan(0);
    expect((await s.api("PATCH", "/api/sessions/sess_nope", { pinned: true })).status).toBe(404);

    const chat = (await s.api<{ id: string }>("POST", "/api/chats")).body;
    await s.core.chat.send("me", chat.id, "Remind me about the checkout tomorrow", [], () => {});
    const hits = (
      await s.api<{ kind: string; id: string; excerpt: string }[]>("GET", "/api/search?q=checkout")
    ).body;
    expect(hits.map((h) => h.kind).sort()).toEqual([
      "chat",
      "chat",
      "session",
      "session",
      "session",
    ]);
    expect(hits.find((h) => h.kind === "session")?.excerpt).toMatch(/checkout/i);
    // LIKE wildcards are matched literally.
    expect((await s.api<unknown[]>("GET", "/api/search?q=100%25")).body).toHaveLength(1);
    expect(
      (await s.api<unknown[]>("GET", "/api/search?q=checkout", undefined, "other-token-0123456789"))
        .body,
    ).toEqual([]);
  });

  it("lets a conversation pick its own model and effort, and go back to the agent's", async () => {
    s = await startServer(() => ({ text: "ok" }), { models: ["m1", "m2"] });
    expect((await s.api("GET", "/api/models")).body).toEqual([
      { provider: "fake", model: "m1", effort: true },
      { provider: "fake", model: "m2", effort: true },
    ]);
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "one")).done;
    const choice = { provider: "fake", model: "m2", effort: "high" };
    expect((await s.api("PATCH", `/api/sessions/${sid}`, { model: choice })).status).toBe(200);
    expect((await s.api<{ model: unknown }[]>("GET", "/api/sessions")).body[0]?.model).toEqual(
      choice,
    );
    await (await s.core.send("me", sid, "two")).done;
    expect(s.provider.requests.at(-1)).toMatchObject({ model: "m2", effort: "high" });
    // The history stays: the second turn saw the first one.
    expect(s.provider.requests.at(-1)?.messages).toHaveLength(3);
    expect(
      (await s.api("PATCH", `/api/sessions/${sid}`, { model: { provider: "nope", model: "x" } }))
        .status,
    ).toBe(400);
    await s.api("PATCH", `/api/sessions/${sid}`, { model: null });
    expect((await s.api<{ model: unknown }[]>("GET", "/api/sessions")).body[0]?.model).toBeNull();
  });

  it("exports a conversation as Markdown", async () => {
    s = await startServer(() => ({ text: "The **total** is in cart.py." }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "Zeus",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "Where is the total?")).done;
    const r = await fetch(`${s.url}/api/sessions/${sid}/export`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(r.headers.get("content-disposition")).toContain("Where%20is%20the%20total.md");
    const md = await r.text();
    expect(md).toMatch(/^# Where is the total\?\n/);
    expect(md).toContain("## You · ");
    expect(md).toContain("## Zeus · ");
    expect(md).toContain("The **total** is in cart.py.");
  });

  it("shows a refused key until it works again, and drops idle conversations from memory", async () => {
    let refuse = true;
    s = await startServer(() =>
      refuse
        ? { error: new ProviderError("fake: HTTP 401 invalid key", false, { status: 401 }) }
        : { text: "ok" },
    );
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "hi")).done.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    type Info = { keyProblems: { provider: string; message: string }[] };
    expect((await s.api<Info>("GET", "/api/platform")).body.keyProblems).toEqual([
      { provider: "fake", message: "fake: HTTP 401 invalid key" },
    ]);
    refuse = false;
    await (await s.core.send("me", sid, "again")).done;
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.api<Info>("GET", "/api/platform")).body.keyProblems).toEqual([]);
    // Idle and followed by nobody: out of memory; the next message rebuilds it from the log.
    expect(s.core.closeIdle(0)).toBe(1);
    await (await s.core.send("me", sid, "still there?")).done;
    expect(s.provider.requests.at(-1)?.messages.length).toBeGreaterThan(3);
  });
});
