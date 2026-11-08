import { z } from "zod";

/**
 * A passage of an earlier message the person answers (G36.22, inline replies as in an email):
 * where it is (`seq` of the quoted event, its time, the characters as the page showed them), the
 * passage itself and the person's reply to it. Nothing in the history changes: the quotes travel
 * with the new message, and the model reads them as a clear block before the reply.
 */
export const MessageQuote = z.object({
  /** The quoted message's event (absent when the chat cannot tell, e.g. a Telegram message). */
  seq: z.number().int().nonnegative().optional(),
  /** When the quoted message was written (ISO). */
  at: z.string().max(40).optional(),
  /** Where the passage starts and ends in the message's text as the page showed it. */
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  text: z.string().min(1).max(4000),
  /** The person's answer to this passage; the message's own text comes after every quote. */
  reply: z.string().max(20_000).optional(),
});
export type MessageQuote = z.infer<typeof MessageQuote>;

export const MAX_QUOTES = 10;

/** "2026-11-08 14:32 UTC": the same text on every machine, so the history never changes. */
const when = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? iso
    : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/**
 * The text the model reads for a message with quotes: one block per quoted passage, its reply
 * under it, then the message's own text. Pure and deterministic: the live session and
 * `rebuildHistory` both build it from the event, so the cached prefix holds after a restart.
 */
export function quotedText(
  text: string,
  quotes?: readonly MessageQuote[],
  notes?: readonly string[],
): string {
  if (notes?.length) return notedText(quotedText(text, quotes), notes);
  if (!quotes?.length) return text;
  const blocks = quotes.map((q) => {
    const of = `${q.at ? ` of ${when(q.at)}` : ""}${q.seq !== undefined ? ` (event ${q.seq})` : ""}`;
    const head = `[The person replies to this passage of your message${of}. They received the whole message; this answers that passage specifically.]`;
    const body = q.text
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const reply = q.reply?.trim();
    return reply ? `${head}\n${body}\n\n${reply}` : `${head}\n${body}`;
  });
  return [...blocks, ...(text.trim() ? [text] : [])].join("\n\n");
}

/** What the person wrote in a message with quotes, without the quoted passages (memory, titles). */
export function ownWords(text: string, quotes?: readonly MessageQuote[]): string {
  return [...(quotes ?? []).map((q) => q.reply?.trim() ?? ""), text.trim()]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The note in front of a question asked «Intanto» (G36.24, Claude Code's /btw): it rides at the
 * end of a separate request with the conversation's own prefix, so the cache holds and nothing
 * enters the conversation.
 */
export const ASIDE_NOTE =
  "[RedGiant: a side question from the person while the conversation goes on. Answer it briefly from what you know of the conversation. You cannot use tools for it, and neither this question nor your answer becomes part of the conversation.]";

/** A side question and its answer, as the page shows it (from the `aside` event). */
export interface AsideView {
  id: string;
  seq: number;
  at: string;
  question: string;
  answer: string;
  model: string;
  costUsd: number;
  error?: string;
  /** «Porta nella chat» made it a normal message. */
  promoted: boolean;
}

/** At most this many RedGiant notes ride with one message (G37.1). */
export const MAX_NOTES = 20;

/**
 * A message with RedGiant's notes after it (G37.1): what changed in files the agent is editing
 * while it was away. Pure: `send`, `rebuildHistory` and the history tool write it the same way.
 */
export function notedText(text: string, notes: readonly string[]): string {
  const lines = notes.map((n) => n.trim()).filter(Boolean);
  if (!lines.length) return text;
  const block = `[RedGiant: ${lines.length === 1 ? lines[0] : `\n${lines.map((l) => `- ${l}`).join("\n")}`}]`;
  return text.trim() ? `${text}\n\n${block}` : block;
}
