import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import type { Incoming } from "../src/bridge.js";
import { DiscordTransport } from "../src/discord.js";

// A fake Discord on one local port: REST under /api/v10, the gateway as a WebSocket, files under /cdn.

interface Request {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Fake {
  base: string;
  requests: Request[];
  /** Gateway payloads received, in order, with the connection's index. */
  frames: { conn: number; op: number; d: unknown }[];
  connections: ServerSocket[];
  /** Overrides a REST answer: return [status, body] or undefined for the default. */
  answer?: (r: Request) => [number, unknown] | undefined;
  /** Sends a dispatch to the newest connection. */
  dispatch(t: string, d: unknown): void;
  close(): Promise<void>;
}

let seq = 1;

async function fakeDiscord(opts: { closeOnIdentify?: number } = {}): Promise<Fake> {
  const fake = { requests: [], frames: [], connections: [] } as unknown as Fake;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r: Request = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("latin1"),
      };
      fake.requests.push(r);
      const reply = (status: number, body?: unknown) => {
        if (body === undefined) {
          res.writeHead(status).end();
          return;
        }
        if (body instanceof Buffer) {
          res.writeHead(status, { "content-type": "application/octet-stream" }).end(body);
          return;
        }
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      const custom = fake.answer?.(r);
      if (custom) return reply(...custom);
      if (r.path === "/api/v10/gateway/bot") return reply(200, { url: `${wsBase}/gw` });
      if (r.path.startsWith("/cdn/")) return reply(200, Buffer.from(`bytes of ${r.path}`));
      if (r.path.includes("/callback")) return reply(204);
      if (r.method === "POST" && r.path.endsWith("/messages")) return reply(200, { id: "msg-1" });
      if (r.method === "POST" && r.path.endsWith("/typing")) return reply(204);
      if (r.method === "PATCH") return reply(200, { id: "msg-1" });
      reply(404, { message: "unknown" });
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    const conn = fake.connections.length;
    fake.connections.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw)) as { op: number; d: unknown };
      fake.frames.push({ conn, op: p.op, d: p.d });
      if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (p.op === 2) {
        if (opts.closeOnIdentify) {
          ws.close(opts.closeOnIdentify, "nope");
          return;
        }
        ws.send(JSON.stringify({ op: 0, t: "READY", s: seq++, d: { user: { id: "bot1" } } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const wsBase = `ws://127.0.0.1:${port}`;
  fake.base = `http://127.0.0.1:${port}`;
  fake.dispatch = (t, d) =>
    fake.connections.at(-1)?.send(JSON.stringify({ op: 0, t, s: seq++, d }));
  fake.close = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  };
  return fake;
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("DiscordTransport", () => {
  let fake: Fake;
  let transport: DiscordTransport | undefined;
  let got: Incoming[];

  const make = (extra: { gateway?: boolean } = {}) => {
    transport = new DiscordTransport({
      token: "tok",
      apiRoot: `${fake.base}/api/v10`,
      reconnectMs: 10,
      ...(extra.gateway && { gatewayUrl: `${fake.base.replace("http", "ws")}/gw` }),
    });
    return transport;
  };
  const start = async () => {
    await make().start(async (m) => {
      got.push(m);
    });
    return transport as DiscordTransport;
  };

  beforeEach(async () => {
    fake = await fakeDiscord();
    got = [];
  });
  afterEach(async () => {
    await transport?.stop();
    transport = undefined;
    await fake.close();
  });

  it("resolves start on READY after identifying with the right intents", async () => {
    await start();
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/v10/gateway/bot" });
    expect(fake.requests[0]?.headers.authorization).toBe("Bot tok");
    const identify = fake.frames.find((f) => f.op === 2);
    expect(identify?.d).toMatchObject({ token: "tok", intents: (1 << 9) | (1 << 12) | (1 << 15) });
  });

  it("rejects start on an invalid token", async () => {
    fake.answer = (r) => (r.path.endsWith("/gateway/bot") ? [401, { message: "401" }] : undefined);
    await expect(start()).rejects.toThrow(/401/);
    await fake.close();
    fake = await fakeDiscord({ closeOnIdentify: 4004 });
    await expect(make({ gateway: true }).start(async () => {})).rejects.toThrow(/token/);
  });

  it("sends heartbeats with the last sequence", async () => {
    await start();
    await waitFor(() => fake.frames.filter((f) => f.op === 1).length >= 2);
    expect(typeof fake.frames.find((f) => f.op === 1)?.d).toBe("number");
  });

  it("turns a DM into an Incoming, with a voice note as audio and other files as files", async () => {
    await start();
    fake.dispatch("MESSAGE_CREATE", {
      channel_id: "dm1",
      author: { id: "u1", username: "anna" },
      content: " hello ",
      mentions: [],
    });
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ userId: "u1", chatId: "dm1", username: "anna", text: "hello" });

    fake.dispatch("MESSAGE_CREATE", {
      channel_id: "dm1",
      author: { id: "u1", username: "anna" },
      content: "",
      flags: 8192,
      attachments: [
        {
          url: `${fake.base}/cdn/voice.ogg`,
          filename: "voice-message.ogg",
          content_type: "audio/ogg",
        },
        { url: `${fake.base}/cdn/a.pdf`, filename: "a.pdf", content_type: "application/pdf" },
      ],
    });
    await waitFor(() => got.length === 2);
    const m = got[1] as Incoming;
    expect(m.audio?.mime).toBe("audio/ogg");
    expect(Buffer.from(m.audio?.data ?? []).toString()).toBe("bytes of /cdn/voice.ogg");
    expect(m.files).toEqual([
      { name: "a.pdf", mime: "application/pdf", data: Buffer.from("bytes of /cdn/a.pdf") },
    ]);
    // The CDN download carries no bot token.
    const cdn = fake.requests.find((r) => r.path === "/cdn/voice.ogg");
    expect(cdn?.headers.authorization).toBeUndefined();
  });

  it("ignores guild messages without a mention and bots, strips the mention otherwise", async () => {
    await start();
    fake.dispatch("MESSAGE_CREATE", {
      channel_id: "g-chan",
      guild_id: "g1",
      author: { id: "u1", username: "anna" },
      content: "talking among humans",
      mentions: [],
    });
    fake.dispatch("MESSAGE_CREATE", {
      channel_id: "dm1",
      author: { id: "b2", username: "other bot", bot: true },
      content: "beep",
    });
    fake.dispatch("MESSAGE_CREATE", {
      channel_id: "g-chan",
      guild_id: "g1",
      author: { id: "u1", username: "anna" },
      content: "<@bot1> /status",
      mentions: [{ id: "bot1" }],
    });
    await waitFor(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([{ userId: "u1", chatId: "g-chan", username: "anna", text: "/status" }]);
  });

  it("turns a button press into `button` and acknowledges it", async () => {
    await start();
    fake.dispatch("INTERACTION_CREATE", {
      id: "i1",
      token: "itok",
      type: 3,
      channel_id: "c1",
      member: { user: { id: "u1", username: "anna" } },
      data: { custom_id: "perm:r1:allow" },
    });
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({
      userId: "u1",
      chatId: "c1",
      username: "anna",
      button: "perm:r1:allow",
    });
    const ack = fake.requests.find((r) => r.path === "/api/v10/interactions/i1/itok/callback");
    expect(ack?.method).toBe("POST");
    expect(JSON.parse(ack?.body ?? "{}")).toEqual({ type: 6 });
  });

  it("sends with buttons in action rows and returns the message id", async () => {
    const t = make({ gateway: true });
    const buttons = Array.from({ length: 7 }, (_, i) => ({
      id: `b${i}`,
      label: i === 0 ? "x".repeat(100) : `B${i}`,
    }));
    expect(await t.send("c1", "pick", buttons)).toBe("msg-1");
    const r = fake.requests.at(-1) as Request;
    expect(r).toMatchObject({ method: "POST", path: "/api/v10/channels/c1/messages" });
    expect(r.headers.authorization).toBe("Bot tok");
    const body = JSON.parse(r.body);
    expect(body.content).toBe("pick");
    expect(body.components).toHaveLength(2);
    expect(body.components[0].components).toHaveLength(5);
    expect(body.components[1].components).toHaveLength(2);
    expect(body.components[0].components[0]).toEqual({
      type: 2,
      style: 1,
      custom_id: "b0",
      label: "x".repeat(80),
    });
    expect(body.components[1].components[1]).toMatchObject({ style: 2, custom_id: "b6" });

    await t.send("c1", "plain");
    expect(JSON.parse((fake.requests.at(-1) as Request).body)).toEqual({ content: "plain" });
  });

  it("edits with no components, types, and sends files as multipart", async () => {
    const t = make({ gateway: true });
    await t.edit("c1", "m9", "done");
    const r = fake.requests.at(-1) as Request;
    expect(r).toMatchObject({ method: "PATCH", path: "/api/v10/channels/c1/messages/m9" });
    expect(JSON.parse(r.body)).toEqual({ content: "done", components: [] });

    await t.typing("c1");
    expect(fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v10/channels/c1/typing",
    });

    await t.sendFile("c1", Buffer.from("report"), "r.txt", "text/plain", "here");
    const f = fake.requests.at(-1) as Request;
    expect(f.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(f.body).toContain('name="files[0]"; filename="r.txt"');
    expect(f.body).toContain("report");
    expect(f.body).toContain('"content":"here"');
  });

  it("retries once after a 429", async () => {
    let limited = 0;
    fake.answer = (r) =>
      r.path.endsWith("/typing") && limited++ < 1 ? [429, { retry_after: 0.01 }] : undefined;
    await make({ gateway: true }).typing("c1");
    expect(fake.requests.filter((r) => r.path.endsWith("/typing"))).toHaveLength(2);
  });

  it("reconnects after a drop and stops reconnecting once stopped", async () => {
    const t = await start();
    fake.connections[0]?.close(1001);
    await waitFor(() => fake.frames.some((f) => f.conn === 1 && f.op === 2));
    await t.stop();
    await waitFor(() => fake.connections[1]?.readyState === 3);
    fake.connections[1]?.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.connections).toHaveLength(2);
  });
});
