// A connected mailbox as a knowledge source (G36.6): its inbox read-only over IMAP (the same
// mailboxes as the routines, G24.14c; their passwords stay in the keychain). Listing asks only
// for UIDs, sizes and dates; each mail is read once and again only when it changes. One
// connection per mailbox is kept for a minute, so reading a thousand mails does not log in a
// thousand times. Nothing is ever marked as read, moved or deleted.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailAccount } from "../email.js";
import type { ItemRef, MailSource } from "./service.js";

/** Mails taken from one mailbox, at most (the newest first). */
const MAX_MAILS = 20_000;
const MAX_TEXT = 200_000;
const KEEP_MS = 60_000;

export interface MailAccounts {
  boxes(owner: string): Promise<{ id: string; name: string }[]>;
  accountOf(owner: string, id: string): Promise<EmailAccount | undefined>;
}

/** How IMAP is reached (a fake in tests). */
export interface ImapReader {
  list(account: EmailAccount, sinceMs: number): Promise<ItemRef[]>;
  read(
    account: EmailAccount,
    uid: number,
  ): Promise<
    { subject: string; from: string; to?: string; date: string; text: string } | undefined
  >;
  close(): Promise<void>;
}

/** IMAP over imapflow, one connection per account kept for a minute. */
export function imapReader(): ImapReader {
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
    await c.mailboxOpen("INBOX", { readOnly: true });
    const timer = setTimeout(() => void drop(key), KEEP_MS);
    timer.unref?.();
    open.set(key, { client: c, timer });
    return c;
  };
  return {
    async list(a, sinceMs) {
      const c = await client(a);
      const uids = (await c.search({ since: new Date(sinceMs) }, { uid: true })) || [];
      const newest = [...uids].sort((x, y) => y - x).slice(0, MAX_MAILS);
      if (!newest.length) return [];
      const out: ItemRef[] = [];
      for await (const m of c.fetch(
        newest.join(","),
        { uid: true, size: true, internalDate: true, envelope: true },
        { uid: true },
      ))
        out.push({
          id: String(m.uid),
          title: m.envelope?.subject?.trim() || "(no subject)",
          at: new Date(m.internalDate ?? 0).getTime(),
          size: m.size ?? 0,
        });
      return out;
    },
    async read(a, uid) {
      const c = await client(a);
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      // imapflow answers `false` for a UID that is gone.
      if (m === false || !m.source) return undefined;
      const p = await simpleParser(m.source);
      const to = Array.isArray(p.to) ? p.to.map((x) => x.text).join(", ") : p.to?.text;
      return {
        subject: p.subject ?? "",
        from: p.from?.text ?? "",
        ...(to && { to }),
        date: (p.date ?? new Date()).toISOString(),
        text: (p.text ?? "").slice(0, MAX_TEXT),
      };
    },
    async close() {
      await Promise.all([...open.keys()].map(drop));
    },
  };
}

/** The knowledge's view of the person's mailboxes. */
export function mailSource(accounts: MailAccounts, imap: ImapReader = imapReader()): MailSource {
  const account = async (owner: string, id: string) => {
    const a = await accounts.accountOf(owner, id);
    if (!a) throw new Error(`The mailbox "${id}" is gone or has no password`);
    return a;
  };
  return {
    boxes: (owner) => accounts.boxes(owner),
    list: async (owner, mailbox, sinceMs) => imap.list(await account(owner, mailbox), sinceMs),
    read: async (owner, mailbox, id) => {
      const uid = Number(id);
      if (!Number.isInteger(uid) || uid <= 0) return undefined;
      return imap.read(await account(owner, mailbox), uid);
    },
  };
}
