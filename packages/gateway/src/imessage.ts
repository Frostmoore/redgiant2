// iMessage through a BlueBubbles server (Apache-2.0, bluebubbles.app) on a Mac that stays on and
// signed in to Messages. Apple has no iMessage API: BlueBubbles reads the Mac's chat database
// (it needs Full Disk Access) and sends through Messages itself (AppleScript; with its Private
// API helper also typing and edits). RedGiant asks its REST API for new messages, one poll at a
// time, so the Mac never has to reach RedGiant; RedGiant must reach the Mac (same network, or
// BlueBubbles' own tunnel address). No buttons on iMessage: the bridge numbers the choices.

import { randomUUID } from "node:crypto";
import type { Button, Incoming, Transport } from "./bridge.js";

export interface IMessageOptions {
  /** The BlueBubbles server, e.g. http://192.168.1.20:1234 or its tunnel address. */
  url: string;
  /** BlueBubbles' server password. */
  password: string;
  /** "on" when BlueBubbles' Private API helper is set up: typing and edits too. */
  privateApi?: string | undefined;
  fetch?: typeof fetch;
  /** Pause between polls (default 2000 ms). */
  pollMs?: number;
}

interface BbAttachment {
  guid?: string;
  mimeType?: string | null;
  transferName?: string | null;
  totalBytes?: number;
}

export interface BbMessage {
  guid?: string;
  text?: string | null;
  isFromMe?: boolean;
  dateCreated?: number;
  /** Tapbacks and other reactions point at another message. */
  associatedMessageGuid?: string | null;
  handle?: { address?: string } | null;
  chats?: { guid?: string; displayName?: string | null }[];
  attachments?: BbAttachment[];
}

const MAX_MEDIA = 20 * 1024 * 1024;
/** A group chat's guid: "iMessage;+;chat…"; a person's: "iMessage;-;+39…". */
const isGroup = (chatGuid: string) => chatGuid.includes(";+;");

export class IMessageTransport implements Transport {
  readonly platform = "imessage" as const;
  readonly buttons = false;
  readonly maxLength = 8000;
  /** Edits only with the Private API (macOS 13 and later); otherwise answers stay as sent. */
  readonly edit?: (chatId: string, messageId: string, text: string) => Promise<void>;
  readonly typing?: (chatId: string) => Promise<void>;
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private readonly privateApi: boolean;
  private after = 0;
  private readonly seen: string[] = [];
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly o: IMessageOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.fetch = o.fetch ?? fetch;
    this.privateApi = o.privateApi === "on";
    if (this.privateApi) {
      this.edit = async (_chatId, messageId, text) => {
        await this.call("POST", `/api/v1/message/${encodeURIComponent(messageId)}/edit`, {
          editedMessage: text,
          backwardsCompatibilityMessage: text,
          partIndex: 0,
        });
      };
      this.typing = async (chatId) => {
        await this.call("POST", `/api/v1/chat/${encodeURIComponent(chatId)}/typing`);
      };
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const sep = path.includes("?") ? "&" : "?";
    const init: RequestInit = { method };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    // BlueBubbles reads its password from the query only.
    const res = await this.fetch(
      `${this.url}${path}${sep}password=${encodeURIComponent(this.o.password)}`,
      init,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `BlueBubbles ${method} ${path.split("?")[0]}: ${res.status} ${detail.slice(0, 200)}`.trim(),
      );
    }
    return res;
  }

  private async query(body: Record<string, unknown>): Promise<BbMessage[]> {
    const res = await this.call("POST", "/api/v1/message/query", {
      with: ["chat", "attachment", "handle"],
      ...body,
    });
    const out = (await res.json().catch(() => ({}))) as { data?: BbMessage[] };
    return Array.isArray(out.data) ? out.data : [];
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    // A wrong address or password fails here (401), before the settings are kept.
    await this.call("GET", "/api/v1/ping");
    // Only what arrives from now on: the newest message marks where we are (the Mac's clock).
    const [last] = await this.query({ limit: 1, sort: "DESC" });
    this.after = last?.dateCreated ?? Date.now();
    if (last?.guid) this.seen.push(last.guid);
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.polling = this.poll(on)
        .catch(() => {})
        .finally(() => {
          this.polling = undefined;
          if (this.running) this.timer = setTimeout(loop, this.o.pollMs ?? 2000);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  private async poll(on: (m: Incoming) => Promise<void>) {
    const list = await this.query({ after: this.after, sort: "ASC", limit: 100 });
    for (const msg of list) {
      if (typeof msg.dateCreated === "number" && msg.dateCreated > this.after)
        this.after = msg.dateCreated;
      if (!msg.guid || this.seen.includes(msg.guid)) continue;
      this.seen.push(msg.guid);
      if (this.seen.length > 500) this.seen.shift();
      const m = await this.toIncoming(msg).catch(() => undefined);
      if (m) await on(m).catch(() => {});
    }
  }

  private async toIncoming(msg: BbMessage): Promise<Incoming | undefined> {
    // What the Mac sends (our own answers too) and tapbacks are not messages to answer.
    if (msg.isFromMe || msg.associatedMessageGuid) return undefined;
    const userId = msg.handle?.address;
    const chatId = msg.chats?.[0]?.guid;
    if (!userId || !chatId) return undefined;
    let text = (msg.text ?? "").replace(/￼/g, "").trim();
    // In a group the Mac's account is one of many: only messages naming RedGiant are for it.
    if (isGroup(chatId)) {
      if (!/\bredgiant\b/i.test(text)) return undefined;
      text = text.replace(/^\s*@?redgiant\s*[:,]?\s*/i, "").trim();
    }
    const m: Incoming = { userId, chatId, username: userId };
    if (text) m.text = text;
    for (const a of msg.attachments ?? []) {
      if (!a.guid || (a.totalBytes ?? 0) > MAX_MEDIA) continue;
      const res = await this.call(
        "GET",
        `/api/v1/attachment/${encodeURIComponent(a.guid)}/download`,
      );
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_MEDIA) continue;
      const mime = a.mimeType || res.headers.get("content-type") || "application/octet-stream";
      const name = a.transferName || a.guid;
      // Voice messages are .caf recordings; the transcription decodes them with ffmpeg.
      if ((mime.startsWith("audio/") || /\.caf$/i.test(name)) && !m.audio) m.audio = { data, mime };
      else m.files = [...(m.files ?? []), { name, data, mime }];
    }
    if (!m.text && !m.audio && !m.files) return undefined;
    return m;
  }

  private method() {
    return this.privateApi ? "private-api" : "apple-script";
  }

  async send(chatId: string, text: string, _buttons?: Button[]): Promise<string | undefined> {
    const res = await this.call("POST", "/api/v1/message/text", {
      chatGuid: chatId,
      tempGuid: randomUUID(),
      message: text,
      method: this.method(),
    });
    const out = (await res.json().catch(() => ({}))) as { data?: { guid?: string } };
    // AppleScript sends cannot be edited, so their id would be no use.
    return this.privateApi ? out.data?.guid : undefined;
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.set("chatGuid", chatId);
    form.set("tempGuid", randomUUID());
    form.set("name", name);
    form.set("method", this.method());
    form.set(
      "attachment",
      new Blob([new Uint8Array(data)], { type: mime || "application/octet-stream" }),
      name,
    );
    await this.call("POST", "/api/v1/message/attachment", form);
    if (caption) await this.send(chatId, caption);
  }
}
