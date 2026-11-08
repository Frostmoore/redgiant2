// The page's side of the editor (G37.1) for plain text: the person types at once in CodeMirror,
// the batch goes to the server with the revision it was made on, one batch in flight at a time.
// Others' revisions (an agent, another page) arrive in the host's order and are moved over what
// the person has not seen confirmed yet; the host moves the person's batch over them the same way
// (`a.map(b, true)` there, `b.map(a)` here: CodeMirror's guarantee that both ends agree). Pure:
// no view, no socket, tested on its own.
import { ChangeSet } from "@codemirror/state";
import type { DocOp, TextChanges } from "@redgiant/protocol";

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

export class TextCollab {
  /** The last revision the host confirmed to this page. */
  revision = 0;
  private inflight: { id: string; changes: ChangeSet } | undefined;
  private buffer: ChangeSet | undefined;

  constructor(private readonly send: (o: Outgoing) => void) {}

  /** The file as the host has it now (opened, replaced, or after a resynchronisation). */
  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = undefined;
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
    this.inflight = { id: newId(), changes: this.buffer };
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
