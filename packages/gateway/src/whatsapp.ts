// WhatsApp through Meta's Cloud API. Messages arrive by webhook: the server's routes hand the
// verification query to `verify` and every POST (raw body and signature) to `webhook`.
// Up to three choices become reply buttons, up to ten a list; the bridge numbers the rest.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Button, Incoming, Transport } from "./bridge.js";

export interface WhatsAppOptions {
  /** A system user's access token. */
  token: string;
  phoneNumberId: string;
  /** Signs every webhook call (X-Hub-Signature-256). */
  appSecret: string;
  /** The token typed in Meta's webhook settings, echoed back when it subscribes. */
  verifyToken: string;
  apiRoot?: string;
  fetch?: typeof fetch;
}

interface WaMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  audio?: { id?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
}

interface WaValue {
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
}

/** The Cloud API's limits for interactive messages. */
const BODY_MAX = 1024;
const BUTTON_TITLE_MAX = 20;
const ROW_TITLE_MAX = 24;
const MAX_BUTTONS = 3;
const MAX_ROWS = 10;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export class WhatsAppTransport implements Transport {
  readonly platform = "whatsapp" as const;
  readonly buttons = true;
  readonly maxLength = 4000;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private on: ((m: Incoming) => Promise<void>) | undefined;

  constructor(private readonly o: WhatsAppOptions) {
    this.api = (o.apiRoot ?? "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
    this.fetch = o.fetch ?? fetch;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${this.o.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`WhatsApp ${init.method ?? "GET"} ${url}: ${res.status} ${detail}`.trim());
    }
    return res;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    // A wrong token shows now, not at the first reply.
    await this.call(`${this.api}/${this.o.phoneNumberId}`);
    this.on = on;
  }

  async stop(): Promise<void> {
    this.on = undefined;
  }

  /** Meta's subscription check: the challenge back only when our verify token was sent. */
  verify(query: {
    "hub.mode"?: string;
    "hub.verify_token"?: string;
    "hub.challenge"?: string;
  }): string | undefined {
    if (query["hub.mode"] !== "subscribe") return undefined;
    const sent = Buffer.from(query["hub.verify_token"] ?? "");
    const ours = Buffer.from(this.o.verifyToken);
    if (sent.length !== ours.length || !timingSafeEqual(sent, ours)) return undefined;
    return query["hub.challenge"];
  }

  /** False when the signature is wrong: anyone can reach a webhook, only Meta knows the secret. */
  async webhook(rawBody: string, signature: string | undefined): Promise<boolean> {
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", this.o.appSecret).update(rawBody).digest("hex")}`,
    );
    const got = Buffer.from(signature ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
    let body: { entry?: { changes?: { value?: WaValue }[] }[] };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return true;
    }
    const on = this.on;
    if (!on) return true;
    for (const entry of body.entry ?? [])
      for (const change of entry.changes ?? []) {
        const value = change.value;
        // Status updates (sent, delivered, read) come without messages.
        for (const msg of value?.messages ?? []) {
          const m = await this.toIncoming(msg, value as WaValue).catch(() => undefined);
          if (m) await on(m).catch(() => {});
        }
      }
    return true;
  }

  private async toIncoming(msg: WaMessage, value: WaValue): Promise<Incoming | undefined> {
    if (!msg.from) return undefined;
    const contact = value.contacts?.find((c) => c.wa_id === msg.from) ?? value.contacts?.[0];
    const m: Incoming = {
      userId: msg.from,
      chatId: msg.from,
      username: contact?.profile?.name ?? null,
    };
    switch (msg.type) {
      case "text":
        if (!msg.text?.body) return undefined;
        m.text = msg.text.body;
        return m;
      case "interactive": {
        const id = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
        if (!id) return undefined;
        m.button = id;
        return m;
      }
      case "audio": {
        if (!msg.audio?.id) return undefined;
        const f = await this.download(msg.audio.id, msg.audio.mime_type);
        m.audio = { data: f.data, mime: f.mime };
        return m;
      }
      case "image":
      case "document": {
        const media = msg.type === "image" ? msg.image : msg.document;
        if (!media?.id) return undefined;
        const f = await this.download(media.id, media.mime_type);
        const name =
          msg.document?.filename ?? `${msg.type}-${media.id}.${EXTENSIONS[f.mime] ?? "bin"}`;
        m.files = [{ name, data: f.data, mime: f.mime }];
        if (media.caption) m.text = media.caption;
        return m;
      }
      default:
        return undefined;
    }
  }

  /** Media come in two steps: the id gives a short-lived url, which also wants the token. */
  private async download(mediaId: string, mime?: string) {
    const meta = (await (await this.call(`${this.api}/${mediaId}`)).json()) as {
      url?: string;
      mime_type?: string;
    };
    if (!meta.url) throw new Error(`WhatsApp media ${mediaId}: no url`);
    const res = await this.call(meta.url);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: meta.mime_type ?? mime ?? "application/octet-stream",
    };
  }

  private async message(chatId: string, content: Record<string, unknown>) {
    const res = await this.call(`${this.api}/${this.o.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: chatId,
        ...content,
      }),
    });
    const out = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    return out.messages?.[0]?.id;
  }

  async send(chatId: string, text: string, buttons?: Button[]): Promise<string | undefined> {
    if (!buttons?.length || buttons.length > MAX_ROWS)
      return this.message(chatId, { type: "text", text: { body: text, preview_url: false } });
    let body = text;
    if (body.length > BODY_MAX) {
      // An interactive body holds 1024 characters: the full text goes first, the choices after.
      await this.message(chatId, { type: "text", text: { body: text, preview_url: false } });
      body = "Choose";
    }
    const interactive =
      buttons.length <= MAX_BUTTONS
        ? {
            type: "button",
            body: { text: body },
            action: {
              buttons: buttons.map((b) => ({
                type: "reply",
                reply: { id: b.id, title: clip(b.label, BUTTON_TITLE_MAX) },
              })),
            },
          }
        : {
            type: "list",
            body: { text: body },
            action: {
              button: "Choose",
              sections: [
                {
                  rows: buttons.map((b) => ({ id: b.id, title: clip(b.label, ROW_TITLE_MAX) })),
                },
              ],
            },
          };
    return this.message(chatId, { type: "interactive", interactive });
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), name);
    const res = await this.call(`${this.api}/${this.o.phoneNumberId}/media`, {
      method: "POST",
      body: form,
    });
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new Error("WhatsApp media upload: no id");
    const image = mime.startsWith("image/");
    await this.message(
      chatId,
      image
        ? { type: "image", image: { id, ...(caption && { caption }) } }
        : { type: "document", document: { id, filename: name, ...(caption && { caption }) } },
    );
  }
}
