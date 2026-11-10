// What the person's canvas shows (G36.12), asked of their open pages only when an agent wants
// to know: the server sends `canvas.query` to each page of the owner, the first page that shows
// its canvas answers (`canvas.state`), and nothing travels the rest of the time.
//
// p3.5.6 (the person's test of 3.5.5): canvas_look said «no page open» beside an open page with
// the layered image editor or the 3D editor. A page busy loading an editor (or a server busy
// writing a big file) answered after the 1.5 s deadline, and a page between two connections
// counted as none. Now a page that is connected but silent is waited for longer, a page that was
// connected a moment ago is waited for while it comes back, and when none answers in time the
// agent gets the last answer of that person's page with its age, never «no page open».
import { randomUUID } from "node:crypto";
import type { CanvasState } from "@redgiant/protocol";

/** A page of the owner: true when the question was sent to it. */
type Asker = (ownerId: string, requestId: string) => boolean;

/** What an agent learns of the person's canvas. */
export interface CanvasSeen {
  /** The canvas, fresh or the last one known (see `ageMs`); undefined when nothing is known. */
  state?: CanvasState | undefined;
  /** How many of the person's pages were asked (0: none is open). */
  pages: number;
  /** Set when no page answered in time: how old `state` is (the page's last answer). */
  ageMs?: number | undefined;
}

export interface CanvasAskTimes {
  /** After this, the answers in hand are enough (default 2500 ms). */
  soft?: number;
  /** A page connected but silent is waited for until this (default 6000 ms). */
  hard?: number;
  /** A page that was connected lately is waited for this long to come back (default 2000 ms). */
  reconnect?: number;
}

interface Waiting {
  ownerId: string;
  asked: Set<Asker>;
  answers: CanvasState[];
  done: (s: CanvasSeen) => void;
}

/** The answer that says most: one in view, or else the one with the most tabs (the first of equals). */
function best(answers: CanvasState[]): CanvasState | undefined {
  const shown = answers.find((a) => a.visible);
  if (shown) return shown;
  let out = answers[0];
  for (const a of answers) if (out && a.tabs.length > out.tabs.length) out = a;
  return out;
}

/** A page's last answer is kept this long, to stand in for a page too busy to answer now. */
const LAST_KEPT_MS = 10 * 60_000;
/** A page gone this recently is likely coming back (a reload, a connection dropped and remade). */
const BACK_SOON_MS = 60_000;

export class CanvasLive {
  private readonly pages = new Map<Asker, string | undefined>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly last = new Map<string, { state: CanvasState; at: number }>();
  private readonly gone = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A connected page listens (ws.ts); the returned function stops it. With its owner, a question
   * already waiting reaches it at once (a page that just came back).
   */
  onQuery(ask: Asker, ownerId?: string): () => void {
    this.pages.set(ask, ownerId);
    if (ownerId)
      for (const [requestId, w] of this.waiting)
        if (w.ownerId === ownerId && !w.asked.has(ask) && ask(ownerId, requestId)) w.asked.add(ask);
    return () => {
      this.pages.delete(ask);
      if (ownerId) this.gone.set(ownerId, this.now());
    };
  }

  /**
   * The canvas of one of the owner's pages: the first that has it in view; when none has, the
   * one with the most tabs (p3.5.4: a second browser tab, empty, answered first and the agent
   * read «the canvas is empty» beside the person's PDF); undefined when no page is open or none
   * answers in time.
   */
  async ask(ownerId: string, times?: CanvasAskTimes): Promise<CanvasState | undefined> {
    const seen = await this.see(ownerId, times);
    return seen.ageMs === undefined ? seen.state : undefined;
  }

  /** The canvas as `ask` finds it, and how: how many pages were asked, how old the answer is. */
  see(ownerId: string, times: CanvasAskTimes = {}): Promise<CanvasSeen> {
    const soft = times.soft ?? 2500;
    const hard = Math.max(soft, times.hard ?? 6000);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const w: Waiting = {
        ownerId,
        asked: new Set(),
        answers: [],
        done: (s) => {
          for (const t of timers) clearTimeout(t);
          if (!this.waiting.delete(requestId)) return;
          if (s.state && s.ageMs === undefined)
            this.last.set(ownerId, { state: s.state, at: this.now() });
          resolve(s);
        },
      };
      this.waiting.set(requestId, w);
      for (const page of this.pages.keys()) if (page(ownerId, requestId)) w.asked.add(page);
      const picked = (): CanvasSeen => ({ state: best(w.answers), pages: w.asked.size });
      // What stands in when no page answers: the last answer, said with its age.
      const fallback = (): CanvasSeen => {
        const got = this.last.get(ownerId);
        return got && this.now() - got.at <= LAST_KEPT_MS
          ? { state: got.state, pages: w.asked.size, ageMs: this.now() - got.at }
          : { pages: w.asked.size };
      };
      if (w.asked.size === 0) {
        const left = this.gone.get(ownerId);
        // No page now, and none lately: no page is open.
        if (left === undefined || this.now() - left > BACK_SOON_MS) return w.done({ pages: 0 });
        // A page just went (a reload, a connection remade): it is waited for a moment.
        timers.push(
          setTimeout(() => {
            if (w.asked.size === 0) w.done(fallback());
          }, times.reconnect ?? 2000),
        );
      }
      // The answers in hand are enough after `soft`; with none yet, the pages are given until
      // `hard` (a page busy loading an editor). Each check runs after the I/O already waiting
      // (setImmediate): a server busy for a while must not read its own lateness as silence.
      timers.push(
        setTimeout(
          () =>
            setImmediate(() => {
              if (w.answers.length > 0) w.done(picked());
            }),
          soft,
        ),
        setTimeout(
          () => setImmediate(() => w.done(w.answers.length > 0 ? picked() : fallback())),
          hard,
        ),
      );
    });
  }

  /** A page's answer; false when nobody waits for it (late, or another owner's). */
  answer(ownerId: string, requestId: string, state: CanvasState): boolean {
    const w = this.waiting.get(requestId);
    if (!w || w.ownerId !== ownerId) {
      // Late, but the page's latest word: kept to stand in when it cannot answer in time.
      if (state.visible || !this.last.get(ownerId)?.state.visible)
        this.last.set(ownerId, { state, at: this.now() });
      return false;
    }
    w.answers.push(state);
    if (state.visible || w.answers.length >= w.asked.size)
      w.done({ state: best(w.answers), pages: w.asked.size });
    return true;
  }
}
