// A mailbox in the process for the email tests (G38.1): Hoodiecrow (an IMAP server made for client
// tests, by imapflow's authors) and smtp-server (nodemailer's), both on 127.0.0.1 with free ports,
// nothing written to disk. Never a real mailbox.
import type { AddressInfo } from "node:net";
// @ts-expect-error: Hoodiecrow has no types.
import hoodiecrow from "hoodiecrow-imap";
import { ImapFlow } from "imapflow";
import { SMTPServer } from "smtp-server";

export interface SentMail {
  from: string;
  to: string[];
  raw: string;
}

export const USER = "testuser@example.test";
export const PASSWORD = "testpass";

/** A message as the server keeps it: headers and a text, or a whole raw message. */
export function rawMail(m: {
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  references?: string;
  date?: string;
  attachment?: { name: string; type: string; content: string };
}): string {
  const head = [
    `From: ${m.from}`,
    `To: ${m.to ?? "Marta <marta@example.test>"}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${m.subject}`,
    `Message-ID: ${m.messageId ?? `<${Math.random().toString(36).slice(2)}@example.test>`}`,
    ...(m.references ? [`References: ${m.references}`] : []),
    `Date: ${m.date ?? "Mon, 02 Nov 2026 10:00:00 +0000"}`,
    "MIME-Version: 1.0",
  ];
  const part = m.html
    ? `Content-Type: text/html; charset=utf-8\r\n\r\n${m.html}`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${m.text ?? ""}`;
  if (!m.attachment) return `${head.join("\r\n")}\r\n${part}`;
  const b = "XXBOUNDARYXX";
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    part,
    `--${b}`,
    `Content-Type: ${m.attachment.type}; name="${m.attachment.name}"`,
    `Content-Disposition: attachment; filename="${m.attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.attachment.content).toString("base64"),
    `--${b}--`,
    "",
  ].join("\r\n");
}

export async function mailServers(o: { inbox?: { raw: string; flags?: string[] }[] } = {}) {
  const imap = hoodiecrow({
    plugins: ["ID", "ENABLE", "UIDPLUS", "MOVE", "SPECIAL-USE", "UNSELECT", "IDLE"],
    id: { name: "hoodiecrow" },
    users: { [USER]: { password: PASSWORD } },
    storage: {
      INBOX: { messages: (o.inbox ?? []).map((m) => ({ raw: m.raw, flags: m.flags ?? [] })) },
      "": {
        separator: "/",
        folders: {
          Drafts: { "special-use": "\\Drafts", messages: [] },
          Sent: { "special-use": "\\Sent", messages: [] },
          Archive: { "special-use": "\\Archive", messages: [] },
          Trash: { "special-use": "\\Trash", messages: [] },
        },
      },
    },
  });
  await new Promise<void>((ok) => imap.listen(0, "127.0.0.1", ok));
  const imapPort = (imap.server.address() as AddressInfo).port;
  const sent: SentMail[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      cb(null, { user: auth.username });
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        sent.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        cb();
      });
    },
  });
  await new Promise<void>((ok) => smtp.listen(0, "127.0.0.1", () => ok()));
  const smtpPort = (smtp.server.address() as AddressInfo).port;
  const account = {
    host: "127.0.0.1",
    port: imapPort,
    secure: false,
    user: USER,
    password: PASSWORD,
    smtp: { host: "127.0.0.1", port: smtpPort, secure: false },
  };
  /** What a folder holds now, read with a client of its own. */
  const folder = async (path: string) => {
    const c = new ImapFlow({
      host: "127.0.0.1",
      port: imapPort,
      secure: false,
      auth: { user: USER, pass: PASSWORD },
      logger: false,
    });
    await c.connect();
    const out: { uid: number; flags: string[]; raw: string }[] = [];
    const lock = await c.getMailboxLock(path);
    try {
      if ((c.mailbox && typeof c.mailbox === "object" ? c.mailbox.exists : 0) > 0)
        for await (const m of c.fetch("1:*", { uid: true, flags: true, source: true }))
          out.push({ uid: m.uid, flags: [...(m.flags ?? [])], raw: m.source?.toString() ?? "" });
    } finally {
      lock.release();
      await c.logout();
    }
    return out;
  };
  return {
    account,
    imapPort,
    smtpPort,
    sent,
    folder,
    close: async () => {
      await new Promise<void>((ok) => smtp.close(() => ok()));
      await new Promise<void>((ok) => imap.close(() => ok()));
    },
  };
}
