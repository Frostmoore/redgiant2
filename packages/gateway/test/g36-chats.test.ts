// G36.9: the new platforms through the real bridge, their APIs simulated end to end.
import { EventEmitter } from "node:events";
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { ChatBridge, type GatewayHost, type Incoming, MatrixTransport } from "../src/index.js";
import { memoryDb } from "./pglite.js";

function fakeHost(lang: "it" | "en") {
  const approvals = new EventEmitter();
  const decided: [string, string][] = [];
  const asked: string[] = [];
  const heardIn: (string | undefined)[] = [];
  const chatMessages: { platform: string; text: string }[] = [];
  const host: GatewayHost = {
    async askDemigod(_o, _c, text) {
      asked.push(text);
      return `Risposta: ${text}`;
    },
    async chatMessage(_o, m) {
      chatMessages.push({ platform: m.platform, text: m.text });
      return { taken: m.text.includes("spesa"), names: ["lista-spesa"] };
    },
    transcription: {},
    async transcribe(_a, _m, language) {
      heardIn.push(language);
      return "ciao dal vocale";
    },
    approvals: {
      on: (e: string, l: (...a: never[]) => void) => approvals.on(e, l),
      decide(_o, id, d) {
        decided.push([id, d]);
        approvals.emit("closed", "me", id, d);
        return true;
      },
    },
    language: () => lang,
  };
  return { host, approvals, decided, asked, heardIn, chatMessages };
}

/** A homeserver whose /sync hands out what the test queues. */
function homeserver() {
  const syncs: unknown[] = [{ next_batch: "s0" }];
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/whoami")) return Response.json({ user_id: "@rg:hs.test" });
    if (path.endsWith("/sync")) {
      const next = syncs.shift();
      if (next) return Response.json(next);
      await new Promise((r) => setTimeout(r, 5));
      return Response.json({ next_batch: `s${++n}` });
    }
    if (path.includes("/media/download/")) return new Response("OGG");
    if (path.includes("/send/")) {
      sent.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json({ event_id: `$ev${sent.length}` });
    }
    return Response.json({});
  }) as typeof fetch;
  const say = (content: Record<string, unknown>, type = "m.room.message") =>
    syncs.push({
      next_batch: `q${syncs.length}${Date.now()}`,
      rooms: {
        join: {
          "!dm:hs.test": {
            summary: { "m.joined_member_count": 2 },
            timeline: { events: [{ type, sender: "@marta:hs.test", content }] },
          },
        },
      },
    });
  return { fetch: fetchFn, say, sent, texts: () => sent.map((s) => String(s.body.body)) };
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const perm: PermissionRequestInfo = {
  requestId: "r1",
  agentId: "a",
  agentName: "Coder",
  projectId: null,
  tool: "bash",
  input: { command: "ls" },
  reasons: ["runs a command"],
  danger: [],
  createdAt: new Date().toISOString(),
};

describe("Matrix through the bridge", () => {
  it("pairs, relays, transcribes in the agents' language, asks approvals by number", async () => {
    const { db } = await memoryDb();
    const hs = homeserver();
    const h = fakeHost("it");
    const transport = new MatrixTransport({
      homeserver: "https://hs.test",
      accessToken: "syt_token_long_enough",
      fetch: hs.fetch,
      syncTimeoutMs: 5,
      retryMs: 5,
    });
    const bridge = new ChatBridge({ db, host: h.host, transport });
    await bridge.start();
    try {
      const { code } = bridge.pairingCode("me");
      hs.say({ msgtype: "m.text", body: `/start ${code}` });
      await waitFor(() => hs.sent.length === 1);
      expect(hs.texts()[0]).toBe("Collegato. Scrivimi e lo passo a God.");
      expect((await bridge.links("me"))[0]).toMatchObject({
        platform: "matrix",
        userId: "@marta:hs.test",
        chatId: "!dm:hs.test",
      });

      hs.say({ msgtype: "m.text", body: "quanto fa 2+2" });
      await waitFor(() => hs.texts().includes("Risposta: quanto fa 2+2"));
      // The automations saw it first (G33.3), under Matrix's name.
      expect(h.chatMessages[0]).toEqual({ platform: "matrix", text: "quanto fa 2+2" });

      hs.say({ msgtype: "m.text", body: "aggiungi latte alla spesa" });
      await waitFor(() => hs.texts().includes("Lo passo all'automazione: lista-spesa."));

      hs.say({
        msgtype: "m.audio",
        body: "voice",
        url: "mxc://hs.test/v1",
        info: { mimetype: "audio/ogg" },
      });
      await waitFor(() => hs.texts().includes("Risposta: ciao dal vocale"));
      expect(h.heardIn).toEqual(["it"]);

      h.approvals.emit("request", "me", perm);
      await waitFor(() => hs.texts().some((t) => t.startsWith("Serve un'approvazione")));
      const ask = hs.texts().find((t) => t.startsWith("Serve un'approvazione")) as string;
      expect(ask).toContain("1. Consenti\n2. Nega");
      hs.say({ msgtype: "m.text", body: "1" });
      await waitFor(() => h.decided.length === 1);
      expect(h.decided).toEqual([["r1", "allow"]]);
      // The question is closed by editing it (m.replace), not by a new message.
      await waitFor(() => hs.sent.some((s) => s.body["m.relates_to"] !== undefined));
      const edit = hs.sent.find((s) => s.body["m.relates_to"]);
      expect(String((edit?.body["m.new_content"] as { body: string } | undefined)?.body)).toMatch(
        /Consentito$/,
      );

      // Results delivered to the person (notify) reach the linked room.
      await bridge.notify("me", "Fatto: il rapporto è pronto.");
      expect(hs.texts().at(-1)).toBe("Fatto: il rapporto è pronto.");

      hs.say({ algorithm: "m.megolm.v1.aes-sha2" }, "m.room.encrypted");
      await waitFor(() => hs.texts().some((t) => t.startsWith("Questa stanza è cifrata")));
    } finally {
      await bridge.stop();
    }
  });
});

describe("unreadable messages", () => {
  it("are explained, even before pairing, and never relayed", async () => {
    const { db } = await memoryDb();
    const h = fakeHost("en");
    const sent: string[] = [];
    let on: ((m: Incoming) => Promise<void>) | undefined;
    const bridge = new ChatBridge({
      db,
      host: h.host,
      transport: {
        platform: "matrix",
        buttons: false,
        maxLength: 1000,
        async start(o) {
          on = o;
        },
        async stop() {},
        async send(_c, text) {
          sent.push(text);
          return undefined;
        },
      },
    });
    await bridge.start();
    await on?.({ userId: "@x:hs", chatId: "!r", unreadable: "encrypted" });
    expect(sent[0]).toMatch(/^This room is end-to-end encrypted/);
    expect(h.asked).toEqual([]);
  });
});
