// Mail and conversations as documents (G36.6): sources the person adds only with a yes of their
// own, read through the server's mailboxes and the event log. A mail is one document (its
// headers, then its text by paragraphs); a conversation is one document whose parts are its
// messages, each opened by who wrote it and headed by its day, so a citation names the moment.

import type { Extracted, ExtractedPart } from "./types.js";

/** Most text kept from one mail or conversation. */
const MAX_ITEM_CHARS = 400_000;

export interface MailText {
  subject: string;
  from: string;
  to?: string;
  date: string;
  text: string;
}

export interface ChatText {
  title: string;
  agentName: string;
  messages: { who: "person" | "agent"; at: string; text: string }[];
}

const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso).slice(0, 10);

/** Paragraphs of a text, quoted replies («> …») and signatures («-- ») left out. */
function paragraphs(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^-- ?$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function extractMail(m: MailText): Extracted {
  const subject = m.subject.trim() || "(no subject)";
  const head = [`From: ${m.from}`, m.to ? `To: ${m.to}` : "", `Date: ${day(m.date)}`]
    .filter(Boolean)
    .join("\n");
  const parts: ExtractedPart[] = [];
  let chars = 0;
  const body = paragraphs(m.text);
  // The headers ride with the first paragraph: a search for the sender finds the mail.
  parts.push({ text: [head, body[0] ?? ""].filter(Boolean).join("\n\n"), heading: subject });
  for (const p of body.slice(1)) {
    chars += p.length;
    if (chars > MAX_ITEM_CHARS) break;
    parts.push({ text: p, heading: subject });
  }
  return { kind: "mail", title: subject, parts };
}

export function extractChat(c: ChatText): Extracted {
  const parts: ExtractedPart[] = [];
  let chars = 0;
  for (const m of c.messages) {
    const text = m.text.trim();
    if (!text) continue;
    chars += text.length;
    if (chars > MAX_ITEM_CHARS) break;
    const who = m.who === "person" ? "Person" : c.agentName;
    // The day heads the piece (messages of one day join), who wrote it opens the text.
    parts.push({ text: `${who}: ${text}`, heading: day(m.at) });
  }
  return { kind: "chat", title: c.title.trim() || `Conversation with ${c.agentName}`, parts };
}
