// Email for the agents (G38.1): searching, reading (attachments too), drafting, sending and
// filing mail in the mailboxes the person opened to the agents (Settings, a mailbox's «Agents may
// use it»). The accounts and passwords are the routines' (`EmailWatcher`, keychain `email:<id>`);
// nothing here keeps a password. What an email says is data: every answer wraps it (protocol's
// `formatMailList`/`formatMailMessage`). Sending always goes through the person's approval with
// the message prepared here first (`prepare`), and `send` sends only what was approved.

import { randomUUID } from "node:crypto";
import {
  formatMailList,
  formatMailMessage,
  type MailAttachmentInfo,
  type Mailbox as MailboxInfo,
  type MailSummary,
  type PreparedMail,
} from "@redgiant/protocol";
import { type AddressObject, simpleParser } from "mailparser";
import type { EmailAccount } from "../email.js";
import type { MailClient, MailFolder, MailQuery, MailTransport } from "./client.js";

/** The person's mailboxes and their passwords (the routines' `EmailWatcher`). */
export interface MailAccounts {
  boxes(owner: string): Promise<MailboxInfo[]>;
  accountOf(owner: string, id: string): Promise<EmailAccount | undefined>;
}

/** Files of the agent's workspace: attachments to send, and where saved ones go. */
export interface MailFiles {
  read(path: string): Promise<{ name: string; content: Buffer; type: string }>;
  /** Writes a file (a new name if one is there); returns the path written. */
  save(path: string, content: Buffer): Promise<string>;
}

export class MailError extends Error {}

const MAX_LIST = 50;
const MAX_BODY = 60_000;
const MAX_SEND_BYTES = 20 * 1024 * 1024;
const MAX_SAVE_BYTES = 50 * 1024 * 1024;
const SNIPPET_BYTES = 16_384;

/** What the model may call a folder, and the special use it means. */
const ALIASES: Record<string, string> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Drafts",
  draft: "\\Drafts",
  archive: "\\Archive",
  trash: "\\Trash",
  bin: "\\Trash",
  junk: "\\Junk",
  spam: "\\Junk",
  all: "\\All",
};

/** The usual names of the special folders, for servers that do not mark them. */
const NAMES: Record<string, string[]> = {
  "\\Sent": [
    "sent",
    "sent items",
    "sent mail",
    "sent messages",
    "posta inviata",
    "inviata",
    "inviati",
    "elementi inviati",
  ],
  "\\Drafts": ["drafts", "draft", "bozze"],
  "\\Archive": ["archive", "archives", "archivio"],
  "\\Trash": ["trash", "deleted items", "deleted messages", "bin", "cestino", "posta eliminata"],
  "\\Junk": ["junk", "spam", "posta indesiderata", "junk e-mail"],
};

/** Where the special folder is, by its mark or its usual names. */
export function specialFolder(folders: MailFolder[], use: string): MailFolder | undefined {
  if (use === "\\Inbox") return folders.find((f) => f.path.toUpperCase() === "INBOX");
  return (
    folders.find((f) => f.specialUse === use) ??
    folders.find((f) => (NAMES[use] ?? []).includes(f.name.toLowerCase())) ??
    folders.find((f) => (NAMES[use] ?? []).includes(f.path.toLowerCase()))
  );
}

/** A folder as the model wrote it: its path, its name, or inbox/sent/drafts/archive/trash/junk. */
export function resolveFolder(folders: MailFolder[], ref: string | undefined): string {
  const w = (ref ?? "").trim();
  if (!w || w.toUpperCase() === "INBOX") return "INBOX";
  const low = w.toLowerCase();
  const exact =
    folders.find((f) => f.path === w) ??
    folders.find((f) => f.path.toLowerCase() === low) ??
    folders.find((f) => f.name.toLowerCase() === low);
  if (exact) return exact.path;
  const use = ALIASES[low];
  const special = use ? specialFolder(folders, use) : undefined;
  if (special) return special.path;
  throw new MailError(
    `There is no folder "${w}". The folders are: ${folders.map((f) => f.path).join(", ")}.`,
  );
}

/** A bare address of "Name <a@b.c>" or "a@b.c". */
export const bareAddress = (s: string) =>
  (s.match(/<([^<>]+)>\s*$/)?.[1] ?? s).trim().toLowerCase();
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const addressList = (o: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(o) ? o : o ? [o] : [])
    .flatMap((x) => x.value)
    .filter((v) => v.address)
    .map((v) => (v.name ? `${v.name} <${v.address}>` : (v.address as string)));

const asList = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? v.split(/[,;]/) : []).map((x) => x.trim()).filter(Boolean);

const safeName = (s: string) =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
    .join("")
    .replace(/^\.+/, "_")
    .slice(0, 120) || "attachment";

/** A day as the model writes it (2026-11-02), or a full date. */
function day(v: string | undefined, what: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new MailError(`${what} is not a date: "${v}" (2026-11-02).`);
  return d;
}

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** The text of a message: its plain part, or its HTML made into clean text by the parser. */
const bodyOf = (p: { text?: string | undefined; html?: string | false | undefined }) =>
  (p.text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Sending in moderation (G38.1): so many an hour and a day, per person. */
export class SendLimiter {
  private readonly sent = new Map<string, number[]>();
  constructor(
    private readonly o: { perHour: number; perDay: number; now?: () => number } = {
      perHour: 20,
      perDay: 100,
    },
  ) {}
  private now() {
    return this.o.now?.() ?? Date.now();
  }
  /** Why no more may leave now, or undefined. */
  blocked(owner: string): string | undefined {
    const now = this.now();
    const times = (this.sent.get(owner) ?? []).filter((t) => now - t < 86_400_000);
    this.sent.set(owner, times);
    if (times.filter((t) => now - t < 3_600_000).length >= this.o.perHour)
      return `${this.o.perHour} emails were sent in the last hour, the most allowed: wait, or tell the person.`;
    if (times.length >= this.o.perDay)
      return `${this.o.perDay} emails were sent in the last day, the most allowed: tell the person.`;
    return undefined;
  }
  record(owner: string) {
    this.sent.set(owner, [...(this.sent.get(owner) ?? []), this.now()]);
  }
}

/** What a mail_draft or mail_send is asked to write. */
export interface ComposeInput {
  mailbox?: string | undefined;
  draft_id?: number | undefined;
  reply_to?: number | undefined;
  reply_all?: boolean | undefined;
  forward?: number | undefined;
  folder?: string | undefined;
  to?: string | string[] | undefined;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  attachments?: string[] | undefined;
}

/** A message with its attachments' contents, before it becomes MIME. */
interface Composed {
  box: MailboxInfo;
  account: EmailAccount;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  files: { name: string; type: string; content: Buffer }[];
  inReplyTo?: string;
  references?: string[];
  draft?: number;
}

/** What the person sees and approves: the message without the attachments' bytes. */
export function preparedOf(c: Composed): PreparedMail {
  return {
    mailbox: c.box.name,
    from: c.from,
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    body: c.body,
    attachments: c.files.map((f) => ({ name: f.name, size: f.content.length, type: f.type })),
    ...(c.inReplyTo && { inReplyTo: c.inReplyTo }),
    ...(c.draft !== undefined && { draft: c.draft }),
  };
}

/** MIME of a message (nodemailer's composer); a draft keeps its Bcc, a sent message does not. */
async function mime(c: Composed, o: { keepBcc: boolean; messageId?: string }): Promise<Buffer> {
  const { default: MailComposer } = (await import("nodemailer/lib/mail-composer")) as unknown as {
    default: new (
      m: unknown,
    ) => { compile(): { keepBcc: boolean; build(cb: (e: Error | null, b: Buffer) => void): void } };
  };
  const node = new MailComposer({
    from: c.from,
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    text: c.body,
    ...(o.messageId && { messageId: o.messageId }),
    ...(c.inReplyTo && { inReplyTo: c.inReplyTo }),
    ...(c.references?.length && { references: c.references }),
    attachments: c.files.map((f) => ({
      filename: f.name,
      content: f.content,
      contentType: f.type,
    })),
  }).compile();
  node.keepBcc = o.keepBcc;
  return new Promise((ok, ko) => node.build((e, b) => (e ? ko(e) : ok(b))));
}

/** JSON with sorted keys and no undefined: the same message compares equal however it travelled. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x)
              .filter(([, y]) => y !== undefined)
              .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0))
              .map(([k, y]) => [k, sort(y)]),
          )
        : x;
  return JSON.stringify(sort(v));
}

/** Servers that keep a copy of what is sent by themselves: no second copy in Sent. */
const SAVES_SENT = /(^|\.)(gmail\.com|googlemail\.com|outlook\.com|office365\.com|hotmail\.com)$/i;

export class MailService {
  readonly limiter: SendLimiter;
  constructor(
    private readonly o: {
      accounts: MailAccounts;
      client: MailClient;
      transport: MailTransport;
      limiter?: SendLimiter;
    },
  ) {
    this.limiter = o.limiter ?? new SendLimiter();
  }

  async close(): Promise<void> {
    await this.o.client.close();
  }

  /** The mailboxes the person opened to the agents. */
  async open(owner: string): Promise<MailboxInfo[]> {
    return (await this.o.accounts.boxes(owner).catch(() => [])).filter((b) => b.agents === true);
  }

  /** A mailbox by id, name or address (the first one open when none is given), with its account. */
  async mailbox(
    owner: string,
    ref: string | undefined,
  ): Promise<{ box: MailboxInfo; account: EmailAccount }> {
    const all = await this.o.accounts.boxes(owner).catch(() => [] as MailboxInfo[]);
    const open = all.filter((b) => b.agents === true);
    if (open.length === 0)
      throw new MailError(
        all.length === 0
          ? "No mailbox is connected. The person adds one in Settings > Automations > Mailboxes, then switches on «Agents may use it»."
          : "No mailbox is open to the agents. The person can switch on «Agents may use it» for a mailbox in Settings > Automations > Mailboxes.",
      );
    const w = (ref ?? "").trim().toLowerCase();
    const box = w
      ? open.find(
          (b) =>
            b.id.toLowerCase() === w || b.name.toLowerCase() === w || b.user.toLowerCase() === w,
        )
      : open[0];
    if (!box) {
      const closed = all.find((b) => b.name.toLowerCase() === w || b.user.toLowerCase() === w);
      throw new MailError(
        closed
          ? `The mailbox "${closed.name}" is not open to the agents: only the person can open it (Settings > Automations > Mailboxes).`
          : `There is no mailbox "${ref}". Open to you: ${open.map((b) => `"${b.name}" (${b.user})`).join(", ")}.`,
      );
    }
    const account = await this.o.accounts.accountOf(owner, box.id);
    if (!account) throw new MailError(`The password of "${box.name}" is missing: ask the person.`);
    return { box, account };
  }

  private async folders(a: EmailAccount) {
    return this.o.client.folders(a);
  }

  /** A special folder, made when the server has none (Drafts, Archive). */
  private async special(a: EmailAccount, use: string, make: string): Promise<string> {
    const found = specialFolder(await this.folders(a), use);
    if (found) return found.path;
    await this.o.client.create(a, make);
    return make;
  }

  /** mail_search. */
  async search(
    owner: string,
    i: {
      mailbox?: string | undefined;
      folder?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      subject?: string | undefined;
      text?: string | undefined;
      since?: string | undefined;
      before?: string | undefined;
      unread?: boolean | undefined;
      flagged?: boolean | undefined;
      has_attachment?: boolean | undefined;
      limit?: number | undefined;
    },
  ): Promise<string> {
    const { box, account } = await this.mailbox(owner, i.mailbox);
    const folder = resolveFolder(await this.folders(account), i.folder);
    const q: MailQuery = {
      ...(i.from && { from: i.from }),
      ...(i.to && { to: i.to }),
      ...(i.subject && { subject: i.subject }),
      ...(i.text && { text: i.text }),
      ...(i.unread !== undefined && { unread: i.unread }),
      ...(i.flagged !== undefined && { flagged: i.flagged }),
    };
    const since = day(i.since, "since");
    const before = day(i.before, "before");
    if (since) q.since = since;
    if (before) q.before = before;
    const limit = Math.min(Math.max(i.limit ?? 20, 1), MAX_LIST);
    const uids = await this.o.client.search(account, folder, q);
    // With has_attachment the structure decides: a few more are looked at, never the whole box.
    const look = i.has_attachment === undefined ? uids.slice(0, limit) : uids.slice(0, limit * 5);
    let hits = await this.o.client.headers(account, folder, look, SNIPPET_BYTES);
    if (i.has_attachment !== undefined)
      hits = hits.filter((h) => h.attachments > 0 === i.has_attachment).slice(0, limit);
    const mails: MailSummary[] = [];
    for (const h of hits) {
      const snippet = h.head
        ? await simpleParser(h.head)
            .then((p) => bodyOf(p).replace(/\s+/g, " ").slice(0, 200))
            .catch(() => "")
        : "";
      mails.push({
        id: h.uid,
        date: when(h.date),
        from: h.from,
        ...(h.to && { to: h.to }),
        subject: h.subject,
        unread: !h.seen,
        ...(h.flagged && { flagged: true }),
        attachments: h.attachments,
        ...(snippet && { snippet }),
      });
    }
    const total = i.has_attachment === undefined ? uids.length : mails.length;
    return formatMailList({ mailbox: box.name, address: box.user, folder }, total, mails);
  }

  /** The parsed message, or an error the model can act on. */
  private async parsed(account: EmailAccount, folder: string, uid: number) {
    const raw = await this.o.client.source(account, folder, uid);
    if (!raw) throw new MailError(`There is no message ${uid} in ${folder}: search again.`);
    return simpleParser(raw);
  }

  /** mail_read; with `save` the attachments go into the workspace. */
  async read(
    owner: string,
    i: {
      mailbox?: string | undefined;
      folder?: string | undefined;
      id: number;
      save_attachments?: boolean | undefined;
    },
    files?: MailFiles,
  ): Promise<string> {
    const { box, account } = await this.mailbox(owner, i.mailbox);
    const folder = resolveFolder(await this.folders(account), i.folder);
    const p = await this.parsed(account, folder, i.id);
    const attachments: MailAttachmentInfo[] = [];
    for (const a of p.attachments) {
      const name = safeName(a.filename ?? `attachment-${attachments.length + 1}`);
      const info: MailAttachmentInfo = {
        name,
        type: a.contentType || "application/octet-stream",
        size: a.size ?? a.content.length,
      };
      if (i.save_attachments && files) {
        if (a.content.length > MAX_SAVE_BYTES)
          throw new MailError(`${name} is larger than 50 MB: it was not saved.`);
        info.saved = await files.save(
          `mail-attachments/${safeName(folder)}-${i.id}/${name}`,
          a.content,
        );
      }
      attachments.push(info);
    }
    if (i.save_attachments && !files)
      throw new MailError("This agent has no folder to save attachments in.");
    let body = bodyOf(p);
    if (body.length > MAX_BODY)
      body = `${body.slice(0, MAX_BODY)}\n[… cut: the message goes on for ${body.length - MAX_BODY} more characters]`;
    return formatMailMessage({
      id: i.id,
      folder,
      mailbox: box.name,
      from: addressList(p.from).join(", "),
      to: addressList(p.to).join(", "),
      ...(addressList(p.cc).length && { cc: addressList(p.cc).join(", ") }),
      date: when(p.date ?? new Date()),
      subject: p.subject ?? "",
      ...(p.messageId && { messageId: p.messageId }),
      attachments,
      body,
    });
  }

  /**
   * The message a mail_draft or mail_send writes, whole: a draft as it is, or the fields, a reply
   * (to the sender, or to all; quoted, with In-Reply-To and References) or a forward (with the
   * original's attachments), plus files from the workspace.
   */
  async compose(
    owner: string,
    i: ComposeInput,
    files?: MailFiles,
    update = false,
  ): Promise<Composed> {
    const { box, account } = await this.mailbox(owner, i.mailbox);
    const own = box.user.includes("@") ? box.user : "";
    const base: Composed = {
      box,
      account,
      from: own || box.user,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      files: [],
    };
    if (i.draft_id !== undefined) {
      const drafts = await this.special(account, "\\Drafts", "Drafts");
      const p = await this.parsed(account, drafts, i.draft_id).catch(() => {
        throw new MailError(`There is no draft ${i.draft_id}: make one with mail_draft.`);
      });
      base.to = addressList(p.to);
      base.cc = addressList(p.cc);
      base.bcc = addressList(p.bcc);
      base.subject = p.subject ?? "";
      base.body = bodyOf(p);
      base.files = p.attachments.map((a) => ({
        name: safeName(a.filename ?? "attachment"),
        type: a.contentType || "application/octet-stream",
        content: a.content,
      }));
      if (p.inReplyTo) base.inReplyTo = p.inReplyTo;
      const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
      if (refs.length) base.references = refs;
      base.draft = i.draft_id;
      if (!update) {
        const extra = (
          ["to", "cc", "bcc", "subject", "body", "attachments", "reply_to", "forward"] as const
        ).filter((k) => i[k] !== undefined);
        if (extra.length)
          throw new MailError(
            `A draft is sent as it is: change it with mail_draft (draft_id ${i.draft_id}) first, then send it (${extra.join(", ")} given).`,
          );
        return base;
      }
    }
    let quoted = "";
    const original = i.reply_to ?? i.forward;
    if (original !== undefined) {
      if (i.reply_to !== undefined && i.forward !== undefined)
        throw new MailError("Either reply_to or forward, not both.");
      const folder = resolveFolder(await this.folders(account), i.folder);
      const p = await this.parsed(account, folder, original);
      const from = addressList(p.from);
      const subject = p.subject ?? "";
      const date = when(p.date ?? new Date());
      const text = bodyOf(p);
      if (i.reply_to !== undefined) {
        const to = addressList(p.replyTo).length ? addressList(p.replyTo) : from;
        base.to = to;
        if (i.reply_all) {
          const mine = bareAddress(own);
          const seen = new Set([mine, ...to.map(bareAddress)]);
          base.cc = [...addressList(p.to), ...addressList(p.cc)].filter((x) => {
            const b = bareAddress(x);
            if (seen.has(b)) return false;
            seen.add(b);
            return true;
          });
        }
        base.subject = /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
        if (p.messageId) base.inReplyTo = p.messageId;
        const refs = Array.isArray(p.references)
          ? p.references
          : p.references
            ? [p.references]
            : [];
        base.references = [...refs, ...(p.messageId ? [p.messageId] : [])];
        quoted = `\n\nOn ${date}, ${from.join(", ")} wrote:\n${text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`;
      } else {
        base.subject = /^(fwd?|i):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
        quoted = [
          "",
          "",
          "---------- Forwarded message ----------",
          `From: ${from.join(", ")}`,
          `Date: ${date}`,
          `Subject: ${subject}`,
          `To: ${addressList(p.to).join(", ")}`,
          "",
          text,
        ].join("\n");
        base.files = p.attachments.map((a) => ({
          name: safeName(a.filename ?? "attachment"),
          type: a.contentType || "application/octet-stream",
          content: a.content,
        }));
        if (p.messageId) base.references = [p.messageId];
      }
    }
    const next: Composed = {
      ...base,
      ...(i.to !== undefined && { to: asList(i.to) }),
      ...(i.cc !== undefined && { cc: asList(i.cc) }),
      ...(i.bcc !== undefined && { bcc: asList(i.bcc) }),
      ...(i.subject !== undefined && { subject: i.subject }),
      ...((i.body !== undefined || quoted) && {
        body: `${i.body ?? (update ? base.body : "")}${quoted}`,
      }),
    };
    if (i.attachments !== undefined) {
      if (!files) throw new MailError("This agent has no folder to attach files from.");
      const kept = original !== undefined ? base.files : [];
      const added = [];
      for (const path of i.attachments) added.push(await files.read(path));
      next.files = [...kept, ...added];
    }
    for (const a of [...next.to, ...next.cc, ...next.bcc])
      if (!ADDRESS.test(bareAddress(a))) throw new MailError(`"${a}" is not an email address.`);
    const bytes = next.files.reduce((s, f) => s + f.content.length, 0);
    if (bytes > MAX_SEND_BYTES)
      throw new MailError(
        `The attachments weigh ${Math.round(bytes / 1048576)} MB: at most 20 MB can go by email.`,
      );
    return next;
  }

  /** mail_draft: a new draft in the Drafts folder, or one changed (the old one is replaced). */
  async draft(owner: string, i: ComposeInput, files?: MailFiles): Promise<string> {
    const c = await this.compose(owner, i, files, true);
    const drafts = await this.special(c.account, "\\Drafts", "Drafts");
    const messageId = `<${randomUUID()}@redgiant.draft>`;
    const raw = await mime(c, { keepBcc: true, messageId });
    let uid = await this.o.client.append(c.account, drafts, raw, ["\\Draft", "\\Seen"]);
    if (uid === undefined)
      [uid] = await this.o.client.search(c.account, drafts, { text: messageId.slice(1, -1) });
    if (i.draft_id !== undefined)
      await this.o.client.remove(c.account, drafts, [i.draft_id]).catch(() => {});
    const p = preparedOf(c);
    return [
      `${i.draft_id !== undefined ? "Changed" : "Saved"} the draft${uid !== undefined ? ` ${uid}` : ""} in ${drafts} of "${c.box.name}"${
        uid !== undefined
          ? `: send it with mail_send and draft_id ${uid}, or change it with mail_draft and draft_id ${uid}.`
          : "."
      } The person sees it in their mail too.`,
      `To: ${p.to.join(", ") || "(nobody yet)"}${p.cc.length ? ` | Cc: ${p.cc.join(", ")}` : ""}${p.bcc.length ? ` | Bcc: ${p.bcc.join(", ")}` : ""}`,
      `Subject: ${p.subject || "(none)"}`,
      ...(p.attachments.length
        ? [`Attachments: ${p.attachments.map((a) => a.name).join(", ")}`]
        : []),
    ].join("\n");
  }

  /** The message mail_send will send, prepared for the person's approval. */
  async prepare(owner: string, i: ComposeInput, files?: MailFiles): Promise<PreparedMail> {
    const why = this.limiter.blocked(owner);
    if (why) throw new MailError(why);
    const c = await this.compose(owner, i, files);
    if (c.to.length + c.cc.length + c.bcc.length === 0)
      throw new MailError("Nobody to send it to: give to (or reply_to).");
    if (!ADDRESS.test(bareAddress(c.from)))
      throw new MailError(
        `"${c.box.name}" signs in as "${c.box.user}", which is not an email address: there is nothing to send from. The person can change the user in Settings > Automations > Mailboxes.`,
      );
    if (!c.subject.trim() && !c.body.trim())
      throw new MailError("The email is empty: give a subject or a body.");
    return preparedOf(c);
  }

  /**
   * mail_send, after the person's yes: the message is prepared again and must be the one they
   * approved (nothing changed in between); then it leaves, a copy goes to Sent and a sent draft
   * is removed.
   */
  async send(
    owner: string,
    i: ComposeInput,
    approved: PreparedMail | undefined,
    files?: MailFiles,
  ): Promise<string> {
    if (!approved)
      throw new MailError(
        "This email was not prepared for the person's approval: call mail_send directly (not from a script).",
      );
    const why = this.limiter.blocked(owner);
    if (why) throw new MailError(why);
    const c = await this.compose(owner, i, files);
    const now = preparedOf(c);
    if (canonical(now) !== canonical(approved))
      throw new MailError(
        "The email changed after the person approved it: nothing was sent. Call mail_send again.",
      );
    const raw = await mime(c, { keepBcc: false });
    const to = [...c.to, ...c.cc, ...c.bcc].map(bareAddress);
    await this.o.transport.send(c.account, { from: bareAddress(c.from), to }, raw);
    this.limiter.record(owner);
    const notes: string[] = [];
    if (!SAVES_SENT.test(c.account.host)) {
      const sent = specialFolder(await this.folders(c.account).catch(() => []), "\\Sent");
      if (sent)
        await this.o.client
          .append(c.account, sent.path, raw, ["\\Seen"])
          .catch(() => notes.push("A copy could not be saved in Sent."));
    }
    if (c.draft !== undefined) {
      const drafts = await this.special(c.account, "\\Drafts", "Drafts").catch(() => undefined);
      if (drafts) await this.o.client.remove(c.account, drafts, [c.draft]).catch(() => {});
    }
    return [`Sent "${c.subject}" from "${c.box.name}" to ${to.join(", ")}.`, ...notes].join(" ");
  }

  /** mail_move: read/unread, flag/unflag, archive, trash, a folder, or deleted for good. */
  async move(
    owner: string,
    i: {
      mailbox?: string | undefined;
      folder?: string | undefined;
      ids: number[];
      action: "read" | "unread" | "flag" | "unflag" | "archive" | "trash" | "move" | "delete";
      to?: string | undefined;
    },
  ): Promise<string> {
    const { box, account } = await this.mailbox(owner, i.mailbox);
    const folders = await this.folders(account);
    const folder = resolveFolder(folders, i.folder);
    const n = `${i.ids.length} message${i.ids.length === 1 ? "" : "s"}`;
    const c = this.o.client;
    switch (i.action) {
      case "read":
        await c.flags(account, folder, i.ids, { add: ["\\Seen"] });
        return `Marked ${n} as read in ${folder} of "${box.name}".`;
      case "unread":
        await c.flags(account, folder, i.ids, { remove: ["\\Seen"] });
        return `Marked ${n} as unread in ${folder} of "${box.name}".`;
      case "flag":
        await c.flags(account, folder, i.ids, { add: ["\\Flagged"] });
        return `Flagged ${n} in ${folder} of "${box.name}".`;
      case "unflag":
        await c.flags(account, folder, i.ids, { remove: ["\\Flagged"] });
        return `Unflagged ${n} in ${folder} of "${box.name}".`;
      case "delete":
        await c.remove(account, folder, i.ids);
        return `Deleted ${n} for good from ${folder} of "${box.name}".`;
      default: {
        const to =
          i.action === "archive"
            ? await this.special(account, "\\Archive", "Archive")
            : i.action === "trash"
              ? specialFolder(folders, "\\Trash")?.path
              : resolveFolder(folders, i.to);
        if (!to)
          throw new MailError(
            i.action === "trash"
              ? `"${box.name}" has no bin folder: move them to a folder instead.`
              : "Say where: to.",
          );
        if (to === folder) return `The messages are already in ${folder}.`;
        await c.move(account, folder, i.ids, to);
        return `Moved ${n} from ${folder} to ${to} in "${box.name}".`;
      }
    }
  }
}
