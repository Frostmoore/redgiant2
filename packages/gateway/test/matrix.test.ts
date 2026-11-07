import { afterEach, describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { MatrixTransport } from "../src/matrix.js";

// ---------- A fake homeserver: the client-server API by path, every call recorded ----------

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | null;
  body: unknown;
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

function fakeHs(handler: (c: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  /** Sync answers, one per long poll; an empty one when the queue is dry. */
  const syncs: unknown[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      auth: new Headers(init?.headers).get("authorization"),
      body:
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw
            ? Buffer.from(raw as Uint8Array)
            : undefined,
    };
    calls.push(c);
    if (c.auth !== "Bearer syt_good_token_123456")
      return json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }, 401);
    const own = await handler(c);
    if (own) return own;
    if (c.path === "/_matrix/client/v3/account/whoami") return json({ user_id: "@rg:example.org" });
    if (c.path === "/_matrix/client/v3/sync") {
      const next = syncs.shift();
      if (next) return json(next);
      // A long poll with nothing new: a moment, then empty.
      await new Promise((r) => setTimeout(r, 5));
      return json({ next_batch: `s${calls.length}` });
    }
    if (c.path.includes("/send/m.room.message/")) return json({ event_id: `$e${calls.length}` });
    if (c.path.startsWith("/_matrix/client/v3/join/")) return json({ room_id: "!new:example.org" });
    if (c.path.includes("/typing/")) return json({});
    if (c.path === "/_matrix/media/v3/upload")
      return json({ content_uri: "mxc://example.org/up1" });
    return undefined;
  }) as typeof fetch;
  return { calls, syncs, fetch: fetchFn };
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const transports: MatrixTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.stop();
});

function make(
  handler: Parameters<typeof fakeHs>[0] = () => undefined,
  token = "syt_good_token_123456",
) {
  const f = fakeHs(handler);
  const t = new MatrixTransport({
    homeserver: "https://hs.example.org/",
    accessToken: token,
    fetch: f.fetch,
    syncTimeoutMs: 10,
    retryMs: 5,
  });
  transports.push(t);
  return { t, ...f };
}

const room = (events: unknown[], members = 2) => ({
  summary: { "m.joined_member_count": members },
  timeline: { events },
});

describe("MatrixTransport", () => {
  it("refuses to start with a wrong token", async () => {
    const { t } = make(undefined, "syt_wrong_token_123456");
    await expect(t.start(async () => {})).rejects.toThrow(/401/);
  });

  it("skips what came before, joins invitations and relays new messages", async () => {
    const got: Incoming[] = [];
    const { t, calls, syncs } = make();
    syncs.push({
      next_batch: "s1",
      rooms: {
        invite: { "!dm:example.org": {} },
        join: {
          "!old:example.org": room([
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: { msgtype: "m.text", body: "old" },
            },
          ]),
        },
      },
    });
    syncs.push({
      next_batch: "s2",
      rooms: {
        join: {
          "!dm:example.org": room([
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: { msgtype: "m.text", body: "/start 123456" },
            },
            // Our own answers and other bots' notices are never answered.
            {
              type: "m.room.message",
              sender: "@rg:example.org",
              content: { msgtype: "m.text", body: "mine" },
            },
            {
              type: "m.room.message",
              sender: "@bot:example.org",
              content: { msgtype: "m.notice", body: "beep" },
            },
          ]),
        },
      },
    });
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({
      userId: "@anna:example.org",
      chatId: "!dm:example.org",
      username: "@anna:example.org",
      text: "/start 123456",
    });
    expect(
      calls.some(
        (c) => c.method === "POST" && c.path === "/_matrix/client/v3/join/!dm:example.org",
      ),
    ).toBe(true);
    // The second sync goes on from where the first one stopped.
    const second = calls.filter((c) => c.path === "/_matrix/client/v3/sync")[1];
    expect(second?.query.get("since")).toBe("s1");
    expect(JSON.parse(second?.query.get("filter") ?? "{}").room.timeline.types).toContain(
      "m.room.encrypted",
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toHaveLength(1);
  });

  it("in a room with others answers only when named, without the name", async () => {
    const got: Incoming[] = [];
    const { t, syncs } = make();
    syncs.push({ next_batch: "s1" });
    syncs.push({
      next_batch: "s2",
      rooms: {
        join: {
          "!team:example.org": room(
            [
              {
                type: "m.room.message",
                sender: "@anna:example.org",
                content: { msgtype: "m.text", body: "lunch?" },
              },
              {
                type: "m.room.message",
                sender: "@anna:example.org",
                content: {
                  msgtype: "m.text",
                  body: "rg: what time is it",
                  "m.mentions": { user_ids: ["@rg:example.org"] },
                },
              },
            ],
            5,
          ),
        },
      },
    });
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 1);
    expect(got[0]?.text).toBe("what time is it");
  });

  it("drops the quoted part of a reply", async () => {
    const got: Incoming[] = [];
    const { t, syncs } = make();
    syncs.push({ next_batch: "s1" });
    syncs.push({
      next_batch: "s2",
      rooms: {
        join: {
          "!dm:example.org": room([
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: {
                msgtype: "m.text",
                body: "> <@rg:example.org> Pick one\n> 1. A\n\n2",
                "m.relates_to": { "m.in_reply_to": { event_id: "$x" } },
              },
            },
          ]),
        },
      },
    });
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 1);
    expect(got[0]?.text).toBe("2");
  });

  it("downloads voice messages and files with the token (authenticated media first)", async () => {
    const got: Incoming[] = [];
    const { t, syncs, calls } = make((c) => {
      if (c.path === "/_matrix/client/v1/media/download/example.org/voice1")
        return new Response("VOICE");
      // An older homeserver: only the v3 path serves this one.
      if (c.path === "/_matrix/client/v1/media/download/example.org/doc1")
        return new Response("no", { status: 404 });
      if (c.path === "/_matrix/media/v3/download/example.org/doc1") return new Response("PDF");
      return undefined;
    });
    syncs.push({ next_batch: "s1" });
    syncs.push({
      next_batch: "s2",
      rooms: {
        join: {
          "!dm:example.org": room([
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: {
                msgtype: "m.audio",
                body: "Voice message",
                url: "mxc://example.org/voice1",
                info: { mimetype: "audio/ogg" },
              },
            },
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: {
                msgtype: "m.file",
                body: "read this",
                filename: "a.pdf",
                url: "mxc://example.org/doc1",
                info: { mimetype: "application/pdf" },
              },
            },
          ]),
        },
      },
    });
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 2);
    expect(got[0]?.audio?.mime).toBe("audio/ogg");
    expect(Buffer.from(got[0]?.audio?.data ?? []).toString()).toBe("VOICE");
    expect(got[1]?.files?.[0]?.name).toBe("a.pdf");
    expect(got[1]?.files?.[0]?.data.toString()).toBe("PDF");
    expect(got[1]?.text).toBe("read this");
    expect(
      calls
        .filter((c) => c.path.includes("/download/"))
        .every((c) => c.auth?.startsWith("Bearer ")),
    ).toBe(true);
  });

  it("tells once per room that an encrypted message cannot be read", async () => {
    const got: Incoming[] = [];
    const { t, syncs } = make();
    syncs.push({ next_batch: "s1" });
    const enc = {
      type: "m.room.encrypted",
      sender: "@anna:example.org",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    };
    syncs.push({ next_batch: "s2", rooms: { join: { "!secret:example.org": room([enc, enc]) } } });
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([
      {
        userId: "@anna:example.org",
        chatId: "!secret:example.org",
        username: "@anna:example.org",
        unreadable: "encrypted",
      },
    ]);
  });

  it("keeps syncing after a failure", async () => {
    let fail = 1;
    const got: Incoming[] = [];
    const { t, syncs } = make((c) => {
      if (c.path === "/_matrix/client/v3/sync" && c.query.get("since") && fail-- > 0)
        return json({ errcode: "M_UNKNOWN" }, 502);
      return undefined;
    });
    syncs.push({ next_batch: "s1" });
    await t.start(async (m) => {
      got.push(m);
    });
    syncs.push({
      next_batch: "s2",
      rooms: {
        join: {
          "!dm:example.org": room([
            {
              type: "m.room.message",
              sender: "@anna:example.org",
              content: { msgtype: "m.text", body: "hi" },
            },
          ]),
        },
      },
    });
    await waitFor(() => got.length === 1);
    expect(got[0]?.text).toBe("hi");
  });

  it("sends, edits with m.replace, uploads files and shows typing", async () => {
    const { t, calls } = make();
    await t.start(async () => {});
    const id = await t.send("!dm:example.org", "Approve?");
    expect(id).toMatch(/^\$e/);
    await t.edit("!dm:example.org", id as string, "Approve?\n\nAllowed");
    await t.sendFile("!dm:example.org", Buffer.from("PNG"), "chart.png", "image/png", "Here it is");
    await t.typing("!dm:example.org");
    const sends = calls.filter((c) => c.path.includes("/send/m.room.message/"));
    expect(sends[0]?.method).toBe("PUT");
    expect(sends[0]?.body).toEqual({ msgtype: "m.text", body: "Approve?" });
    expect(sends[1]?.body).toMatchObject({
      "m.new_content": { msgtype: "m.text", body: "Approve?\n\nAllowed" },
      "m.relates_to": { rel_type: "m.replace", event_id: id },
    });
    // Every event has its own transaction id: none is swallowed as a repeat.
    expect(new Set(sends.map((s) => s.path)).size).toBe(sends.length);
    const up = calls.find((c) => c.path === "/_matrix/media/v3/upload");
    expect(up?.query.get("filename")).toBe("chart.png");
    expect(String(up?.body)).toBe("PNG");
    expect(sends[2]?.body).toEqual({
      msgtype: "m.image",
      body: "Here it is",
      filename: "chart.png",
      url: "mxc://example.org/up1",
      info: { mimetype: "image/png", size: 3 },
    });
    const typing = calls.find((c) => c.path.includes("/typing/"));
    expect(typing?.path).toBe("/_matrix/client/v3/rooms/!dm:example.org/typing/@rg:example.org");
    expect(typing?.body).toEqual({ typing: true, timeout: 6000 });
  });
});
