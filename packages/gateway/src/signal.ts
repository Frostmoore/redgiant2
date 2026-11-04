// Signal through signal-cli-rest-api (bbernhard/signal-cli-rest-api), which the person runs and
// links to their own number. Signal has no bot API and no buttons: the bridge numbers choices.
// Messages arrive by polling the "normal"/"native" receive endpoint, one poll at a time.

import type { Button, Incoming, Transport } from "./bridge.js";

export interface SignalOptions {
  /** The REST service, e.g. http://signal:8080. */
  url: string;
  /** The linked number messages are received on and sent from. */
  number: string;
  fetch?: typeof fetch;
  /** Pause between polls (default 2000 ms). */
  pollMs?: number;
}

interface Attachment {
  id?: string;
  contentType?: string;
  filename?: string | null;
}

interface Envelope {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: {
    message?: string | null;
    groupInfo?: { groupId?: string } | null;
    attachments?: Attachment[] | null;
  } | null;
}

const GROUP = "group.";

export class SignalTransport implements Transport {
  readonly platform = "signal" as const;
  readonly buttons = false;
  readonly maxLength = 4000;
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private polling: Promise<void> | undefined;

  constructor(private readonly o: SignalOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.fetch = o.fetch ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`signal-cli-rest-api ${method} ${path}: ${res.status} ${detail}`.trim());
    }
    return res;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    // Fail early (a wrong url, the service down) instead of polling into the void.
    await this.call("GET", "/v1/about");
    this.running = true;
    // The next poll is scheduled only when the previous one is over, so they never overlap.
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
    const res = await this.call("GET", `/v1/receive/${encodeURIComponent(this.o.number)}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) return;
    for (const item of list as { envelope?: Envelope }[]) {
      const m = await this.toIncoming(item.envelope ?? (item as Envelope)).catch(() => undefined);
      if (m) await on(m).catch(() => {});
    }
  }

  private async toIncoming(e: Envelope): Promise<Incoming | undefined> {
    const d = e.dataMessage;
    // Receipts, typing and sync messages carry no dataMessage: nothing to answer.
    if (!d) return undefined;
    const userId = e.sourceNumber ?? e.sourceUuid ?? e.source;
    if (!userId) return undefined;
    const groupId = d.groupInfo?.groupId;
    const m: Incoming = {
      userId,
      chatId: groupId ? `${GROUP}${groupId}` : userId,
      username: e.sourceName ?? null,
    };
    if (d.message) m.text = d.message;
    for (const a of d.attachments ?? []) {
      if (!a.id) continue;
      const res = await this.call("GET", `/v1/attachments/${encodeURIComponent(a.id)}`);
      const data = Buffer.from(await res.arrayBuffer());
      const mime = a.contentType || "application/octet-stream";
      if (mime.startsWith("audio/") && !m.audio) m.audio = { data, mime };
      else m.files = [...(m.files ?? []), { name: a.filename || a.id, data, mime }];
    }
    if (!m.text && !m.audio && !m.files) return undefined;
    return m;
  }

  /** A group chat is sent to its group id; a person to their number. */
  private recipient(chatId: string) {
    return chatId.startsWith(GROUP) ? chatId.slice(GROUP.length) : chatId;
  }

  private async post(body: Record<string, unknown>, chatId: string) {
    const res = await this.call("POST", "/v2/send", {
      ...body,
      number: this.o.number,
      recipients: [this.recipient(chatId)],
    });
    const out = (await res.json().catch(() => ({}))) as { timestamp?: string | number };
    return out.timestamp === undefined ? undefined : String(out.timestamp);
  }

  async send(chatId: string, text: string, _buttons?: Button[]): Promise<string | undefined> {
    return this.post({ message: text }, chatId);
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    await this.post(
      {
        message: caption ?? "",
        base64_attachments: [`data:${mime};filename=${name};base64,${data.toString("base64")}`],
      },
      chatId,
    );
  }

  async typing(chatId: string): Promise<void> {
    await this.call("PUT", `/v1/typing-indicator/${encodeURIComponent(this.o.number)}`, {
      recipient: this.recipient(chatId),
    });
  }
}
