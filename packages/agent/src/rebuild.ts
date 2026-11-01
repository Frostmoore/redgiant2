import type { ChatMessage, Event, UserPart } from "@redgiant/protocol";

/** A conversation message plus the sequence number of the first event it came from. */
export interface HistoryEntry {
  message: ChatMessage;
  firstSeq: number;
}

export const summaryMessage = (summary: string): ChatMessage => ({
  role: "user",
  parts: [{ type: "text", text: `Summary of the conversation so far:\n\n${summary}` }],
});

/**
 * Rebuilds the conversation of one session from its events: the log is the source of truth,
 * so a session can be resumed, forked or replayed from it at any time.
 */
export function rebuildHistory(events: Iterable<Event>): HistoryEntry[] {
  let history: HistoryEntry[] = [];
  let pendingResults: { parts: UserPart[]; firstSeq: number } | undefined;

  const flushResults = () => {
    if (pendingResults) {
      history.push({
        message: { role: "user", parts: pendingResults.parts },
        firstSeq: pendingResults.firstSeq,
      });
      pendingResults = undefined;
    }
  };

  for (const e of events) {
    if (e.payload === null) continue;
    switch (e.type) {
      case "message.user":
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
          content: e.payload.output,
          ...(!e.payload.ok && { isError: true }),
        };
        if (pendingResults) pendingResults.parts.push(part);
        else pendingResults = { parts: [part], firstSeq: e.seq };
        break;
      }
      case "compaction": {
        flushResults();
        const toSeq = e.payload.toSeq;
        history = [
          { message: summaryMessage(e.payload.summary), firstSeq: e.seq },
          ...history.filter((h) => h.firstSeq > toSeq),
        ];
        break;
      }
    }
  }
  flushResults();
  return history;
}
