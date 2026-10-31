/** A slot granted to a session; `previous` is the session whose cache it held, if any. */
export interface Lease {
  slot: number;
  /** The slot already holds this session's cache: nothing to restore. */
  warm: boolean;
  previous?: string;
  release(): void;
}

interface Waiter {
  sessionId: string;
  priority: number;
  seq: number;
  grant: (lease: Lease) => void;
}

/**
 * Shares a local engine's slots among sessions. A session keeps its slot while it can
 * (its cache stays warm); when every slot is busy, requests wait by priority (God and
 * Demi-God before orchestrators, before workers), first come first served within one.
 */
export class SlotScheduler {
  private readonly owner: (string | undefined)[];
  private readonly busy: boolean[];
  private readonly lastUsed: number[];
  private readonly queue: Waiter[] = [];
  private seq = 0;
  private clock = 0;

  constructor(readonly slots: number) {
    this.owner = Array(slots).fill(undefined);
    this.busy = Array(slots).fill(false);
    this.lastUsed = Array(slots).fill(0);
  }

  holder(slot: number): string | undefined {
    return this.owner[slot];
  }

  /** Sessions currently holding a slot (to save at shutdown). */
  holders(): { slot: number; sessionId: string }[] {
    return this.owner.flatMap((s, slot) => (s ? [{ slot, sessionId: s }] : []));
  }

  acquire(sessionId: string, priority: number, signal?: AbortSignal): Promise<Lease> {
    const immediate = this.tryGrant(sessionId);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((ok, ko) => {
      const w: Waiter = { sessionId, priority, seq: this.seq++, grant: ok };
      this.queue.push(w);
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      signal?.addEventListener(
        "abort",
        () => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          ko(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private tryGrant(sessionId: string): Lease | undefined {
    // 1. Its own slot, if free. 2. An empty slot. 3. The least recently used idle slot.
    let slot = this.owner.findIndex((s, i) => s === sessionId && !this.busy[i]);
    if (slot < 0 && this.owner.some((s, i) => s === sessionId && this.busy[i])) return undefined;
    if (slot < 0) slot = this.owner.findIndex((s, i) => s === undefined && !this.busy[i]);
    if (slot < 0) {
      let best = -1;
      for (let i = 0; i < this.slots; i++) {
        if (!this.busy[i] && (best < 0 || (this.lastUsed[i] ?? 0) < (this.lastUsed[best] ?? 0)))
          best = i;
      }
      slot = best;
    }
    if (slot < 0) return undefined;
    const previous = this.owner[slot];
    const warm = previous === sessionId;
    this.owner[slot] = sessionId;
    this.busy[slot] = true;
    let released = false;
    return {
      slot,
      warm,
      ...(previous && !warm && { previous }),
      release: () => {
        if (released) return;
        released = true;
        this.busy[slot] = false;
        this.lastUsed[slot] = ++this.clock;
        this.pump();
      },
    };
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const w = this.queue[i];
      if (!w) continue;
      const lease = this.tryGrant(w.sessionId);
      if (lease) {
        this.queue.splice(i, 1);
        w.grant(lease);
        this.pump();
        return;
      }
    }
  }
}
