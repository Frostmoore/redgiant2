import type { ChatMessage, Event, UserPart } from "@redgiant/protocol";
import { trimResult, withoutReasoning } from "./compaction.js";

/** A conversation message plus the sequence number of the first event it came from. */
export interface HistoryEntry {
  message: ChatMessage;
  firstSeq: number;
}

export const summaryMessage = (summary: string): ChatMessage => ({
  role: "user",
  parts: [{ type: "text", text: `Summary of the conversation so far:\n\n${summary}` }],
});

export interface RebuildOptions {
  /** Tool results longer than this are cut as they enter the history (default: never). */
  maxResultChars?: number;
}

/**
 * Rebuilds the conversation of one session from its events: the log is the source of truth,
 * so a session can be resumed, forked or replayed from it at any time. The result must be
 * byte for byte the history the live session had, or the first turn after a restart would
 * miss the cache: whatever the session does to a message, this does too.
 */
export function rebuildHistory(events: Iterable<Event>, o: RebuildOptions = {}): HistoryEntry[] {
  const all = [...events];
  // Undone compactions never happened, as far as the history is concerned.
  const undone = new Set(
    all.flatMap((e) =>
      e.type === "compaction.undone" && e.payload ? [e.payload.compactionSeq] : [],
    ),
  );
  let history: HistoryEntry[] = [];
  let pendingResults: { parts: UserPart[]; images: UserPart[]; firstSeq: number } | undefined;

  const flushResults = () => {
    if (pendingResults) {
      // Pictures follow every result of the group, as the session put them.
      history.push({
        message: { role: "user", parts: [...pendingResults.parts, ...pendingResults.images] },
        firstSeq: pendingResults.firstSeq,
      });
      pendingResults = undefined;
    }
  };

  for (const e of all) {
    if (e.payload === null) continue;
    switch (e.type) {
      case "message.user":
        // Written while the agent worked: it rides with the tool results it followed.
        if (e.payload.steer && pendingResults) {
          pendingResults.images.push(
            { type: "text", text: e.payload.text },
            ...(e.payload.images ?? []),
          );
          break;
        }
        flushResults();
        history.push({
          message: {
            role: "user",
            parts: [{ type: "text", text: e.payload.text }, ...(e.payload.images ?? [])],
          },
          firstSeq: e.seq,
        });
        break;
      case "message.assistant":
        flushResults();
        history.push({
          message: {
            role: "assistant",
            parts: e.payload.parts,
            ...(e.payload.native !== undefined && { native: e.payload.native }),
          },
          firstSeq: e.seq,
        });
        break;
      case "tool.result": {
        const part: UserPart = {
          type: "tool_result",
          callId: e.payload.callId,
          content:
            o.maxResultChars !== undefined
              ? trimResult(e.payload.output, o.maxResultChars)
              : e.payload.output,
          ...(!e.payload.ok && { isError: true }),
        };
        const images = e.payload.images ?? [];
        if (pendingResults) {
          pendingResults.parts.push(part);
          pendingResults.images.push(...images);
        } else pendingResults = { parts: [part], images: [...images], firstSeq: e.seq };
        break;
      }
      case "compaction": {
        if (undone.has(e.seq)) break;
        flushResults();
        const toSeq = e.payload.toSeq;
        const stripped = e.payload.stripped === true;
        history = [
          { message: summaryMessage(e.payload.summary), firstSeq: e.seq },
          ...history
            .filter((h) => h.firstSeq > toSeq)
            .map((h) => (stripped ? { ...h, message: withoutReasoning(h.message) } : h)),
        ];
        break;
      }
    }
  }
  flushResults();
  return history;
}
