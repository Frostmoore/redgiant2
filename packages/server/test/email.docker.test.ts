// The IMAP side of email routines for real (G24.14c): GreenMail in Docker, a message sent over
// SMTP, read back by imapMailbox. Run with REDGIANT_DOCKER_TESTS=1 pnpm test:docker.
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { hostname } from "node:os";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { imapMailbox } from "../src/email.js";

const on = process.env.REDGIANT_DOCKER_TESTS === "1";
const inContainer = existsSync("/.dockerenv");

/** A plain SMTP conversation, enough for GreenMail. */
async function send(port: number, to: string, subject: string, body: string) {
  await new Promise<void>((ok, ko) => {
    const sock = connect(port, "127.0.0.1");
    const lines = [
      "HELO test",
      "MAIL FROM:<billing@bank.example>",
      `RCPT TO:<${to}>`,
      "DATA",
      `From: Billing <billing@bank.example>\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.`,
      "QUIT",
    ];
    let i = 0;
    sock.on("data", () => {
      if (i < lines.length) sock.write(`${lines[i++]}\r\n`);
    });
    sock.on("close", () => ok());
    sock.on("error", ko);
  });
}

describe.skipIf(!on || !inContainer)("email routines over real IMAP", () => {
  const docker = new Docker();
  const name = `rg-greenmail-${process.pid}`;
  afterAll(async () => {
    await docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => {});
  });

  it("reads only the mail after the starting point", { timeout: 300_000 }, async () => {
    const image = "greenmail/standalone:2.1.3";
    await new Promise<void>((ok, ko) =>
      docker.pull(image, (err: unknown, s: NodeJS.ReadableStream) =>
        err ? ko(err) : docker.modem.followProgress(s, (e) => (e ? ko(e) : ok())),
      ),
    );
    const c = await docker.createContainer({
      name,
      Image: image,
      Env: [
        "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=marta:pw@example.test -Dgreenmail.verbose",
      ],
      HostConfig: { NetworkMode: `container:${hostname()}` },
    });
    await c.start();
    const account = { host: "127.0.0.1", port: 3143, secure: false, user: "marta", password: "pw" };
    let start: { last: number } | undefined;
    for (let i = 0; i < 60 && !start; i++) {
      start = await imapMailbox.newer(account, null).catch(() => undefined);
      if (!start) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(start?.last).toBe(0);
    await send(3025, "marta@example.test", "Your invoice", "Amount: 42 EUR");
    const got = await imapMailbox.newer(account, start?.last ?? 0);
    expect(got.mails).toHaveLength(1);
    expect(got.mails[0]).toMatchObject({ subject: "Your invoice" });
    expect(got.mails[0]?.from).toContain("billing@bank.example");
    expect(got.mails[0]?.text).toContain("Amount: 42 EUR");
    expect((await imapMailbox.newer(account, got.last)).mails).toEqual([]);
  });
});
