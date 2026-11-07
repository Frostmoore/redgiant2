// Matrix through the client-server API (spec v1.11+): any homeserver, a bot account of its own,
// its access token. Messages arrive by long-polling /sync, one request at a time; invitations are
// accepted by themselves (pairing decides who is listened to). Matrix has no buttons: the bridge
// numbers the choices. Edits are `m.replace` events, files go through the media repository.
//
// End-to-end encryption: the bot speaks plain client-server API, so encrypted rooms work when the
// homeserver address is a Pantalaimon proxy (matrix-org's E2EE daemon) in front of the real one.
// Without it an encrypted message cannot be read: the person is told once per room.

import type { Button, Incoming, Transport } from "./bridge.js";

export interface MatrixOptions {
  /** The homeserver (or a Pantalaimon proxy in front of it), e.g. https://matrix.org. */
  homeserver: string;
  /** The bot account's access token. */
  accessToken: string;
  fetch?: typeof fetch;
  /** How long one /sync waits for news (default 30 s). */
  syncTimeoutMs?: number;
  /** Pause after a failed /sync, doubled up to 30 s (default 2 s). */
  retryMs?: number;
}

interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  content?: {
    msgtype?: string;
    body?: string;
    url?: string;
    filename?: string;
    info?: { mimetype?: string; size?: number };
    "m.mentions"?: { user_ids?: string[] };
    "m.relates_to"?: { rel_type?: string; "m.in_reply_to"?: { event_id?: string } };
  };
}

interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        summary?: { "m.joined_member_count"?: number };
        timeline?: { events?: MatrixEvent[] };
      }
    >;
    invite?: Record<string, unknown>;
  };
}

/** Files bigger than this are not downloaded (the bridge would pass them to a model). */
const MAX_MEDIA = 20 * 1024 * 1024;

const FILTER = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    ephemeral: { not_types: ["*"] },
    state: { lazy_load_members: true },
    timeline: { types: ["m.room.message", "m.room.encrypted"], limit: 50 },
  },
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A reply carries the quoted message as "> " lines first: only the new text is kept. */
function withoutQuote(body: string): string {
  if (!body.startsWith("> ")) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.startsWith(">")) i++;
  return lines
    .slice(i)
    .join("\n")
    .replace(/^\s*\n/, "");
}

export class MatrixTransport implements Transport {
  readonly platform = "matrix" as const;
  readonly buttons = false;
  readonly maxLength = 16_000;
  private readonly hs: string;
  private readonly fetch: typeof fetch;
  private userId = "";
  private since: string | undefined;
  private running = false;
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private txn = 0;
  private readonly members = new Map<string, number>();
  /** Rooms already told that encrypted messages need the proxy. */
  private readonly warned = new Set<string>();

  constructor(private readonly o: MatrixOptions) {
    this.hs = o.homeserver.replace(/\/+$/, "");
    this.fetch = o.fetch ?? fetch;
  }

  /** The bot's own id, known once started. */
  get me(): string {
    return this.userId;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    o: { raw?: { data: Uint8Array; mime: string }; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.o.accessToken}`,
        ...(o.raw
          ? { "content-type": o.raw.mime }
          : body !== undefined && { "content-type": "application/json" }),
      },
      ...(o.raw
        ? { body: new Uint8Array(o.raw.data) }
        : body !== undefined && { body: JSON.stringify(body) }),
      ...(o.signal && { signal: o.signal }),
    };
    let res = await this.fetch(`${this.hs}${path}`, init);
    if (res.status === 429) {
      // M_LIMIT_EXCEEDED says how long to wait: once, then the error goes up.
      const info = (await res.json().catch(() => ({}))) as { retry_after_ms?: number };
      await new Promise((r) => setTimeout(r, Math.min(info.retry_after_ms ?? 1000, 10_000)));
      res = await this.fetch(`${this.hs}${path}`, init);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Matrix ${method} ${path.split("?")[0]}: ${res.status} ${detail}`.trim());
    }
    return res;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    // A wrong token or address fails here, before the settings are kept.
    const who = (await (await this.call("GET", "/_matrix/client/v3/account/whoami")).json()) as {
      user_id?: string;
    };
    if (!who.user_id) throw new Error("Matrix whoami: no user_id");
    this.userId = who.user_id;
    // The first sync only marks where we are: what was written before is not answered again.
    const first = await this.sync(0);
    await this.joinInvites(first);
    this.remember(first);
    this.since = first.next_batch;
    this.running = true;
    this.loop = this.run(on);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => {});
    this.loop = undefined;
  }

  private async sync(timeout: number): Promise<SyncResponse> {
    const q = new URLSearchParams({ timeout: String(timeout), filter: FILTER });
    if (this.since) q.set("since", this.since);
    this.abort = new AbortController();
    const res = await this.call("GET", `/_matrix/client/v3/sync?${q}`, undefined, {
      signal: this.abort.signal,
    });
    return (await res.json()) as SyncResponse;
  }

  private async run(on: (m: Incoming) => Promise<void>) {
    let wait = this.o.retryMs ?? 2000;
    while (this.running) {
      try {
        const s = await this.sync(this.o.syncTimeoutMs ?? 30_000);
        if (!this.running) return;
        await this.joinInvites(s);
        this.remember(s);
        for (const [roomId, room] of Object.entries(s.rooms?.join ?? {}))
          for (const e of room.timeline?.events ?? []) {
            const m = await this.toIncoming(roomId, e).catch(() => undefined);
            if (m) await on(m).catch(() => {});
          }
        if (s.next_batch) this.since = s.next_batch;
        wait = this.o.retryMs ?? 2000;
      } catch {
        if (!this.running) return;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30_000);
      }
    }
  }

  private remember(s: SyncResponse) {
    for (const [roomId, room] of Object.entries(s.rooms?.join ?? {})) {
      const n = room.summary?.["m.joined_member_count"];
      if (typeof n === "number") this.members.set(roomId, n);
    }
  }

  private async joinInvites(s: SyncResponse) {
    for (const roomId of Object.keys(s.rooms?.invite ?? {}))
      await this.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {}).catch(
        () => {},
      );
  }

  private async toIncoming(roomId: string, e: MatrixEvent): Promise<Incoming | undefined> {
    if (!e.sender || e.sender === this.userId) return undefined;
    const base = { userId: e.sender, chatId: roomId, username: e.sender };
    if (e.type === "m.room.encrypted") {
      if (this.warned.has(roomId)) return undefined;
      this.warned.add(roomId);
      return { ...base, unreadable: "encrypted" };
    }
    const c = e.content;
    // Notices are what bots write: never answered, so two bots never talk forever.
    if (e.type !== "m.room.message" || !c?.msgtype || c.msgtype === "m.notice") return undefined;
    let text = withoutQuote(c.body ?? "");
    // In a room with others the bot answers only when named; a direct chat is all for it.
    if ((this.members.get(roomId) ?? 2) > 2) {
      const local = escapeRe(this.userId.slice(1).split(":")[0] ?? "");
      const named =
        c["m.mentions"]?.user_ids?.includes(this.userId) ||
        text.includes(this.userId) ||
        (local !== "" && new RegExp(`\\b${local}\\b`, "i").test(text));
      if (!named) return undefined;
      text = text
        .replace(this.userId, "")
        .replace(new RegExp(`^\\s*${local}\\s*[:,]?`, "i"), "")
        .trim();
    }
    const m: Incoming = { ...base };
    if (c.msgtype === "m.text" || c.msgtype === "m.emote") {
      if (!text.trim()) return undefined;
      m.text = text;
      return m;
    }
    if (!c.url?.startsWith("mxc://")) return undefined;
    if ((c.info?.size ?? 0) > MAX_MEDIA) return undefined;
    const data = await this.download(c.url);
    const mime = c.info?.mimetype || "application/octet-stream";
    const name = c.filename || c.body || "file";
    if (c.msgtype === "m.audio") m.audio = { data, mime };
    else {
      m.files = [{ name, data, mime }];
      // With `filename` set, `body` is a caption (spec v1.10).
      if (c.filename && c.body && c.body !== c.filename) m.text = c.body;
    }
    return m;
  }

  /** Authenticated media (v1.11) first; older homeservers only serve the v3 path. */
  private async download(mxc: string): Promise<Buffer> {
    const [server, id] = mxc.slice("mxc://".length).split("/");
    if (!server || !id) throw new Error(`Matrix: bad media ${mxc}`);
    const tail = `${encodeURIComponent(server)}/${encodeURIComponent(id)}`;
    const res = await this.call("GET", `/_matrix/client/v1/media/download/${tail}`).catch(() =>
      this.call("GET", `/_matrix/media/v3/download/${tail}`),
    );
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_MEDIA) throw new Error("Matrix: file too big");
    return data;
  }

  private async event(roomId: string, content: Record<string, unknown>) {
    this.txn += 1;
    const txn = `rg${Date.now()}.${this.txn}`;
    const res = await this.call(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
      content,
    );
    const out = (await res.json().catch(() => ({}))) as { event_id?: string };
    return out.event_id;
  }

  async send(chatId: string, text: string, _buttons?: Button[]): Promise<string | undefined> {
    return this.event(chatId, { msgtype: "m.text", body: text });
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.event(chatId, {
      msgtype: "m.text",
      body: `* ${text}`,
      "m.new_content": { msgtype: "m.text", body: text },
      "m.relates_to": { rel_type: "m.replace", event_id: messageId },
    });
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const type = mime || "application/octet-stream";
    const up = (await (
      await this.call(
        "POST",
        `/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
        undefined,
        { raw: { data: new Uint8Array(data), mime: type } },
      )
    ).json()) as { content_uri?: string };
    if (!up.content_uri) throw new Error("Matrix upload: no content_uri");
    const msgtype = type.startsWith("image/")
      ? "m.image"
      : type.startsWith("audio/")
        ? "m.audio"
        : type.startsWith("video/")
          ? "m.video"
          : "m.file";
    await this.event(chatId, {
      msgtype,
      body: caption || name,
      ...(caption && { filename: name }),
      url: up.content_uri,
      info: { mimetype: type, size: data.length },
    });
  }

  async typing(chatId: string): Promise<void> {
    await this.call(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}/typing/${encodeURIComponent(this.userId)}`,
      { typing: true, timeout: 6000 },
    );
  }
}
