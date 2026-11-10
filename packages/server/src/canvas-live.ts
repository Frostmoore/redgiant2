// What the person's canvas shows (G36.12), asked of their open pages only when an agent wants
// to know: the server sends `canvas.query` to each page of the owner, the first page that shows
// its canvas answers (`canvas.state`), and nothing travels the rest of the time.
import { randomUUID } from "node:crypto";
import type { CanvasState } from "@redgiant/protocol";

/** A page of the owner: true when the question was sent to it. */
type Asker = (ownerId: string, requestId: string) => boolean;

interface Waiting {
  ownerId: string;
  pages: number;
  answers: CanvasState[];
  done: (s: CanvasState | undefined) => void;
}

/** The answer that says most: one in view, or else the one with the most tabs (the first of equals). */
function best(answers: CanvasState[]): CanvasState | undefined {
  const shown = answers.find((a) => a.visible);
  if (shown) return shown;
  let out = answers[0];
  for (const a of answers) if (out && a.tabs.length > out.tabs.length) out = a;
  return out;
}

export class CanvasLive {
  private readonly pages = new Set<Asker>();
  private readonly waiting = new Map<string, Waiting>();

  /** A connected page listens (ws.ts); the returned function stops it. */
  onQuery(ask: Asker): () => void {
    this.pages.add(ask);
    return () => this.pages.delete(ask);
  }

  /**
   * The canvas of one of the owner's pages: the first that has it in view; when none has, the
   * one with the most tabs (p3.5.4: a second browser tab, empty, answered first and the agent
   * read «the canvas is empty» beside the person's PDF); undefined when no page is open or none
   * answers in time.
   */
  ask(ownerId: string, timeoutMs = 1500): Promise<CanvasState | undefined> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w: Waiting = {
        ownerId,
        pages: 0,
        answers: [],
        done: (s) => {
          if (timer) clearTimeout(timer);
          this.waiting.delete(requestId);
          resolve(s);
        },
      };
      this.waiting.set(requestId, w);
      for (const page of this.pages) if (page(ownerId, requestId)) w.pages++;
      if (w.pages === 0) return w.done(undefined);
      timer = setTimeout(() => w.done(best(w.answers)), timeoutMs);
    });
  }

  /** A page's answer; false when nobody waits for it (late, or another owner's). */
  answer(ownerId: string, requestId: string, state: CanvasState): boolean {
    const w = this.waiting.get(requestId);
    if (!w || w.ownerId !== ownerId) return false;
    w.answers.push(state);
    if (state.visible || w.answers.length >= w.pages) w.done(best(w.answers));
    return true;
  }
}
