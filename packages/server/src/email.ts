// Routines on email (G24.14c): the person's mailbox, read over IMAP every few minutes. Only mail
// that arrived after the mailbox was set is looked at; nothing is marked as read or changed. A
// message that matches a routine starts it, the message given to the agent as data. The
// password stays in a private file, never in the database.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationService } from "@redgiant/automations";
import type { SqlClient } from "@redgiant/events";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface EmailAccount {
  host: string;
  port: number;
  /** TLS from the start (993); otherwise STARTTLS. */
  secure: boolean;
  user: string;
  password: string;
}

export interface Mail {
  uid: number;
  from: string;
  subject: string;
  date: string;
  text: string;
}

/** How the mailbox is read: IMAP for real, a fake in tests. */
export interface Mailbox {
  /** The highest UID now (to start from it), and the messages above `after`. */
  newer(account: EmailAccount, after: number | null): Promise<{ last: number; mails: Mail[] }>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
const MAX_TEXT = 20_000;

/** IMAP over imapflow: INBOX, read-only, only the messages after a UID. */
export const imapMailbox: Mailbox = {
  async newer(a, after) {
    const client = new ImapFlow({
      host: a.host,
      port: a.port,
      secure: a.secure,
      auth: { user: a.user, pass: a.password },
      logger: false,
    });
    await client.connect();
    try {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      const last = Math.max(0, Number(box.uidNext ?? 1) - 1);
      if (after === null || last <= after) return { last, mails: [] };
      const mails: Mail[] = [];
      for await (const m of client.fetch(
        `${after + 1}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        if (!m.source || m.uid <= after) continue;
        const p = await simpleParser(m.source);
        mails.push({
          uid: m.uid,
          from: p.from?.text ?? "",
          subject: p.subject ?? "",
          date: (p.date ?? new Date()).toISOString(),
          text: (p.text ?? "").slice(0, MAX_TEXT),
        });
        if (mails.length >= 50) break;
      }
      return { last: Math.max(last, ...mails.map((x) => x.uid)), mails };
    } finally {
      await client.logout().catch(() => {});
    }
  },
};

export class EmailWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly o: {
      dir: string;
      db: SqlClient;
      automations: AutomationService;
      mailbox?: Mailbox;
      /** Owners whose routines may wait for email. */
      owners: () => Promise<string[]>;
    },
  ) {}

  private file(ownerId: string) {
    return join(this.o.dir, `${safe(ownerId)}.json`);
  }

  async account(ownerId: string): Promise<EmailAccount | undefined> {
    return readFile(this.file(ownerId), "utf8")
      .then((t) => JSON.parse(t) as EmailAccount)
      .catch(() => undefined);
  }

  /** Saves the mailbox (after a test connection) and starts from the mail there is now. */
  async set(ownerId: string, a: EmailAccount): Promise<void> {
    const { last } = await (this.o.mailbox ?? imapMailbox).newer(a, null);
    await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file(ownerId), JSON.stringify(a), { mode: 0o600 });
    await chmod(this.file(ownerId), 0o600);
    await this.setLast(ownerId, last);
  }

  async remove(ownerId: string): Promise<void> {
    await rm(this.file(ownerId), { force: true });
  }

  private async last(ownerId: string): Promise<number | null> {
    const [r] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = 'email_last_uid'",
      [ownerId],
    );
    if (!r) return null;
    const v = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
    return typeof v === "number" ? v : null;
  }

  private async setLast(ownerId: string, uid: number): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, 'email_last_uid', $2)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, JSON.stringify(uid)],
    );
  }

  /** One look at every mailbox; new mail starts the routines it matches. */
  async check(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    try {
      for (const owner of await this.o.owners()) {
        const a = await this.account(owner);
        if (!a) continue;
        const waiting = (await this.o.automations.list(owner)).filter(
          (x) => x.enabled && x.recipe.on.email,
        );
        if (waiting.length === 0) continue;
        const after = await this.last(owner);
        const { last, mails } = await (this.o.mailbox ?? imapMailbox)
          .newer(a, after)
          .catch((err) => {
            console.warn(`email for ${owner}: ${(err as Error).message}`);
            return { last: after ?? 0, mails: [] as Mail[] };
          });
        for (const m of mails)
          for (const r of waiting) {
            const run = await this.o.automations.email(owner, r.id, {
              from: m.from,
              subject: m.subject,
              date: m.date,
              text: m.text,
            });
            if (run) {
              started++;
              run.done.catch(() => {});
            }
          }
        if (after === null || last > after) await this.setLast(owner, last);
      }
    } finally {
      this.running = false;
    }
    return started;
  }

  start(everyMs = 120_000): void {
    this.timer = setInterval(() => void this.check().catch(() => {}), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
