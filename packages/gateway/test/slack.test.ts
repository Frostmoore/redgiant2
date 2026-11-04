import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { SlackTransport } from "../src/slack.js";

// ---------- A fake Slack: the Web API over node:http, the socket as an injected class ----------

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((e: { data?: string }) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  addEventListener(type: string, l: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.fire("close", {}));
  }

  /** Slack sends an envelope. */
  push(env: unknown) {
    this.fire("message", { data: JSON.stringify(env) });
  }

  private fire(type: string, e: { data?: string }) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
}

interface Call {
  method: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
let root: string;
let calls: Call[];
let botToken: string;
let rateLimitOnce: string | undefined;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeEach(async () => {
  FakeSocket.all = [];
  calls = [];
  botToken = "xoxb-good";
  rateLimitOnce = undefined;
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = req.url ?? "";
    const auth = req.headers.authorization;
    if (url.startsWith("/files/")) {
      res.writeHead(auth === `Bearer ${botToken}` ? 200 : 403);
      res.end(url.endsWith("voice.m4a") ? "VOICE" : "DATA");
      return;
    }
    if (url === "/upload") {
      calls.push({ method: "upload", auth, body: { data: raw.toString() } });
      res.end("OK");
      return;
    }
    const method = url.replace(/^\/api\//, "");
    const body =
      req.headers["content-type"]?.startsWith("application/json") && raw.length
        ? JSON.parse(raw.toString())
        : Object.fromEntries(new URLSearchParams(raw.toString()));
    calls.push({ method, auth, body });
    if (rateLimitOnce === method) {
      rateLimitOnce = undefined;
      res.writeHead(429, { "retry-after": "0" });
      res.end();
      return;
    }
    const reply = (data: Record<string, unknown>) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
    };
    if (method === "auth.test")
      return reply(
        auth === "Bearer xoxb-good"
          ? { ok: true, user_id: "UBOT" }
          : { ok: false, error: "invalid_auth" },
      );
    if (method === "apps.connections.open")
      return reply(
        auth === "Bearer xapp-good"
          ? { ok: true, url: `wss://fake/${FakeSocket.all.length}` }
          : { ok: false, error: "invalid_auth" },
      );
    if (method === "chat.postMessage") return reply({ ok: true, ts: "1700000000.000100" });
    if (method === "chat.update") return reply({ ok: true });
    if (method === "files.getUploadURLExternal")
      return reply({ ok: true, upload_url: `${root}/upload`, file_id: "F1" });
    if (method === "files.completeUploadExternal") return reply({ ok: true });
    reply({ ok: false, error: "unknown_method" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await wait(5);
  expect(check()).toBe(true);
}

function transport(o: { bot?: string; app?: string } = {}) {
  return new SlackTransport({
    botToken: o.bot ?? "xoxb-good",
    appToken: o.app ?? "xapp-good",
    apiRoot: `${root}/api`,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    reconnectDelayMs: 10,
  });
}

/** Starts a transport and says hello on its socket; returns what it received. */
async function started(t = transport()) {
  const got: Incoming[] = [];
  const start = t.start(async (m) => {
    got.push(m);
  });
  await until(() => FakeSocket.all.length === 1);
  const socket = FakeSocket.all[0] as FakeSocket;
  socket.push({ type: "hello" });
  await start;
  return { t, got, socket };
}

let n = 0;
function event(ev: Record<string, unknown>) {
  n++;
  return {
    type: "events_api",
    envelope_id: `env-${n}`,
    payload: { event: { ts: `17000000${n}.0001`, ...ev } },
  };
}

describe("SlackTransport", () => {
  it("starts once Slack says hello, with the app token opening the socket", async () => {
    const t = transport();
    let done = false;
    const start = t
      .start(async () => {})
      .then(() => {
        done = true;
      });
    await until(() => FakeSocket.all.length === 1);
    await wait();
    expect(done).toBe(false);
    (FakeSocket.all[0] as FakeSocket).push({ type: "hello" });
    await start;
    expect(done).toBe(true);
    expect(calls.map((c) => [c.method, c.auth])).toEqual([
      ["auth.test", "Bearer xoxb-good"],
      ["apps.connections.open", "Bearer xapp-good"],
    ]);
    expect((FakeSocket.all[0] as FakeSocket).url).toBe("wss://fake/0");
    await t.stop();
  });

  it("fails to start on a bad token", async () => {
    await expect(transport({ bot: "xoxb-bad" }).start(async () => {})).rejects.toThrow(
      /invalid_auth/,
    );
    await expect(transport({ app: "xapp-bad" }).start(async () => {})).rejects.toThrow(
      /invalid_auth/,
    );
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("acknowledges every envelope and turns a DM into text", async () => {
    const { t, got, socket } = await started();
    socket.push(
      event({ type: "message", channel_type: "im", user: "U1", channel: "D1", text: "hi" }),
    );
    await until(() => got.length === 1);
    expect(socket.sent).toEqual([{ envelope_id: `env-${n}` }]);
    expect(got[0]).toEqual({ userId: "U1", chatId: "D1", text: "hi" });
    await t.stop();
  });

  it("ignores channel messages without a mention, bots and its own messages", async () => {
    const { t, got, socket } = await started();
    const base = { type: "message", channel_type: "channel", channel: "C1" };
    socket.push(event({ ...base, user: "U1", text: "talking among people" }));
    socket.push(event({ ...base, user: "U1", bot_id: "B9", text: "<@UBOT> from a bot" }));
    socket.push(event({ ...base, user: "UBOT", text: "<@UBOT> myself" }));
    socket.push(event({ ...base, user: "U1", subtype: "message_changed", text: "<@UBOT> x" }));
    await wait();
    expect(got).toEqual([]);
    expect(socket.sent).toHaveLength(4);
    socket.push(event({ ...base, user: "U1", text: "<@UBOT> what's up?" }));
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ userId: "U1", chatId: "C1", text: "what's up?" });
    await t.stop();
  });

  it("handles app_mention once, even when the message event comes too", async () => {
    const { t, got, socket } = await started();
    const ev = { channel: "C1", user: "U1", text: "<@UBOT|redgiant> status", ts: "1.2" };
    socket.push(event({ type: "app_mention", ...ev }));
    socket.push(event({ type: "message", channel_type: "channel", ...ev }));
    await wait();
    expect(got).toEqual([{ userId: "U1", chatId: "C1", text: "status" }]);
    await t.stop();
  });

  it("downloads shared files with the bot token: audio apart, the rest as files", async () => {
    const { t, got, socket } = await started();
    socket.push(
      event({
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        text: "",
        files: [
          {
            name: "voice.m4a",
            mimetype: "audio/mp4",
            url_private_download: `${root}/files/voice.m4a`,
          },
          { name: "a.txt", mimetype: "text/plain", url_private_download: `${root}/files/a.txt` },
        ],
      }),
    );
    await until(() => got.length === 1);
    const m = got[0] as Incoming;
    expect(Buffer.from(m.audio?.data ?? []).toString()).toBe("VOICE");
    expect(m.audio?.mime).toBe("audio/mp4");
    expect(m.files?.map((f) => [f.name, f.mime, f.data.toString()])).toEqual([
      ["a.txt", "text/plain", "DATA"],
    ]);
    expect(m.text).toBeUndefined();
    await t.stop();
  });

  it("turns a block_actions click into a button", async () => {
    const { t, got, socket } = await started();
    socket.push({
      type: "interactive",
      envelope_id: "env-click",
      payload: {
        type: "block_actions",
        user: { id: "U1", username: "ada" },
        channel: { id: "C1" },
        actions: [{ action_id: "perm:r1:allow", value: "perm:r1:allow" }],
      },
    });
    await until(() => got.length === 1);
    expect(socket.sent).toEqual([{ envelope_id: "env-click" }]);
    expect(got[0]).toEqual({
      userId: "U1",
      chatId: "C1",
      username: "ada",
      button: "perm:r1:allow",
    });
    await t.stop();
  });

  it("sends buttons as blocks and returns the ts; edit drops them", async () => {
    const { t } = await started();
    const long = `${"a".repeat(2500)}\n\n${"b".repeat(1000)} <x> & y`;
    const ts = await t.send("C1", long, [
      { id: "perm:r1:allow", label: "Allow" },
      { id: "perm:r1:deny", label: "D".repeat(100) },
    ]);
    expect(ts).toBe("1700000000.000100");
    const post = calls.find((c) => c.method === "chat.postMessage") as Call;
    expect(post.auth).toBe("Bearer xoxb-good");
    const blocks = post.body.blocks as {
      type: string;
      text?: { type: string; text: string };
      elements?: Record<string, unknown>[];
    }[];
    expect(blocks.map((b) => b.type)).toEqual(["section", "section", "actions"]);
    expect(blocks[0]?.text).toEqual({ type: "mrkdwn", text: "a".repeat(2500) });
    expect(blocks[1]?.text?.text).toBe(`${"b".repeat(1000)} &lt;x&gt; &amp; y`);
    expect(blocks[2]?.elements).toEqual([
      {
        type: "button",
        action_id: "perm:r1:allow",
        value: "perm:r1:allow",
        text: { type: "plain_text", text: "Allow" },
        style: "primary",
      },
      {
        type: "button",
        action_id: "perm:r1:deny",
        value: "perm:r1:deny",
        text: { type: "plain_text", text: "D".repeat(75) },
      },
    ]);

    await t.edit("C1", "1700000000.000100", "Allowed");
    const update = calls.find((c) => c.method === "chat.update") as Call;
    expect(update.body).toEqual({
      channel: "C1",
      ts: "1700000000.000100",
      text: "Allowed",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Allowed" } }],
    });
    await t.stop();
  });

  it("sends plain text without blocks and waits out a 429 once", async () => {
    const { t } = await started();
    rateLimitOnce = "chat.postMessage";
    await t.send("C1", "hello");
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ channel: "C1", text: "hello" });
    await t.stop();
  });

  it("uploads a file in three steps", async () => {
    const { t } = await started();
    await t.sendFile("C1", Buffer.from("report"), "r.txt", "text/plain", "Here it is");
    expect(calls.slice(2).map((c) => c.method)).toEqual([
      "files.getUploadURLExternal",
      "upload",
      "files.completeUploadExternal",
    ]);
    expect(calls[2]?.body).toEqual({ filename: "r.txt", length: "6" });
    expect(calls[3]?.body).toEqual({ data: "report" });
    expect(calls[4]?.body).toEqual({
      files: JSON.stringify([{ id: "F1", title: "r.txt" }]),
      channel_id: "C1",
      initial_comment: "Here it is",
    });
    await t.stop();
  });

  it("opens a new connection on disconnect and keeps receiving", async () => {
    const { t, got, socket } = await started();
    socket.push({ type: "disconnect", reason: "refresh_requested" });
    await until(() => FakeSocket.all.length === 2);
    expect(socket.closed).toBe(true);
    const next = FakeSocket.all[1] as FakeSocket;
    next.push({ type: "hello" });
    next.push(
      event({ type: "message", channel_type: "im", user: "U1", channel: "D1", text: "again" }),
    );
    await until(() => got.length === 1);
    expect(got[0]?.text).toBe("again");
    expect(calls.filter((c) => c.method === "apps.connections.open")).toHaveLength(2);
    await t.stop();
    expect(next.closed).toBe(true);
  });

  it("reopens a socket that drops, but not after stop", async () => {
    const { t, socket } = await started();
    socket.close();
    await until(() => FakeSocket.all.length === 2);
    (FakeSocket.all[1] as FakeSocket).push({ type: "hello" });
    await t.stop();
    await wait(50);
    expect(FakeSocket.all).toHaveLength(2);
  });
});
