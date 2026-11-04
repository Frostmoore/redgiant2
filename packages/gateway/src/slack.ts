// Slack through Socket Mode: Slack pushes events over a WebSocket we open, so the server needs
// no public URL. Replies go through the Web API with the bot token; the app token (xapp-) is
// only for opening the socket.

import { type Button, type Incoming, splitText, type Transport } from "./bridge.js";

export interface SlackOptions {
  /** xoxb-…: the Web API (messages, files). */
  botToken: string;
  /** xapp-… with `connections:write`: Socket Mode. */
  appToken: string;
  apiRoot?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Waits before reopening a socket that dropped without a `disconnect` (default 2 s). */
  reconnectDelayMs?: number;
}

/** Slack's limit for one section block's text. */
const SECTION_MAX = 3000;
/** Slack's limit for a button's label. */
const LABEL_MAX = 75;

interface SlackFile {
  name?: string;
  mimetype?: string;
  url_private_download?: string;
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  files?: SlackFile[];
}

interface Envelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: SlackEvent;
    type?: string;
    user?: { id?: string; username?: string; name?: string };
    channel?: { id?: string };
    actions?: { action_id?: string }[];
  };
}

/** Slack reads `&`, `<` and `>` as markup (links, mentions): plain text must escape them. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sections(text: string) {
  return splitText(escapeText(text) || " ", SECTION_MAX).map((part) => ({
    type: "section",
    text: { type: "mrkdwn", text: part },
  }));
}

export class SlackTransport implements Transport {
  readonly platform = "slack" as const;
  readonly buttons = true;
  readonly maxLength = 3900;

  private readonly api: string;
  private readonly fetch: typeof fetch;
  private readonly WS: typeof WebSocket;
  private socket: WebSocket | undefined;
  private botUserId = "";
  private on: ((m: Incoming) => Promise<void>) | undefined;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** A mention arrives twice (`message` and `app_mention`): the second is dropped. */
  private readonly seen: string[] = [];

  constructor(private readonly o: SlackOptions) {
    this.api = (o.apiRoot ?? "https://slack.com/api").replace(/\/$/, "");
    this.fetch = o.fetch ?? globalThis.fetch;
    this.WS = o.WebSocket ?? globalThis.WebSocket;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    this.stopped = false;
    this.on = on;
    const me = await this.call<{ user_id: string }>("auth.test", {});
    this.botUserId = me.user_id;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const s = this.socket;
    this.socket = undefined;
    s?.close();
  }

  // ---------- Web API ----------

  /** One Web API call; a 429 is waited out once, as Slack asks with Retry-After. */
  private async call<T>(
    method: string,
    args: Record<string, unknown>,
    o: { token?: string; form?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.token ?? this.o.botToken}`,
    };
    let body: string;
    if (o.form) {
      // The file upload methods read form fields, not JSON.
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(
        Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
      ).toString();
    } else {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(args);
    }
    let res = await this.fetch(`${this.api}/${method}`, { method: "POST", headers, body });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 1);
      await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 1) * 1000));
      res = await this.fetch(`${this.api}/${method}`, { method: "POST", headers, body });
    }
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    const data = (await res.json()) as { ok?: boolean; error?: string } & T;
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "failed"}`);
    return data;
  }

  // ---------- Socket Mode ----------

  /** Opens a socket and resolves on its `hello`; Slack sends events only after it. */
  private async connect(): Promise<void> {
    const { url } = await this.call<{ url: string }>(
      "apps.connections.open",
      {},
      { token: this.o.appToken },
    );
    if (this.stopped) return;
    const ws = new this.WS(url);
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      ws.addEventListener("message", (e) => {
        if (this.socket !== ws) return;
        let env: Envelope;
        try {
          env = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
        } catch {
          return;
        }
        // Unacknowledged envelopes are sent again, so every one is acknowledged first.
        if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === "hello") {
          ready = true;
          resolve();
        } else if (env.type === "disconnect") {
          // Slack rotates connections: open the next one, then drop this one.
          this.socket = undefined;
          this.reconnect(0);
          ws.close();
        } else void this.onEnvelope(env).catch(() => {});
      });
      ws.addEventListener("close", () => {
        const current = this.socket === ws;
        if (current) this.socket = undefined;
        // Before hello the caller retries (or start fails); after it, a dropped socket is reopened.
        if (!ready) reject(new Error("Slack socket closed before hello"));
        else if (current) this.reconnect(this.o.reconnectDelayMs ?? 2000);
      });
      ws.addEventListener("error", () => {
        if (!ready) reject(new Error("Slack socket failed"));
      });
    });
  }

  private reconnect(delayMs: number) {
    if (this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.stopped) return;
      this.connect().catch(() => this.reconnect(Math.max(delayMs, 2000)));
    }, delayMs);
  }

  private async onEnvelope(env: Envelope) {
    const p = env.payload;
    if (!p || !this.on) return;
    if (env.type === "interactive" && p.type === "block_actions") {
      const button = p.actions?.[0]?.action_id;
      const userId = p.user?.id;
      const chatId = p.channel?.id;
      if (!button || !userId || !chatId) return;
      await this.on({ userId, chatId, username: p.user?.username ?? p.user?.name ?? null, button });
      return;
    }
    if (env.type === "events_api" && p.event) await this.onEvent(p.event);
  }

  private async onEvent(ev: SlackEvent) {
    if (ev.type !== "message" && ev.type !== "app_mention") return;
    if (ev.bot_id || (ev.subtype && ev.subtype !== "file_share")) return;
    if (!ev.user || !ev.channel || ev.user === this.botUserId) return;
    let text = ev.text ?? "";
    // In channels the bot answers only when called by name; DMs are all for it.
    if (ev.type === "message" && ev.channel_type !== "im" && !text.includes(`<@${this.botUserId}`))
      return;
    text = text.replace(new RegExp(`<@${this.botUserId}(\\|[^>]*)?>`, "g"), "").trim();
    if (ev.ts) {
      const key = `${ev.channel}:${ev.ts}`;
      if (this.seen.includes(key)) return;
      this.seen.push(key);
      if (this.seen.length > 200) this.seen.shift();
    }
    const m: Incoming = { userId: ev.user, chatId: ev.channel };
    if (text) m.text = text;
    for (const f of ev.files ?? []) {
      if (!f.url_private_download) continue;
      const data = await this.download(f.url_private_download);
      const mime = f.mimetype || "application/octet-stream";
      if (mime.startsWith("audio/") && !m.audio) m.audio = { data, mime };
      else m.files = [...(m.files ?? []), { name: f.name || "file", data, mime }];
    }
    if (!m.text && !m.audio && !m.files) return;
    await this.on?.(m);
  }

  /** Slack's file links are private: they need the bot token. */
  private async download(url: string): Promise<Buffer> {
    const res = await this.fetch(url, {
      headers: { authorization: `Bearer ${this.o.botToken}` },
    });
    if (!res.ok) throw new Error(`Slack file download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- Outgoing ----------

  async send(chatId: string, text: string, buttons?: Button[]): Promise<string | undefined> {
    const args: Record<string, unknown> = { channel: chatId, text: escapeText(text) };
    if (buttons?.length)
      args.blocks = [
        ...sections(text),
        {
          type: "actions",
          elements: buttons.map((b, i) => ({
            type: "button",
            action_id: b.id,
            value: b.id,
            text: { type: "plain_text", text: b.label.slice(0, LABEL_MAX) },
            ...(i === 0 && { style: "primary" }),
          })),
        },
      ];
    const res = await this.call<{ ts?: string }>("chat.postMessage", args);
    return res.ts;
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    // Blocks without the actions block: the buttons go away with the edit.
    await this.call("chat.update", {
      channel: chatId,
      ts: messageId,
      text: escapeText(text),
      blocks: sections(text),
    });
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const up = await this.call<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: name, length: String(data.length) },
      { form: true },
    );
    const res = await this.fetch(up.upload_url, {
      method: "POST",
      headers: { "content-type": mime || "application/octet-stream" },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`Slack file upload: HTTP ${res.status}`);
    await this.call(
      "files.completeUploadExternal",
      {
        files: [{ id: up.file_id, title: name }],
        channel_id: chatId,
        ...(caption && { initial_comment: caption }),
      },
      { form: true },
    );
  }
}
