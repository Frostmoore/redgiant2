// Discord transport for the chat bridge (G29.5). REST for what leaves, a minimal Gateway
// connection for what arrives: HELLO, heartbeats, IDENTIFY, READY and two dispatches. No library:
// Node's own fetch and WebSocket are enough, and RESUME is not worth it for a chat bot (a fresh
// IDENTIFY after a drop only loses what was said in the gap).

import type { Button, Incoming, Transport } from "./bridge.js";

export interface DiscordOptions {
  /** The bot token (Developer Portal, Bot tab). */
  token: string;
  /** Default https://discord.com/api/v10. */
  apiRoot?: string;
  /** Skips GET /gateway/bot (tests, proxies). */
  gatewayUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** The first reconnect waits this long, doubling up to 30 s (default 1 s). */
  reconnectMs?: number;
}

// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (the last must be enabled in the portal).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const VOICE_MESSAGE = 1 << 13;
const BUTTON_PRESS = 3;
const DEFERRED_UPDATE_MESSAGE = 6;
/** Close codes after which reconnecting cannot help: bad token, intents not allowed, and so on. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

interface User {
  id: string;
  username?: string;
  bot?: boolean;
}

interface Attachment {
  url: string;
  filename: string;
  content_type?: string;
}

interface Message {
  channel_id: string;
  guild_id?: string;
  author?: User;
  content?: string;
  flags?: number;
  mentions?: User[];
  attachments?: Attachment[];
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  member?: { user?: User };
  user?: User;
  data?: { custom_id?: string };
}

interface Payload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class DiscordTransport implements Transport {
  readonly platform = "discord" as const;
  readonly buttons = true;
  readonly maxLength = 2000;

  private readonly api: string;
  private readonly fetch: typeof fetch;
  private readonly WS: typeof WebSocket;
  private on?: (m: Incoming) => Promise<void>;
  private ws: WebSocket | undefined;
  private url?: string;
  private botId?: string;
  private seq: number | null = null;
  private acked = true;
  private beat: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private attempts = 0;
  private stopped = false;
  private waiting: { resolve: () => void; reject: (e: Error) => void } | undefined;
  /** Messages reach the bridge in the order Discord sent them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: DiscordOptions) {
    this.api = (o.apiRoot ?? "https://discord.com/api/v10").replace(/\/$/, "");
    this.fetch = o.fetch ?? globalThis.fetch;
    this.WS = o.WebSocket ?? globalThis.WebSocket;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    this.on = on;
    this.stopped = false;
    this.url =
      this.o.gatewayUrl ?? ((await this.rest("GET", "/gateway/bot")) as { url: string }).url;
    await new Promise<void>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.connect();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopBeat();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.ws?.close(1000);
    this.ws = undefined;
    this.waiting?.reject(new Error("Discord transport stopped"));
    this.waiting = undefined;
    await this.queue;
  }

  // ---------- Gateway ----------

  private connect() {
    const sep = this.url?.includes("?") ? "&" : "?";
    const ws = new this.WS(`${this.url}${sep}v=10&encoding=json`);
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let p: Payload;
      try {
        p = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)) as Payload;
      } catch {
        return;
      }
      this.onPayload(ws, p);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.stopBeat();
      if (this.stopped) return;
      if (FATAL_CLOSE.has(e.code)) {
        this.stopped = true;
        this.waiting?.reject(
          new Error(
            e.code === 4004
              ? "Discord rejected the bot token"
              : `Discord closed the gateway (${e.code}${e.reason ? `: ${e.reason}` : ""})`,
          ),
        );
        this.waiting = undefined;
        return;
      }
      const delay = Math.min(30_000, (this.o.reconnectMs ?? 1000) * 2 ** this.attempts);
      this.attempts++;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        if (!this.stopped) this.connect();
      }, delay);
    };
    // A failed connection also fires close, which schedules the retry.
    ws.onerror = () => {};
  }

  private send0(ws: WebSocket, p: Payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(p));
  }

  private onPayload(ws: WebSocket, p: Payload) {
    if (typeof p.s === "number") this.seq = p.s;
    switch (p.op) {
      case 10: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startBeat(ws, interval);
        this.send0(ws, {
          op: 2,
          d: {
            token: this.o.token,
            intents: INTENTS,
            properties: { os: process.platform, browser: "redgiant", device: "redgiant" },
          },
        });
        break;
      }
      case 11:
        this.acked = true;
        break;
      case 1:
        // The gateway asks for a heartbeat right now.
        this.send0(ws, { op: 1, d: this.seq });
        break;
      case 7:
      case 9:
        // Reconnect / invalid session: a fresh connection identifies again.
        ws.close(4000);
        break;
      case 0:
        this.onDispatch(p.t ?? "", p.d);
        break;
    }
  }

  private startBeat(ws: WebSocket, interval: number) {
    this.stopBeat();
    this.acked = true;
    const beat = () => {
      // No ACK since the last beat: the connection is a zombie, so drop it and reconnect.
      if (!this.acked) {
        ws.close(4000);
        return;
      }
      this.acked = false;
      this.send0(ws, { op: 1, d: this.seq });
    };
    // Discord asks for a random first delay, so that many clients do not beat together.
    this.beat = setTimeout(
      () => {
        beat();
        this.beat = setInterval(beat, interval);
      },
      Math.floor(interval * Math.random()),
    );
  }

  private stopBeat() {
    if (this.beat) {
      clearTimeout(this.beat);
      clearInterval(this.beat);
    }
    this.beat = undefined;
  }

  private onDispatch(t: string, d: unknown) {
    if (t === "READY") {
      this.botId = (d as { user: User }).user.id;
      this.attempts = 0;
      this.waiting?.resolve();
      this.waiting = undefined;
    } else if (t === "MESSAGE_CREATE") this.enqueue(() => this.onMessage(d as Message));
    else if (t === "INTERACTION_CREATE") this.enqueue(() => this.onInteraction(d as Interaction));
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job).catch(() => {});
  }

  private async onMessage(m: Message) {
    const author = m.author;
    if (!author || author.bot || author.id === this.botId || !this.on) return;
    let text = m.content ?? "";
    // In a server only messages addressed to the bot are ours; DMs always are.
    if (m.guild_id) {
      if (!this.botId || !m.mentions?.some((u) => u.id === this.botId)) return;
      text = text.replace(new RegExp(`<@!?${this.botId}>`, "g"), "");
    }
    text = text.trim();
    const incoming: Incoming = {
      userId: author.id,
      chatId: m.channel_id,
      username: author.username ?? null,
    };
    if (text) incoming.text = text;
    const voice = ((m.flags ?? 0) & VOICE_MESSAGE) !== 0;
    for (const a of m.attachments ?? []) {
      const res = await this.fetch(a.url);
      if (!res.ok) continue;
      const data = Buffer.from(await res.arrayBuffer());
      const mime = a.content_type?.split(";")[0]?.trim() || "application/octet-stream";
      if (!incoming.audio && (mime.startsWith("audio/") || voice))
        incoming.audio = {
          data: new Uint8Array(data),
          mime: mime.startsWith("audio/") ? mime : "audio/ogg",
        };
      else incoming.files = [...(incoming.files ?? []), { name: a.filename, data, mime }];
    }
    if (!incoming.text && !incoming.audio && !incoming.files) return;
    await this.on(incoming);
  }

  private async onInteraction(i: Interaction) {
    if (i.type !== BUTTON_PRESS) return;
    // Acknowledged at once: Discord shows "interaction failed" after three seconds otherwise.
    await this.rest("POST", `/interactions/${i.id}/${i.token}/callback`, {
      type: DEFERRED_UPDATE_MESSAGE,
    }).catch(() => {});
    const user = i.member?.user ?? i.user;
    const id = i.data?.custom_id;
    if (!user || user.bot || !id || !i.channel_id || !this.on) return;
    await this.on({
      userId: user.id,
      chatId: i.channel_id,
      username: user.username ?? null,
      button: id,
    });
  }

  // ---------- REST ----------

  private async rest(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bot ${this.o.token}` };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers,
      ...(payload !== undefined && { body: payload }),
    });
    if (res.status === 429 && !retried) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const seconds = j.retry_after ?? Number(res.headers.get("retry-after") ?? 1);
      await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
      return this.rest(method, path, body, true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new DiscordError(
        `Discord ${method} ${path}: ${res.status} ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
  }

  async send(chatId: string, text: string, buttons?: Button[]): Promise<string | undefined> {
    const body: Record<string, unknown> = { content: text };
    if (buttons?.length) body.components = rows(buttons);
    const m = (await this.rest("POST", `/channels/${chatId}/messages`, body)) as { id?: string };
    return m?.id;
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.rest("PATCH", `/channels/${chatId}/messages/${messageId}`, {
      content: text,
      components: [],
    });
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        ...(caption && { content: caption.slice(0, this.maxLength) }),
        attachments: [{ id: 0, filename: name }],
      }),
    );
    form.append("files[0]", new Blob([new Uint8Array(data)], { type: mime }), name);
    await this.rest("POST", `/channels/${chatId}/messages`, form);
  }

  async typing(chatId: string): Promise<void> {
    await this.rest("POST", `/channels/${chatId}/typing`);
  }
}

/** Action rows of up to five buttons, five rows at most (Discord's limits). */
function rows(buttons: Button[]) {
  const out: unknown[] = [];
  const list = buttons.slice(0, 25);
  for (let i = 0; i < list.length; i += 5)
    out.push({
      type: 1,
      components: list.slice(i, i + 5).map((b, j) => ({
        type: 2,
        style: i + j === 0 ? 1 : 2,
        custom_id: b.id,
        label: b.label.slice(0, 80),
      })),
    });
  return out;
}
