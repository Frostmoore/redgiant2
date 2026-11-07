import { afterEach, describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { type BbMessage, IMessageTransport } from "../src/imessage.js";

// ---------- A fake BlueBubbles server: its REST API by path, the password in the query ----------

interface Call {
  method: string;
  path: string;
  password: string | null;
  body: unknown;
}

function fakeBlueBubbles(o: { latest?: BbMessage } = {}) {
  const calls: Call[] = [];
  const inbox: BbMessage[] = [];
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      password: url.searchParams.get("password"),
      body: typeof raw === "string" ? JSON.parse(raw) : raw instanceof FormData ? raw : undefined,
    };
    calls.push(c);
    if (c.password !== "bb-pass")
      return Response.json({ status: 401, message: "Unauthorized" }, { status: 401 });
    if (c.path === "/api/v1/ping") return Response.json({ status: 200, message: "pong" });
    if (c.path === "/api/v1/message/query") {
      const q = c.body as { after?: number; sort?: string; limit?: number };
      if (q.sort === "DESC") return Response.json({ data: o.latest ? [o.latest] : [] });
      // BlueBubbles' `after` is inclusive enough to send the last one again: we must not repeat it.
      return Response.json({
        data: inbox.filter((m) => (m.dateCreated ?? 0) >= (q.after ?? 0)),
      });
    }
    if (c.path === "/api/v1/attachment/att-voice/download")
      return new Response("CAFDATA", { headers: { "content-type": "audio/x-caf" } });
    if (c.path === "/api/v1/attachment/att-pic/download") return new Response("JPEG");
    if (c.path === "/api/v1/message/text" || c.path === "/api/v1/message/attachment") {
      n += 1;
      return Response.json({ status: 200, data: { guid: `sent-${n}` } });
    }
    if (c.path.endsWith("/edit") || c.path.endsWith("/typing"))
      return Response.json({ status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, inbox, fetch: fetchFn };
}

const DM = "iMessage;-;+393331112222";
const message = (guid: string, at: number, extra: Partial<BbMessage> = {}): BbMessage => ({
  guid,
  text: "hello",
  isFromMe: false,
  dateCreated: at,
  handle: { address: "+393331112222" },
  chats: [{ guid: DM }],
  attachments: [],
  ...extra,
});

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const transports: IMessageTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.stop();
});

function make(o: { password?: string; privateApi?: "on" | "off"; latest?: BbMessage } = {}) {
  const f = fakeBlueBubbles(o);
  const t = new IMessageTransport({
    url: "http://mac.local:1234/",
    password: o.password ?? "bb-pass",
    privateApi: o.privateApi,
    fetch: f.fetch,
    pollMs: 5,
  });
  transports.push(t);
  return { t, ...f };
}

describe("IMessageTransport", () => {
  it("refuses to start with a wrong password", async () => {
    const { t } = make({ password: "nope" });
    await expect(t.start(async () => {})).rejects.toThrow(/401/);
  });

  it("starts after the newest message and relays each new one once", async () => {
    const got: Incoming[] = [];
    const { t, inbox } = make({ latest: message("old", 1000, { text: "before" }) });
    inbox.push(message("old", 1000, { text: "before" }));
    await t.start(async (m) => {
      got.push(m);
    });
    inbox.push(message("m1", 2000, { text: "/start 123456" }));
    // What the Mac itself sent (our answers) and tapbacks are not for us.
    inbox.push(message("m2", 2100, { isFromMe: true, text: "answer" }));
    inbox.push(message("m3", 2200, { associatedMessageGuid: "m1", text: "Loved" }));
    await waitFor(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual([
      { userId: "+393331112222", chatId: DM, username: "+393331112222", text: "/start 123456" },
    ]);
  });

  it("in a group answers only messages naming RedGiant", async () => {
    const got: Incoming[] = [];
    const { t, inbox } = make();
    await t.start(async (m) => {
      got.push(m);
    });
    const group = { chats: [{ guid: "iMessage;+;chat42" }] };
    inbox.push(message("g1", Date.now() + 10, { ...group, text: "dinner at 8?" }));
    inbox.push(message("g2", Date.now() + 20, { ...group, text: "RedGiant, what's the weather" }));
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ chatId: "iMessage;+;chat42", text: "what's the weather" });
  });

  it("downloads voice messages and pictures", async () => {
    const got: Incoming[] = [];
    const { t, inbox } = make();
    await t.start(async (m) => {
      got.push(m);
    });
    inbox.push(
      message("v1", Date.now() + 10, {
        text: "￼",
        attachments: [
          { guid: "att-voice", mimeType: null, transferName: "Audio Message.caf" },
          { guid: "att-pic", mimeType: "image/jpeg", transferName: "IMG_1.jpeg" },
        ],
      }),
    );
    await waitFor(() => got.length === 1);
    expect(got[0]?.text).toBeUndefined();
    expect(got[0]?.audio?.mime).toBe("audio/x-caf");
    expect(Buffer.from(got[0]?.audio?.data ?? []).toString()).toBe("CAFDATA");
    expect(got[0]?.files?.map((f) => [f.name, f.mime, f.data.toString()])).toEqual([
      ["IMG_1.jpeg", "image/jpeg", "JPEG"],
    ]);
  });

  it("sends through AppleScript: no edits and no typing without the Private API", async () => {
    const { t, calls } = make();
    await t.start(async () => {});
    expect(t.edit).toBeUndefined();
    expect(t.typing).toBeUndefined();
    expect(await t.send(DM, "hi")).toBeUndefined();
    await t.sendFile(DM, Buffer.from("PDF"), "a.pdf", "application/pdf", "the file");
    const text = calls.find((c) => c.path === "/api/v1/message/text");
    expect(text?.body).toMatchObject({ chatGuid: DM, message: "hi", method: "apple-script" });
    expect((text?.body as { tempGuid: string } | undefined)?.tempGuid).toMatch(/^[0-9a-f-]{36}$/);
    const file = calls.find((c) => c.path === "/api/v1/message/attachment")?.body as FormData;
    expect(file.get("chatGuid")).toBe(DM);
    expect(file.get("name")).toBe("a.pdf");
    expect(await (file.get("attachment") as Blob).text()).toBe("PDF");
    expect(calls.filter((c) => c.path === "/api/v1/message/text").at(-1)?.body).toMatchObject({
      message: "the file",
    });
    expect(calls.every((c) => c.password === "bb-pass")).toBe(true);
  });

  it("with the Private API edits and shows typing", async () => {
    const { t, calls } = make({ privateApi: "on" });
    await t.start(async () => {});
    const id = await t.send(DM, "Approve?");
    expect(id).toBe("sent-1");
    await t.edit?.(DM, id as string, "Approve?\n\nAllowed");
    await t.typing?.(DM);
    expect(calls.find((c) => c.path === "/api/v1/message/text")?.body).toMatchObject({
      method: "private-api",
    });
    expect(calls.find((c) => c.path === "/api/v1/message/sent-1/edit")?.body).toMatchObject({
      editedMessage: "Approve?\n\nAllowed",
    });
    expect(calls.some((c) => c.path === `/api/v1/chat/${DM}/typing`)).toBe(true);
  });
});
