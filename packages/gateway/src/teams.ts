// Microsoft Teams through the Bot Framework (an Azure Bot, single-tenant: new multi-tenant bots
// cannot be made since July 2025). Teams posts every activity to a public webhook, signed with a
// JWT from the Bot Connector: the server's route hands the raw body and the Authorization header
// to `webhook`, which checks the signature against Microsoft's published keys before anything
// else. Replies go to the conversation's serviceUrl with a token for the bot's own app.
//
// Buttons are Adaptive Card actions; edits replace the activity (the card goes with it). Files
// to the person go through Teams' consent card (the file lands in their OneDrive once accepted);
// small pictures go inline.

import { createPublicKey, verify } from "node:crypto";
import type { Button, Incoming, Transport } from "./bridge.js";

export interface TeamsOptions {
  /** The bot's Microsoft App ID (a GUID). */
  appId: string;
  /** A client secret of that app. */
  appPassword: string;
  /** The Microsoft Entra tenant the app belongs to (single-tenant bots). */
  tenantId: string;
  fetch?: typeof fetch;
  /** Tests move the clock. */
  now?: () => number;
  loginRoot?: string;
  /** Where the Bot Connector publishes its signing keys. */
  openIdUrl?: string;
}

interface TeamsAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: { downloadUrl?: string; fileType?: string };
}

export interface TeamsActivity {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  recipient?: { id?: string };
  attachments?: TeamsAttachment[];
  value?: {
    rgButton?: string;
    type?: string;
    action?: string;
    context?: { rgFile?: string };
    uploadInfo?: {
      uploadUrl?: string;
      contentUrl?: string;
      name?: string;
      uniqueId?: string;
      fileType?: string;
    };
  };
}

interface Jwk {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  endorsements?: string[];
}

const BOT_ISSUER = "https://api.botframework.com";
/** Clock difference accepted on the token's times. */
const SKEW_S = 300;
/** Pictures up to this size go inline; bigger files through the consent card. */
const INLINE_MAX = 24 * 1024;
const MAX_MEDIA = 20 * 1024 * 1024;
const FILE_DOWNLOAD = "application/vnd.microsoft.teams.file.download.info";
const SEP = "|";

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Teams writes HTML: mentions as <at>…</at>, paragraphs as <p>. Only the words are kept. */
export function teamsText(html: string): string {
  return html
    .replace(/<at>[^<]*<\/at>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export class TeamsTransport implements Transport {
  readonly platform = "teams" as const;
  readonly buttons = true;
  readonly maxLength = 20_000;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private on: ((m: Incoming) => Promise<void>) | undefined;
  private token: { value: string; until: number } | undefined;
  private keys: { list: Jwk[]; until: number } | undefined;
  /** Files waiting for the person to accept them, by consent id. */
  private readonly pending = new Map<
    string,
    { data: Buffer; name: string; caption?: string; until: number }
  >();
  private seq = 0;

  constructor(private readonly o: TeamsOptions) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  async start(on: (m: Incoming) => Promise<void>): Promise<void> {
    // A wrong App ID, secret or tenant shows now (invalid_client), not at the first reply.
    await this.accessToken();
    this.on = on;
  }

  async stop(): Promise<void> {
    this.on = undefined;
  }

  // ---------- Tokens ----------

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const root = (this.o.loginRoot ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
    const res = await this.fetch(
      `${root}/${encodeURIComponent(this.o.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.o.appId,
          client_secret: this.o.appPassword,
          scope: "https://api.botframework.com/.default",
        }).toString(),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token)
      throw new Error(
        `Teams sign-in: ${res.status} ${data.error ?? ""} ${(data.error_description ?? "").split("\n")[0]}`.trim(),
      );
    this.token = {
      value: data.access_token,
      until: this.now() + Math.max(60, (data.expires_in ?? 3600) - 300) * 1000,
    };
    return data.access_token;
  }

  /** The Bot Connector's signing keys and the tenant's, cached for a day. */
  private async signingKeys(): Promise<Jwk[]> {
    if (this.keys && this.keys.until > this.now()) return this.keys.list;
    const meta = (await (
      await this.fetch(
        this.o.openIdUrl ?? "https://login.botframework.com/v1/.well-known/openidconfiguration",
      )
    ).json()) as { jwks_uri?: string };
    const root = (this.o.loginRoot ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
    const uris = [
      meta.jwks_uri,
      `${root}/${encodeURIComponent(this.o.tenantId)}/discovery/v2.0/keys`,
    ].filter((u): u is string => !!u);
    const list: Jwk[] = [];
    for (const uri of uris) {
      const r = await this.fetch(uri).catch(() => undefined);
      const body = (await r?.json().catch(() => ({}))) as { keys?: Jwk[] } | undefined;
      list.push(...(body?.keys ?? []));
    }
    if (list.length === 0) throw new Error("Teams: no signing keys");
    this.keys = { list, until: this.now() + 24 * 3600_000 };
    return list;
  }

  /** True only for a token Microsoft signed for this bot, now, about this serviceUrl. */
  async verifyToken(authorization: string | undefined, serviceUrl: string): Promise<boolean> {
    const jwt = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const parts = jwt?.split(".");
    if (parts?.length !== 3) return false;
    const [h, p, sig] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: {
      iss?: string;
      aud?: string;
      exp?: number;
      nbf?: number;
      serviceurl?: string;
      tid?: string;
    };
    try {
      header = JSON.parse(b64url(h).toString());
      claims = JSON.parse(b64url(p).toString());
    } catch {
      return false;
    }
    if (header.alg !== "RS256" || !header.kid) return false;
    let keys = await this.signingKeys().catch(() => []);
    let key = keys.find((k) => k.kid === header.kid);
    if (!key && this.keys) {
      // Keys rotate: one fresh look before refusing.
      this.keys = undefined;
      keys = await this.signingKeys().catch(() => []);
      key = keys.find((k) => k.kid === header.kid);
    }
    if (!key) return false;
    if (key.endorsements && !key.endorsements.includes("msteams")) return false;
    let ok = false;
    try {
      ok = verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: key as Record<string, string>, format: "jwk" }),
        b64url(sig),
      );
    } catch {
      return false;
    }
    if (!ok) return false;
    const issuers = [
      BOT_ISSUER,
      `https://sts.windows.net/${this.o.tenantId}/`,
      `https://login.microsoftonline.com/${this.o.tenantId}/v2.0`,
    ];
    if (!claims.iss || !issuers.includes(claims.iss)) return false;
    if (claims.aud !== this.o.appId) return false;
    const now = this.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) return false;
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) return false;
    if (
      claims.serviceurl &&
      claims.serviceurl.replace(/\/+$/, "") !== serviceUrl.replace(/\/+$/, "")
    )
      return false;
    return true;
  }

  // ---------- Incoming ----------

  /**
   * One POST from Teams. 401 when the token is not Microsoft's; the body is what an invoke
   * expects back. Messages are handed on without waiting: Teams wants its answer in seconds.
   */
  async webhook(
    rawBody: string,
    authorization: string | undefined,
  ): Promise<{ status: number; body?: unknown }> {
    let a: TeamsActivity;
    try {
      a = JSON.parse(rawBody);
    } catch {
      return { status: 400 };
    }
    if (!a.serviceUrl || !/^https:\/\//.test(a.serviceUrl)) return { status: 400 };
    if (!(await this.verifyToken(authorization, a.serviceUrl))) return { status: 401 };
    const on = this.on;
    if (!on) return { status: 503 };
    if (a.type === "invoke" && a.name === "fileConsent/invoke") {
      void this.consent(a).catch(() => {});
      return { status: 200, body: { status: 200 } };
    }
    if (a.type === "message")
      void this.toIncoming(a)
        .then((m) => (m ? on(m) : undefined))
        .catch(() => {});
    return { status: 200 };
  }

  private async toIncoming(a: TeamsActivity): Promise<Incoming | undefined> {
    const userId = a.from?.id;
    const conv = a.conversation?.id;
    if (!userId || !conv || !a.serviceUrl || userId === a.recipient?.id) return undefined;
    const m: Incoming = {
      userId,
      chatId: `${a.serviceUrl}${SEP}${conv}`,
      username: a.from?.name ?? null,
    };
    if (a.value?.rgButton) {
      m.button = a.value.rgButton;
      return m;
    }
    const text = teamsText(a.text ?? "");
    if (text) m.text = text;
    for (const att of a.attachments ?? []) {
      const f = await this.attachment(att, a.serviceUrl).catch(() => undefined);
      if (!f) continue;
      if (f.mime.startsWith("audio/") && !m.audio) m.audio = { data: f.data, mime: f.mime };
      else m.files = [...(m.files ?? []), f];
    }
    if (!m.text && !m.audio && !m.files) return undefined;
    return m;
  }

  private async attachment(att: TeamsAttachment, serviceUrl: string) {
    let url: string | undefined;
    let auth = false;
    let mime = att.contentType ?? "";
    if (mime === FILE_DOWNLOAD) {
      // A file from the person's OneDrive: the link is already signed.
      url = att.content?.downloadUrl;
      mime = guessMime(att.name ?? "", att.content?.fileType);
    } else if (/^(image|audio|video)\//.test(mime) && att.contentUrl) {
      url = att.contentUrl;
      // Pictures pasted in the chat are served by the Bot Connector itself, behind its token.
      auth =
        sameSite(url, serviceUrl) ||
        /\.(botframework\.com|trafficmanager\.net)$/i.test(hostOf(url));
    }
    if (!url || !/^https:\/\//.test(url)) return undefined;
    const res = await this.fetch(url, {
      ...(auth && { headers: { authorization: `Bearer ${await this.accessToken()}` } }),
    });
    if (!res.ok) throw new Error(`Teams file: ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_MEDIA) return undefined;
    return { name: att.name || `file.${mime.split("/")[1] ?? "bin"}`, data, mime };
  }

  // ---------- Outgoing ----------

  private where(chatId: string) {
    const i = chatId.lastIndexOf(SEP);
    if (i < 0) throw new Error("Teams: bad conversation");
    return {
      base: `${chatId.slice(0, i).replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(chatId.slice(i + 1))}/activities`,
    };
  }

  private async post(
    url: string,
    activity: Record<string, unknown>,
    method = "POST",
  ): Promise<string | undefined> {
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activity),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Teams ${method} activity: ${res.status} ${detail.slice(0, 300)}`.trim());
    }
    const out = (await res.json().catch(() => ({}))) as { id?: string };
    return out.id;
  }

  async send(chatId: string, text: string, buttons?: Button[]): Promise<string | undefined> {
    const { base } = this.where(chatId);
    if (!buttons?.length) return this.post(base, { type: "message", text });
    return this.post(base, {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            version: "1.4",
            body: [{ type: "TextBlock", text, wrap: true }],
            actions: buttons.map((b, i) => ({
              type: "Action.Submit",
              title: b.label,
              data: { rgButton: b.id },
              ...(i === 0 && { style: "positive" }),
            })),
          },
        },
      ],
    });
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    const { base } = this.where(chatId);
    await this.post(
      `${base}/${encodeURIComponent(messageId)}`,
      { type: "message", id: messageId, text, attachments: [] },
      "PUT",
    );
  }

  async typing(chatId: string): Promise<void> {
    await this.post(this.where(chatId).base, { type: "typing" });
  }

  async sendFile(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    const { base } = this.where(chatId);
    if (mime.startsWith("image/") && data.length <= INLINE_MAX) {
      await this.post(base, {
        type: "message",
        ...(caption && { text: caption }),
        attachments: [
          { contentType: mime, contentUrl: `data:${mime};base64,${data.toString("base64")}`, name },
        ],
      });
      return;
    }
    const now = this.now();
    for (const [k, v] of this.pending) if (v.until < now) this.pending.delete(k);
    this.seq += 1;
    const id = `f${now}.${this.seq}`;
    this.pending.set(id, { data, name, ...(caption && { caption }), until: now + 3600_000 });
    await this.post(base, {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.card.file.consent",
          name,
          content: {
            description: caption || name,
            sizeInBytes: data.length,
            acceptContext: { rgFile: id },
            declineContext: { rgFile: id },
          },
        },
      ],
    });
  }

  /** The person accepted (or refused) a file: it goes to the upload address Teams gave. */
  private async consent(a: TeamsActivity) {
    const id = a.value?.context?.rgFile;
    const file = id ? this.pending.get(id) : undefined;
    if (!id || !file) return;
    this.pending.delete(id);
    const up = a.value?.uploadInfo;
    if (a.value?.action !== "accept" || !up?.uploadUrl || !/^https:\/\//.test(up.uploadUrl)) return;
    const res = await this.fetch(up.uploadUrl, {
      method: "PUT",
      headers: {
        "content-length": String(file.data.length),
        "content-range": `bytes 0-${file.data.length - 1}/${file.data.length}`,
      },
      body: new Uint8Array(file.data),
    });
    if (!res.ok) throw new Error(`Teams file upload: ${res.status}`);
    const conv = a.conversation?.id;
    if (!conv || !a.serviceUrl) return;
    await this.post(this.where(`${a.serviceUrl}${SEP}${conv}`).base, {
      type: "message",
      ...(file.caption && { text: file.caption }),
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.card.file.info",
          contentUrl: up.contentUrl,
          name: up.name ?? file.name,
          content: { uniqueId: up.uniqueId, fileType: up.fileType },
        },
      ],
    });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string) {
  const h = hostOf(a);
  return h !== "" && h === hostOf(b);
}

const MIMES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMime(name: string, type?: string): string {
  const ext = (type || name.split(".").pop() || "").toLowerCase();
  return MIMES[ext] ?? "application/octet-stream";
}
