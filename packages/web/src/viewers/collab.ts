// The page's side of the editor (G37.1) for plain text: the person types at once in CodeMirror,
// the batch goes to the server with the revision it was made on, one batch in flight at a time.
// Others' revisions (an agent, another page) arrive in the host's order and are moved over what
// the person has not seen confirmed yet; the host moves the person's batch over them the same way
// (`a.map(b, true)` there, `b.map(a)` here: CodeMirror's guarantee that both ends agree). Pure:
// no view, no socket, tested on its own.
import { ChangeSet } from "@codemirror/state";
import type { DocChange, DocOp, TextChanges, TextDocOp } from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";

/**
 * What agents just wrote, to highlight when the file is opened after it (p3.5.3: a CSV edited
 * before the person opened it showed nothing): the agents' revisions at the head, one after the
 * other back to the first that is not theirs, made in the last `withinMs`. `max`: how many
 * revisions (text positions are true only for the head one).
 */
export function freshAgentWrites(
  changes: readonly DocChange[],
  revision: number,
  o: { now?: number; withinMs?: number; max?: number } = {},
): [number, number][] {
  const now = o.now ?? Date.now();
  const out: [number, number][] = [];
  let expect = revision;
  let n = 0;
  for (const c of changes) {
    if (c.revision !== expect || n >= (o.max ?? 50)) break;
    if (c.author === PERSON || c.replaced || c.undoneBy || c.undoOf?.length) break;
    if (now - Date.parse(c.ts) > (o.withinMs ?? 10 * 60_000)) break;
    out.push(...(c.wrote ?? []));
    expect--;
    n++;
  }
  return out;
}

export interface Outgoing {
  clientId: string;
  baseRevision: number;
  ops: DocOp[];
}

export const textOp = (c: ChangeSet): DocOp => ({
  family: "text",
  engine: "codemirror-state",
  engineVersion: "6",
  op: { changes: c.toJSON() as TextChanges },
});

const changesOf = (op: DocOp): ChangeSet => {
  if (op.family !== "text") throw new Error("Not a text operation");
  return ChangeSet.fromJSON(op.op.changes);
};

let counter = 0;
const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A batch with no answer from the host after this long: the page reads the file again (p3.5.7). */
export const ACK_WAIT_MS = 10_000;

export class TextCollab {
  /** The last revision the host confirmed to this page. */
  revision = 0;
  private inflight: { id: string; changes: ChangeSet; at: number } | undefined;
  private buffer: ChangeSet | undefined;
  /**
   * Batches sent and then let go by a `reset` before their answer (p3.5.7): the host may still
   * apply them after the text the page was given (a reconnection sends the file's `doc.open`
   * before the batches queued meanwhile). Their ack means the page lacks a revision.
   */
  private readonly dropped = new Set<string>();

  constructor(
    private readonly send: (o: Outgoing) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The file as the host has it now (opened, replaced, or after a resynchronisation). */
  reset(revision: number): void {
    this.revision = revision;
    if (this.inflight) this.dropped.add(this.inflight.id);
    if (this.dropped.size > 50) this.dropped.delete(this.dropped.values().next().value as string);
    this.inflight = undefined;
    this.buffer = undefined;
  }

  /**
   * An ack (or a refusal) for a batch a `reset` let go: true once, when it was this page's. An
   * ack of it says the host has a revision the page's text lacks: the page reads the file again.
   */
  orphan(clientId: string): boolean {
    return this.dropped.delete(clientId);
  }

  /** The batch in flight has had no answer for `ms` (an answer lost): the page reads the file again. */
  stuck(ms = ACK_WAIT_MS): boolean {
    return !!this.inflight && this.now() - this.inflight.at >= ms;
  }

  /** Whether the person has changes the host has not confirmed yet. */
  get pending(): boolean {
    return !!this.inflight || !!this.buffer;
  }

  /** The person typed: kept, and sent when nothing else is in flight. */
  local(changes: ChangeSet): void {
    if (changes.empty) return;
    this.buffer = this.buffer ? this.buffer.compose(changes) : changes;
  }

  /** Sends what waits, if nothing is in flight. */
  flush(): void {
    if (this.inflight || !this.buffer) return;
    this.inflight = { id: newId(), changes: this.buffer, at: this.now() };
    this.buffer = undefined;
    this.send({
      clientId: this.inflight.id,
      baseRevision: this.revision,
      ops: [textOp(this.inflight.changes)],
    });
  }

  /** The host confirmed the batch in flight; false when it is not this page's (resync). */
  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
    return true;
  }

  /**
   * Someone else's revision: the changes to apply to the view (moved over the person's own not
   * yet confirmed), and the ranges it wrote in the view's coordinates. Undefined when it is not
   * the next revision: the page asks for the file again.
   */
  remote(
    revision: number,
    ops: readonly DocOp[],
    wrote: readonly [number, number][] = [],
  ): { changes: ChangeSet; wrote: [number, number][] } | undefined {
    if (revision !== this.revision + 1 || ops.length === 0) return undefined;
    let r = changesOf(ops[0] as DocOp);
    for (const o of ops.slice(1)) r = r.compose(changesOf(o));
    // Over the batch in flight, then over what was typed after it.
    let view = r;
    const over: ChangeSet[] = [];
    if (this.inflight) {
      view = r.map(this.inflight.changes);
      this.inflight.changes = this.inflight.changes.map(r, true);
      over.push(this.inflight.changes);
    }
    if (this.buffer) {
      const before = view;
      view = view.map(this.buffer);
      this.buffer = this.buffer.map(before, true);
      over.push(this.buffer);
    }
    this.revision = revision;
    const moved = wrote
      .map(([f, t]): [number, number] => {
        let a = f;
        let b = t;
        for (const c of over) {
          a = c.mapPos(a, 1);
          b = c.mapPos(b, -1);
        }
        return [a, b];
      })
      .filter(([a, b]) => b > a);
    return { changes: view, wrote: moved };
  }

  /** The host refused the batch in flight: the page starts again from the host's file. */
  rejected(clientId: string): boolean {
    return this.inflight?.id === clientId;
  }
}
