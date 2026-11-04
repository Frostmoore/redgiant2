import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { WhatsAppTransport } from "../src/whatsapp.js";

const API = "http://graph.test/v21.0";

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fake Graph API: answers by url, records every call. */
function make(handler: (c: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  let next = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
      body:
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : init?.body instanceof FormData
            ? init.body
            : undefined,
    };
    calls.push(c);
    const answer = handler(c);
    if (answer) return answer;
    if (c.url === `${API}/PNID/messages`)
      return Response.json({ messages: [{ id: `wamid.${++next}` }] });
    if (c.url === `${API}/PNID`) return Response.json({ id: "PNID" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const t = new WhatsAppTransport({
    token: "TOKEN",
    phoneNumberId: "PNID",
    appSecret: "SECRET",
    verifyToken: "verify-me",
    apiRoot: `${API}/`,
    fetch: fetchFn,
  });
  return { t, calls };
}

/** The parts of a sent message these tests look at. */
interface Sent {
  type: string;
  interactive: {
    type: string;
    body: { text: string };
    action: {
      button?: string;
      buttons: { reply: { id: string; title: string } }[];
      sections: { rows: { id: string; title: string }[] }[];
    };
  };
}

const sign = (body: string, secret = "SECRET") =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function payload(messages: unknown[]) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ wa_id: "391111", profile: { name: "Ada" } }],
              messages,
            },
          },
        ],
      },
    ],
  });
}

async function started(handler?: (c: Call) => Response | undefined) {
  const f = make(handler);
  const got: Incoming[] = [];
  await f.t.start(async (m) => {
    got.push(m);
  });
  return { ...f, got };
}

describe("WhatsAppTransport", () => {
  it("answers Meta's verification only with the right token", () => {
    const { t } = make();
    const q = { "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" };
    expect(t.verify(q)).toBe("42");
    expect(t.verify({ ...q, "hub.verify_token": "verify-mE" })).toBeUndefined();
    expect(t.verify({ ...q, "hub.verify_token": "short" })).toBeUndefined();
    expect(t.verify({ ...q, "hub.mode": "unsubscribe" })).toBeUndefined();
    expect(t.verify({ "hub.challenge": "42" })).toBeUndefined();
  });

  it("refuses to start with a rejected token", async () => {
    const { t } = make(() => new Response("bad token", { status: 401 }));
    await expect(t.start(async () => {})).rejects.toThrow(/401/);
  });

  it("rejects a webhook with a bad signature and dispatches a good one", async () => {
    const { t, got } = await started();
    const body = payload([{ from: "391111", id: "m1", type: "text", text: { body: "hello" } }]);
    expect(await t.webhook(body, undefined)).toBe(false);
    expect(await t.webhook(body, sign(body, "OTHER"))).toBe(false);
    expect(await t.webhook(body, "sha256=00")).toBe(false);
    expect(got).toEqual([]);
    expect(await t.webhook(body, sign(body))).toBe(true);
    expect(got).toEqual([{ userId: "391111", chatId: "391111", username: "Ada", text: "hello" }]);
    // Delivery statuses carry no messages: accepted, nothing dispatched.
    const status = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] });
    expect(await t.webhook(status, sign(status))).toBe(true);
    expect(got).toHaveLength(1);
  });

  it("turns buttons, list choices, voice notes and images into messages", async () => {
    const { t, got, calls } = await started((c) => {
      if (c.url === `${API}/media-a`)
        return Response.json({ url: "http://cdn.test/a", mime_type: "audio/ogg; codecs=opus" });
      if (c.url === `${API}/media-i`)
        return Response.json({ url: "http://cdn.test/i", mime_type: "image/jpeg" });
      if (c.url === "http://cdn.test/a") return new Response(new Uint8Array([1, 2]));
      if (c.url === "http://cdn.test/i") return new Response(new Uint8Array([7]));
      return undefined;
    });
    const body = payload([
      {
        from: "391111",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "perm:r1:allow", title: "Allow" },
        },
      },
      {
        from: "391111",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "q:r2:0:3", title: "Four" } },
      },
      { from: "391111", type: "audio", audio: { id: "media-a", mime_type: "audio/ogg" } },
      { from: "391111", type: "image", image: { id: "media-i", caption: "look" } },
    ]);
    expect(await t.webhook(body, sign(body))).toBe(true);
    expect(got.map((m) => m.button)).toEqual(["perm:r1:allow", "q:r2:0:3", undefined, undefined]);
    expect(got[2]?.audio?.mime).toBe("audio/ogg; codecs=opus");
    expect([...(got[2]?.audio?.data ?? [])]).toEqual([1, 2]);
    expect(got[3]).toMatchObject({ text: "look", chatId: "391111" });
    expect(got[3]?.files).toEqual([
      { name: "image-media-i.jpg", data: Buffer.from([7]), mime: "image/jpeg" },
    ]);
    // The media url also wants the token.
    expect(calls.find((c) => c.url === "http://cdn.test/a")?.auth).toBe("Bearer TOKEN");
  });

  it("sends plain text, reply buttons or a list depending on the choices", async () => {
    const { t, calls } = make();
    expect(await t.send("391111", "plain")).toBe("wamid.1");
    await t.send("391111", "allow?", [
      { id: "a", label: "Allow" },
      { id: "d", label: "Deny with a very long label indeed" },
    ]);
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `o${i}`,
      label: `Option number ${i} with a long title`,
    }));
    await t.send("391111", "pick", many);
    const sent = calls.filter((c) => c.method === "POST").map((c) => c.body as Sent);
    expect(sent[0]).toMatchObject({
      messaging_product: "whatsapp",
      to: "391111",
      type: "text",
      text: { body: "plain" },
    });
    expect(sent[1]?.type).toBe("interactive");
    expect(sent[1]?.interactive).toEqual({
      type: "button",
      body: { text: "allow?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "a", title: "Allow" } },
          { type: "reply", reply: { id: "d", title: "Deny with a very ..." } },
        ],
      },
    });
    expect(sent[1]?.interactive.action.buttons[1].reply.title).toHaveLength(20);
    expect(sent[2]?.interactive.type).toBe("list");
    expect(sent[2]?.interactive.action.button).toBe("Choose");
    const rows = sent[2]?.interactive.action.sections[0].rows as { id: string; title: string }[];
    expect(rows.map((r) => r.id)).toEqual(["o0", "o1", "o2", "o3", "o4"]);
    expect(rows.every((r) => r.title.length <= 24)).toBe(true);
    expect(calls.every((c) => c.auth === "Bearer TOKEN")).toBe(true);
  });

  it("sends a long text first and the buttons after it", async () => {
    const { t, calls } = make();
    const long = "x".repeat(1500);
    expect(await t.send("391111", long, [{ id: "a", label: "Allow" }])).toBe("wamid.2");
    const sent = calls.map((c) => c.body as Sent);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: "text", text: { body: long } });
    expect(sent[1]?.type).toBe("interactive");
    expect(sent[1]?.interactive.body.text.length).toBeLessThanOrEqual(1024);
  });

  it("uploads a file and sends it as a document or an image", async () => {
    const { t, calls } = make((c) =>
      c.url === `${API}/PNID/media` ? Response.json({ id: "up1" }) : undefined,
    );
    await t.sendFile("391111", Buffer.from("pdf"), "r.pdf", "application/pdf", "report");
    await t.sendFile("391111", Buffer.from("png"), "p.png", "image/png");
    const form = calls[0]?.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect((form.get("file") as File).name).toBe("r.pdf");
    expect(calls[1]?.body).toMatchObject({
      type: "document",
      document: { id: "up1", filename: "r.pdf", caption: "report" },
    });
    expect(calls[3]?.body).toMatchObject({ type: "image", image: { id: "up1" } });
    expect(t.buttons).toBe(true);
    expect(t.platform).toBe("whatsapp");
  });
});
