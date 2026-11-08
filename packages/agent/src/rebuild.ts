import { type ChatMessage, type Event, quotedText, type UserPart } from "@redgiant/protocol";
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
  // Calls of the last assistant message still without a result (2026-11-05: RedGiant stopped in
  // the middle of tools). They get one, or the API would refuse the conversation.
  let open: { callId: string; seq: number }[] = [];
  const closeOpen = () => {
    for (const c of open) {
      const part: UserPart = {
        type: "tool_result",
        callId: c.callId,
        content:
          "Interrupted: RedGiant stopped before this call finished. Check its effect before doing it again.",
        isError: true,
      };
      if (pendingResults) pendingResults.parts.push(part);
      else pendingResults = { parts: [part], images: [], firstSeq: c.seq };
    }
    open = [];
  };

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
        if (e.payload.steer && pendingResults && open.length === 0) {
          pendingResults.images.push(
            { type: "text", text: quotedText(e.payload.text, e.payload.quotes, e.payload.notes) },
            ...(e.payload.images ?? []),
          );
          break;
        }
        closeOpen();
        flushResults();
        history.push({
          message: {
            role: "user",
            parts: [
              { type: "text", text: quotedText(e.payload.text, e.payload.quotes, e.payload.notes) },
              ...(e.payload.images ?? []),
            ],
          },
          firstSeq: e.seq,
        });
        break;
      case "message.assistant":
        closeOpen();
        flushResults();
        open = e.payload.parts.flatMap((p) =>
          p.type === "tool_call" ? [{ callId: p.callId, seq: e.seq }] : [],
        );
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
        open = open.filter((c) => c.callId !== e.payload.callId);
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
  closeOpen();
  flushResults();
  return history;
}
