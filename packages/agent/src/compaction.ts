// Compaction, the pure parts (G24.14, on the model of VS Code): how big a message is, where the
// old part ends and the recent turns kept word for word begin, what a kept turn loses (its
// reasoning, which belonged to a conversation that no longer exists), how a huge tool result is
// cut, and the summary prompt.
import type { ChatMessage } from "@redgiant/protocol";
import type { HistoryEntry } from "./rebuild.js";

/** A rough token count: about 3.5 characters per token, an image a thousand. */
export function estimateTokens(m: ChatMessage): number {
  let chars = 0;
  let images = 0;
  for (const p of m.parts) {
    if (p.type === "text" || p.type === "thinking") chars += p.text.length;
    else if (p.type === "tool_call")
      chars += p.name.length + JSON.stringify(p.input ?? null).length;
    else if (p.type === "tool_result") chars += p.content.length;
    else if (p.type === "image") images++;
  }
  return Math.ceil(chars / 3.5) + images * 1000 + 4;
}

/** A user message that starts a turn: text from the person, not tool results. */
const startsTurn = (h: HistoryEntry) =>
  h.message.role === "user" && !h.message.parts.some((p) => p.type === "tool_result");

/**
 * Where the kept tail begins: the earliest start of a turn whose tail fits in `keepTokens`.
 * Never inside a turn (a tool call stays with its result), and something is always left to
 * summarise. `history.length` when nothing can be kept.
 */
export function keepFrom(history: HistoryEntry[], keepTokens: number): number {
  let tokens = 0;
  let best = history.length;
  for (let i = history.length - 1; i >= 1; i--) {
    tokens += estimateTokens((history[i] as HistoryEntry).message);
    if (tokens > keepTokens) break;
    if (startsTurn(history[i] as HistoryEntry)) best = i;
  }
  return best;
}

/**
 * A kept turn without its reasoning: thinking blocks are bound to the conversation that made
 * them, and after a summary that conversation is gone. Text and tool calls stay as they were.
 */
export function withoutReasoning(m: ChatMessage): ChatMessage {
  if (m.role !== "assistant") return m;
  return { role: "assistant", parts: m.parts.filter((p) => p.type !== "thinking") };
}

/**
 * A tool result too long for the window: its start and end stay (40 % and 60 %), the middle
 * is left in the log, where conversation_history finds it.
 */
export function trimResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n\n[… ${content.length - maxChars} characters cut here; the whole output is in this conversation's log: read it with conversation_history …]\n\n${content.slice(-tail)}`;
}

export const COMPACTION_PROMPT = `Do not call any tool now. The conversation is getting long: write a summary that will replace the older messages, for your own future use. The most recent turns stay word for word after it, so focus on what came before them. If there is a previous summary, build on it: keep what still matters, do not start from scratch.

First think in <analysis>…</analysis>: go through the conversation in order and note the person's requests and intentions, your decisions, the files and commands involved, the errors and how they were fixed.

Then write <summary>…</summary> with these sections:
1. Goal: what the person asked, in their words where it matters.
2. Technical basis: technologies, conventions, constraints agreed.
3. Files and code: the files read or changed and why, with the important snippets.
4. Problems solved: errors met and their fixes.
5. Progress: what is done and verified.
6. Work in progress: what was being done right before this summary.
7. Last operations: the latest tool calls and their results.
8. Next steps: what to do next, in order, with anything the person still has to answer.

Tasks, plans and board threads live outside the chat: name the open ones you know of. Exact details left out can be found later with conversation_history.`;

/** The summary without its analysis, when the model wrote one. */
export function summaryText(raw: string): string {
  const m = raw.match(/<summary>([\s\S]*?)(<\/summary>|$)/);
  return (m?.[1] ?? raw.replace(/<analysis>[\s\S]*?<\/analysis>/, "")).trim();
}
