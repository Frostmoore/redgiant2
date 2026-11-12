// Email for the agents (G38.1): the mailboxes the person linked (G33.3), over IMAP and SMTP. The
// same accounts and keychain entries as the routines and the knowledge (`EmailWatcher.accountOf`);
// one IMAP connection per account kept for a minute, like the knowledge's reader. Reading never
// marks a message as read (BODY.PEEK); changes happen only through the explicit calls below.

import { ImapFlow } from "imapflow";
import type { EmailAccount } from "../email.js";
import { smtpFor } from "../email.js";

export interface MailFolder {
  path: string;
  name: string;
  /** `\Inbox`, `\Sent`, `\Drafts`, `\Archive`, `\Trash`, `\Junk`, `\All`, when the server says. */
  specialUse?: string;
}

/** A search (mail_search): every field narrows it. */
export interface MailQuery {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unread?: boolean;
  flagged?: boolean;
}

/** One message as listed: its headers, flags, how many attachments, and its first bytes. */
export interface MailHit {
  uid: number;
  date: Date;
  from: string;
  to: string;
  subject: string;
  seen: boolean;
  flagged: boolean;
  attachments: number;
  size: number;
  /** The start of the raw message, for a snippet. */
  head?: Buffer;
}

/** How a mailbox is reached (IMAP for real; tests run it against a server in the process). */
export interface MailClient {
  folders(a: EmailAccount): Promise<MailFolder[]>;
  /** UIDs that match, newest first. */
  search(a: EmailAccount, folder: string, q: MailQuery): Promise<number[]>;
  /** Headers and flags of some UIDs, with the first `headBytes` of each. */
  headers(a: EmailAccount, folder: string, uids: number[], headBytes: number): Promise<MailHit[]>;
  /** The whole message, without marking it as read; undefined when it is gone. */
  source(a: EmailAccount, folder: string, uid: number): Promise<Buffer | undefined>;
  flags(
    a: EmailAccount,
    folder: string,
    uids: number[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  move(a: EmailAccount, folder: string, uids: number[], to: string): Promise<void>;
  /** Deletes for good (flag \Deleted and expunge): only after the person's yes. */
  remove(a: EmailAccount, folder: string, uids: number[]): Promise<void>;
  /** Adds a message to a folder (drafts, a copy of what was sent); its UID when the server says. */
  append(
    a: EmailAccount,
    folder: string,
    raw: Buffer,
    flags: string[],
  ): Promise<number | undefined>;
  create(a: EmailAccount, path: string): Promise<void>;
  close(): Promise<void>;
}

/** How a message leaves (SMTP for real; a server in the process in tests). */
export interface MailTransport {
  send(a: EmailAccount, envelope: { from: string; to: string[] }, raw: Buffer): Promise<void>;
}

const KEEP_MS = 60_000;

type Node = {
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: Node[];
};

/** Attachments in a body structure: parts given as attachments, or named parts that are not text. */
export function countAttachments(n: Node | undefined): number {
  if (!n) return 0;
  if (n.childNodes?.length) return n.childNodes.reduce((s, c) => s + countAttachments(c), 0);
  const named = !!(n.dispositionParameters?.filename || n.parameters?.name);
  if (n.disposition === "attachment") return 1;
  if (named && !/^text\/(plain|html)$/i.test(n.type ?? "")) return 1;
  return 0;
}

/** IMAP over imapflow, one connection per account kept for a minute. */
export function imapMailClient(): MailClient {
  const open = new Map<string, { client: ImapFlow; timer: NodeJS.Timeout }>();
  const keyOf = (a: EmailAccount) => `${a.user}@${a.host}:${a.port}`;
  const drop = async (key: string) => {
    const c = open.get(key);
    open.delete(key);
    if (c) {
      clearTimeout(c.timer);
      await c.client.logout().catch(() => {});
    }
  };
  const client = async (a: EmailAccount) => {
    const key = keyOf(a);
    const have = open.get(key);
    if (have?.client.usable) {
      have.timer.refresh();
      return have.client;
    }
    if (have) await drop(key);
    const c = new ImapFlow({
      host: a.host,
      port: a.port,
      secure: a.secure,
      auth: { user: a.user, pass: a.password },
      logger: false,
    });
    c.on("error", () => void drop(key));
    await c.connect();
    const timer = setTimeout(() => void drop(key), KEEP_MS);
    timer.unref?.();
    open.set(key, { client: c, timer });
    return c;
  };
  /** Runs `fn` with `folder` open (the lock queues the other calls on the same connection). */
  const inFolder = async <T>(
    a: EmailAccount,
    folder: string,
    fn: (c: ImapFlow) => Promise<T>,
    readOnly = false,
  ): Promise<T> => {
    const c = await client(a);
    const lock = await c.getMailboxLock(folder, { readOnly });
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  };
  const range = (uids: number[]) => uids.join(",");
  return {
    async folders(a) {
      const c = await client(a);
      return (await c.list()).map((m) => ({
        path: m.path,
        name: m.name,
        ...(m.specialUse && { specialUse: m.specialUse }),
      }));
    },
    search: (a, folder, q) =>
      inFolder(
        a,
        folder,
        async (c) => {
          const found =
            (await c.search(
              {
                ...(q.from && { from: q.from }),
                ...(q.to && { to: q.to }),
                ...(q.subject && { subject: q.subject }),
                ...(q.text && { text: q.text }),
                ...(q.since && { since: q.since }),
                ...(q.before && { before: q.before }),
                ...(q.unread !== undefined && { seen: !q.unread }),
                ...(q.flagged !== undefined && { flagged: q.flagged }),
                ...(!q.from &&
                  !q.to &&
                  !q.subject &&
                  !q.text &&
                  !q.since &&
                  !q.before &&
                  q.unread === undefined &&
                  q.flagged === undefined && { all: true }),
              },
              { uid: true },
            )) || [];
          return [...found].sort((x, y) => y - x);
        },
        true,
      ),
    headers: (a, folder, uids, headBytes) =>
      uids.length === 0
        ? Promise.resolve([])
        : inFolder(
            a,
            folder,
            async (c) => {
              const out: MailHit[] = [];
              for await (const m of c.fetch(
                range(uids),
                {
                  uid: true,
                  envelope: true,
                  flags: true,
                  size: true,
                  internalDate: true,
                  bodyStructure: true,
                  ...(headBytes > 0 && { source: { start: 0, maxLength: headBytes } }),
                },
                { uid: true },
              )) {
                const e = m.envelope;
                const who = (l?: { name?: string | undefined; address?: string | undefined }[]) =>
                  (l ?? [])
                    .map((x) => (x.name ? `${x.name} <${x.address ?? ""}>` : (x.address ?? "")))
                    .join(", ");
                out.push({
                  uid: m.uid,
                  date: new Date(e?.date ?? m.internalDate ?? 0),
                  from: who(e?.from),
                  to: who(e?.to),
                  subject: e?.subject ?? "",
                  seen: m.flags?.has("\\Seen") ?? false,
                  flagged: m.flags?.has("\\Flagged") ?? false,
                  attachments: countAttachments(m.bodyStructure as Node | undefined),
                  size: m.size ?? 0,
                  ...(m.source && { head: m.source }),
                });
              }
              return out.sort((x, y) => y.uid - x.uid);
            },
            true,
          ),
    source: (a, folder, uid) =>
      inFolder(
        a,
        folder,
        async (c) => {
          const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
          return m === false || !m.source ? undefined : m.source;
        },
        true,
      ),
    flags: (a, folder, uids, change) =>
      inFolder(a, folder, async (c) => {
        if (change.add?.length) await c.messageFlagsAdd(range(uids), change.add, { uid: true });
        if (change.remove?.length)
          await c.messageFlagsRemove(range(uids), change.remove, { uid: true });
      }),
    move: (a, folder, uids, to) =>
      inFolder(a, folder, async (c) => {
        await c.messageMove(range(uids), to, { uid: true });
      }),
    remove: (a, folder, uids) =>
      inFolder(a, folder, async (c) => {
        await c.messageDelete(range(uids), { uid: true });
      }),
    async append(a, folder, raw, flags) {
      const c = await client(a);
      const r = await c.append(folder, raw, flags);
      return r && typeof r.uid === "number" ? r.uid : undefined;
    },
    async create(a, path) {
      const c = await client(a);
      await c.mailboxCreate(path);
    },
    async close() {
      await Promise.all([...open.keys()].map(drop));
    },
  };
}

/** SMTP through nodemailer, with the mailbox's own user and password; the raw message as built. */
export const smtpTransport: MailTransport = {
  async send(a, envelope, raw) {
    const smtp = a.smtp ?? smtpFor(a);
    const { createTransport } = (await import("nodemailer")) as unknown as {
      createTransport(o: unknown): { sendMail(m: unknown): Promise<unknown>; close(): void };
    };
    const t = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: a.user, pass: a.password },
    });
    try {
      await t.sendMail({ envelope, raw });
    } finally {
      t.close();
    }
  },
};
