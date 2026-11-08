// Routines on email (G24.14c): the person's mailboxes, read over IMAP every few minutes. Only mail
// that arrived after a mailbox was set is looked at; nothing is marked as read or changed. A
// message that matches a routine starts it, the message given to the agent as data. Passwords
// are in the keychain (G36.20: `email:<id>`, moved there from the private files of before), never
// in the database; a private file only while the keychain cannot open.
//
// Many mailboxes (G33.3, the person: "infiniti indirizzi email… divisi per categoria"): each has
// a name, a category (work, personal, social, other or the person's own), its own last UID and
// its own password file. The one mailbox of older versions becomes the first of the list.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationService } from "@redgiant/automations";
import type { SqlClient } from "@redgiant/events";
import type { Mailbox as MailboxInfo } from "@redgiant/protocol";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { shredFile, type Vault } from "./vault.js";

export interface EmailAccount {
  host: string;
  port: number;
  /** TLS from the start (993); otherwise STARTTLS. */
  secure: boolean;
  user: string;
  password: string;
  /** Where it sends from (G33.3), when the person wants messages by email. */
  smtp?: { host: string; port: number; secure: boolean };
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

/** How a message leaves: SMTP for real, a fake in tests (G33.3). */
export interface MailSender {
  send(account: EmailAccount, mail: { to: string; subject: string; text: string }): Promise<void>;
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

/** SMTP through nodemailer, with the mailbox's own user and password. */
export const smtpSender: MailSender = {
  async send(a, mail) {
    const smtp = a.smtp ?? smtpFor(a);
    const { createTransport } = (await import("nodemailer")) as unknown as {
      createTransport(o: unknown): {
        sendMail(m: unknown): Promise<unknown>;
        close(): void;
      };
    };
    const t = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: a.user, pass: a.password },
    });
    try {
      await t.sendMail({ from: a.user, to: mail.to, subject: mail.subject, text: mail.text });
    } finally {
      t.close();
    }
  },
};

/** The usual sending server of a mailbox: imap.x → smtp.x, TLS on 465. */
export function smtpFor(a: Pick<EmailAccount, "host">): {
  host: string;
  port: number;
  secure: boolean;
} {
  return { host: a.host.replace(/^imap\./i, "smtp."), port: 465, secure: true };
}

/** What the person writes for a mailbox: the account and how they call and file it. */
export type MailboxInput = EmailAccount & { name: string; category: string };

/** What is kept in the database about a mailbox (no password). */
type Stored = Omit<MailboxInfo, "smtp"> & { smtp?: EmailAccount["smtp"] };

export class EmailWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Owners whose mailbox of an older version was looked for. */
  private readonly migrated = new Set<string>();

  constructor(
    private readonly o: {
      dir: string;
      db: SqlClient;
      automations: AutomationService;
      mailbox?: Mailbox;
      sender?: MailSender;
      /** Owners whose routines may wait for email. */
      owners: () => Promise<string[]>;
      /** Where the passwords are kept (G36.20); without it, or while it is closed, private files. */
      vault?: Vault;
    },
  ) {}

  private keyOf(id: string) {
    return `email:${id}`;
  }

  private metaOf(box: Pick<Stored, "id" | "name" | "user" | "host" | "smtp">) {
    const smtp = box.smtp?.host ?? smtpFor({ host: box.host }).host;
    return {
      name: `email-${box.name}`,
      service: box.name,
      brand: "email",
      category: "email" as const,
      username: box.user,
      hosts: [...new Set([box.host.toLowerCase(), smtp.toLowerCase()])],
      inject: { header: "", format: "{value}" },
      section: "automations",
      kind: "email" as const,
      what: box.user,
    };
  }

  /**
   * At startup (G36.20): every mailbox's password still in a private file goes to the keychain,
   * is read back, and only then the file is destroyed. Nothing happens while it is closed.
   */
  async moveSecretsToVault(): Promise<number> {
    if (!this.o.vault?.ready) return 0;
    let n = 0;
    for (const owner of await this.o.owners().catch(() => []))
      for (const b of await this.boxes(owner).catch(() => []))
        if (await this.moveOne(owner, b)) n++;
    return n;
  }

  private async moveOne(ownerId: string, box: Stored): Promise<boolean> {
    const vault = this.o.vault;
    if (!vault?.ready) return false;
    const file = this.secretFile(ownerId, box.id);
    const password = await readFile(file, "utf8")
      .then((t) => (JSON.parse(t) as { password?: string }).password)
      .catch(() => undefined);
    if (password === undefined) return false;
    const key = this.keyOf(box.id);
    if (vault.systemValue(ownerId, key) !== password)
      await vault.setSystem(ownerId, key, password, this.metaOf(box));
    if (!(await vault.verifySystem(ownerId, new Map([[key, password]])))) return false;
    await shredFile(file);
    await vault.recordMoved(ownerId, [key], `email/${box.id}.json`);
    return true;
  }

  /** The single mailbox of older versions. */
  private oldFile(ownerId: string) {
    return join(this.o.dir, `${safe(ownerId)}.json`);
  }

  private secretFile(ownerId: string, id: string) {
    return join(this.o.dir, safe(ownerId), `${safe(id)}.json`);
  }

  private async setting<T>(ownerId: string, key: string): Promise<T | undefined> {
    const [r] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = $2",
      [ownerId, key],
    );
    if (!r) return undefined;
    return (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as T;
  }

  private async setSetting(ownerId: string, key: string, value: unknown): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, key, JSON.stringify(value)],
    );
  }

  private async dropSetting(ownerId: string, key: string): Promise<void> {
    await this.o.db.query("DELETE FROM rg_settings WHERE owner_id = $1 AND key = $2", [
      ownerId,
      key,
    ]);
  }

  /**
   * The mailbox of an older version (one file, one `email_last_uid`) becomes the first of the
   * list, with its own password file and last UID; nothing of it is lost.
   */
  private async migrate(ownerId: string): Promise<void> {
    if (this.migrated.has(ownerId)) return;
    const old = await readFile(this.oldFile(ownerId), "utf8")
      .then((t) => JSON.parse(t) as EmailAccount)
      .catch(() => undefined);
    if (old) {
      const list = (await this.setting<Stored[]>(ownerId, "email_boxes")) ?? [];
      const id = `box_${randomUUID().slice(0, 8)}`;
      const last = await this.setting<number>(ownerId, "email_last_uid");
      await this.writeSecret(
        ownerId,
        { id, name: old.user, user: old.user, host: old.host },
        old.password,
      );
      await this.setSetting(ownerId, "email_boxes", [
        {
          id,
          name: old.user,
          category: "personal",
          host: old.host,
          port: old.port,
          secure: old.secure,
          user: old.user,
          createdAt: new Date().toISOString(),
        },
        ...list,
      ]);
      if (typeof last === "number") await this.setLast(id, ownerId, last);
      await this.dropSetting(ownerId, "email_last_uid");
      await rm(this.oldFile(ownerId), { force: true });
    }
    this.migrated.add(ownerId);
  }

  private async writeSecret(
    ownerId: string,
    box: Pick<Stored, "id" | "name" | "user" | "host" | "smtp">,
    password: string,
  ) {
    const id = box.id;
    if (this.o.vault?.ready) {
      await this.o.vault.setSystem(ownerId, this.keyOf(id), password, this.metaOf(box));
      await shredFile(this.secretFile(ownerId, id));
      return;
    }
    const dir = join(this.o.dir, safe(ownerId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = this.secretFile(ownerId, id);
    await writeFile(file, JSON.stringify({ password }), { mode: 0o600 });
    await chmod(file, 0o600);
  }

  private async password(ownerId: string, id: string): Promise<string | undefined> {
    const vault = this.o.vault;
    const kept = vault?.systemValue(ownerId, this.keyOf(id));
    if (kept !== undefined) return kept;
    const password = await readFile(this.secretFile(ownerId, id), "utf8")
      .then((t) => (JSON.parse(t) as { password?: string }).password)
      .catch(() => undefined);
    // A file of before, found while the keychain is open: moved there now.
    if (password !== undefined && vault?.ready) {
      const box = ((await this.setting<Stored[]>(ownerId, "email_boxes")) ?? []).find(
        (b) => b.id === id,
      );
      if (box) await this.moveOne(ownerId, box).catch(() => false);
    }
    return password;
  }

  /** Every mailbox of the person, oldest first. */
  async boxes(ownerId: string): Promise<MailboxInfo[]> {
    await this.migrate(ownerId);
    return (await this.setting<Stored[]>(ownerId, "email_boxes")) ?? [];
  }

  /** A mailbox with its password, for reading or sending. */
  async accountOf(ownerId: string, id: string): Promise<EmailAccount | undefined> {
    const box = (await this.boxes(ownerId)).find((b) => b.id === id);
    if (!box) return undefined;
    const password = await this.password(ownerId, id);
    if (password === undefined) return undefined;
    return {
      host: box.host,
      port: box.port,
      secure: box.secure,
      user: box.user,
      password,
      ...(box.smtp && { smtp: box.smtp }),
    };
  }

  /** The first mailbox (what older versions called "the mailbox"). */
  async account(ownerId: string): Promise<EmailAccount | undefined> {
    const [first] = await this.boxes(ownerId);
    return first ? this.accountOf(ownerId, first.id) : undefined;
  }

  /**
   * Adds a mailbox after a test connection; it starts from the mail there is now. Its password
   * goes to a private file.
   */
  async add(ownerId: string, i: MailboxInput): Promise<MailboxInfo> {
    const list = await this.boxes(ownerId);
    const { last } = await (this.o.mailbox ?? imapMailbox).newer(i, null);
    const id = `box_${randomUUID().slice(0, 8)}`;
    const box: Stored = {
      id,
      name: i.name.trim() || i.user,
      category: i.category.trim() || "other",
      host: i.host,
      port: i.port,
      secure: i.secure,
      user: i.user,
      ...(i.smtp && { smtp: i.smtp }),
      createdAt: new Date().toISOString(),
    };
    await this.writeSecret(ownerId, box, i.password);
    await this.setSetting(ownerId, "email_boxes", [...list, box]);
    await this.setLast(id, ownerId, last);
    return box;
  }

  /**
   * Changes a mailbox. A new server, user or password is tried first (the password stays when
   * none is given); its name and category change at once.
   */
  async update(
    ownerId: string,
    id: string,
    i: Partial<MailboxInput> & { smtp?: EmailAccount["smtp"] | null },
  ): Promise<MailboxInfo> {
    const list = await this.boxes(ownerId);
    const box = list.find((b) => b.id === id);
    if (!box) throw new MailboxNotFoundError(`Mailbox "${id}" not found`);
    const password = i.password ?? (await this.password(ownerId, id)) ?? "";
    const account: EmailAccount = {
      host: i.host ?? box.host,
      port: i.port ?? box.port,
      secure: i.secure ?? box.secure,
      user: i.user ?? box.user,
      password,
    };
    const moved =
      account.host !== box.host ||
      account.port !== box.port ||
      account.user !== box.user ||
      i.password !== undefined;
    if (moved) {
      const { last } = await (this.o.mailbox ?? imapMailbox).newer(account, null);
      if (i.password !== undefined)
        await this.writeSecret(
          ownerId,
          { ...box, host: account.host, user: account.user, name: i.name?.trim() || box.name },
          i.password,
        );
      // Another mailbox (or the same one moved): its UIDs start again from now.
      if (account.host !== box.host || account.user !== box.user)
        await this.setLast(id, ownerId, last);
    }
    const { smtp: _old, ...rest } = box;
    const smtp = i.smtp === null ? undefined : (i.smtp ?? box.smtp);
    const next: Stored = {
      ...rest,
      host: account.host,
      port: account.port,
      secure: account.secure,
      user: account.user,
      ...(i.name !== undefined && { name: i.name.trim() || account.user }),
      ...(i.category !== undefined && { category: i.category.trim() || "other" }),
      ...(smtp && { smtp }),
    };
    await this.setSetting(
      ownerId,
      "email_boxes",
      list.map((b) => (b.id === id ? next : b)),
    );
    return next;
  }

  /** Removes one mailbox, its password file and its last UID. */
  async removeBox(ownerId: string, id: string): Promise<void> {
    const list = await this.boxes(ownerId);
    if (!list.some((b) => b.id === id)) throw new MailboxNotFoundError(`Mailbox "${id}" not found`);
    await this.setSetting(
      ownerId,
      "email_boxes",
      list.filter((b) => b.id !== id),
    );
    await rm(this.secretFile(ownerId, id), { force: true });
    if (this.o.vault?.ready) await this.o.vault.setSystem(ownerId, this.keyOf(id), null);
    await this.dropSetting(ownerId, `email_last_uid:${id}`);
  }

  /** Older versions' "set the mailbox": the first one changes, or becomes the first. */
  async set(ownerId: string, a: EmailAccount): Promise<void> {
    const [first] = await this.boxes(ownerId);
    if (first) await this.update(ownerId, first.id, a);
    else await this.add(ownerId, { ...a, name: a.user, category: "personal" });
  }

  /** Older versions' "remove the mailbox": the first one goes. */
  async remove(ownerId: string): Promise<void> {
    const [first] = await this.boxes(ownerId);
    if (first) await this.removeBox(ownerId, first.id);
  }

  /** The categories in use and the default ones, for the editor. */
  async categories(ownerId: string): Promise<string[]> {
    const used = (await this.boxes(ownerId)).map((b) => b.category);
    return [...new Set(["work", "personal", "social", "other", ...used])];
  }

  private async last(id: string, ownerId: string): Promise<number | null> {
    const v = await this.setting<unknown>(ownerId, `email_last_uid:${id}`);
    return typeof v === "number" ? v : null;
  }

  private async setLast(id: string, ownerId: string, uid: number): Promise<void> {
    await this.setSetting(ownerId, `email_last_uid:${id}`, uid);
  }

  /**
   * Sends a run's message by email (G33.3): from the chosen mailbox (or the first one), to the
   * given address (or the mailbox's own). Returns the address.
   */
  async send(
    ownerId: string,
    mail: { subject: string; text: string; to?: string; box?: string },
  ): Promise<string> {
    const boxes = await this.boxes(ownerId);
    const box = mail.box ? boxes.find((b) => b.id === mail.box) : boxes[0];
    if (!box) throw new Error(mail.box ? `no mailbox "${mail.box}"` : "no mailbox connected");
    const account = await this.accountOf(ownerId, box.id);
    if (!account) throw new Error(`the password of ${box.name} is missing`);
    const to = mail.to ?? box.user;
    await (this.o.sender ?? smtpSender).send(account, {
      to,
      subject: mail.subject,
      text: mail.text,
    });
    return to;
  }

  /** One look at every mailbox; new mail starts the routines it matches. */
  async check(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    try {
      for (const owner of await this.o.owners()) {
        const boxes = await this.boxes(owner);
        if (boxes.length === 0) continue;
        const waiting = (await this.o.automations.list(owner)).filter(
          (x) => x.enabled && x.recipe.on.email,
        );
        if (waiting.length === 0) continue;
        for (const box of boxes) {
          // Only the mailboxes some routine watches are read.
          const watched = waiting.filter((x) => {
            const f = x.recipe.on.email;
            if (!f?.boxes && !f?.categories) return true;
            return (
              (f.boxes?.includes(box.id) ?? false) ||
              (f.categories?.includes(box.category) ?? false)
            );
          });
          if (watched.length === 0) continue;
          const a = await this.accountOf(owner, box.id);
          if (!a) continue;
          const after = await this.last(box.id, owner);
          const { last, mails } = await (this.o.mailbox ?? imapMailbox)
            .newer(a, after)
            .catch((err) => {
              console.warn(`email ${box.name} for ${owner}: ${(err as Error).message}`);
              return { last: after ?? 0, mails: [] as Mail[] };
            });
          for (const m of mails)
            for (const r of watched) {
              const run = await this.o.automations.email(owner, r.id, {
                from: m.from,
                subject: m.subject,
                date: m.date,
                text: m.text,
                box: { id: box.id, name: box.name, category: box.category },
              });
              if (run) {
                started++;
                run.done.catch(() => {});
              }
            }
          if (after === null || last > after) await this.setLast(box.id, owner, last);
        }
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

export class MailboxNotFoundError extends Error {}
