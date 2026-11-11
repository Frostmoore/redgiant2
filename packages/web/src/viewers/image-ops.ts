// The layered picture's actions in the page (G37.5): what the editor sends and receives, one
// batch in flight at a time (like the drawing's, svg-ops.ts), and the layers each one touches
// (others' revisions that meet the person's pending ones make the page load the picture again).
import type { ImageAction, ImagePlainAction } from "@redgiant/protocol";

export const IMAGE_ENGINE_VERSION = "1";

export const imageDocOp = (op: ImageAction) => ({
  family: "image" as const,
  engine: "redgiant-raster" as const,
  engineVersion: IMAGE_ENGINE_VERSION,
  op,
});

export const imageActionsOf = (ops: readonly { family: string; op?: unknown }[]): ImageAction[] =>
  ops.flatMap((o) => (o.family === "image" ? [o.op as ImageAction] : []));

/** The layers actions touch ("*": the whole picture). */
export function touchedLayers(list: readonly ImageAction[]): Set<string> {
  const out = new Set<string>();
  for (const a of list)
    for (const op of a.t === "batch" ? a.ops : [a])
      out.add(op.t === "add" ? op.layer.id : op.t === "canvas" ? "*" : op.layer);
  return out;
}

export interface ImageOutgoing {
  clientId: string;
  baseRevision: number;
  action: ImageAction;
  /** The gesture's group: each gesture is one undo (p3.5.7). */
  group?: string | undefined;
}

let n = 0;
const newId = () => `i${Date.now().toString(36)}${(n++).toString(36)}`;

export class ImageCollab {
  revision = 0;
  private inflight: { id: string; action: ImageAction } | undefined;
  private buffer: {
    ops: ImagePlainAction[];
    what?: string | undefined;
    filter?: string | undefined;
    group?: string | undefined;
  }[] = [];
  /** Waiting for nothing to be in flight (an undo waits for the gesture's revision). */
  private waiting: (() => void)[] = [];

  constructor(private readonly send: (o: ImageOutgoing) => void) {}

  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = [];
    this.wake();
  }

  /**
   * Resolves once every gesture made is confirmed by the host (or dropped by a reload). The
   * person's Ctrl+Z waits for it (p3.5.7, the person's test of 3.5.6: Ctrl+Z right after a
   * gesture found it still in flight, so it undid nothing, or the gesture before, refused).
   */
  idle(): Promise<void> {
    if (!this.pending) return Promise.resolve();
    return new Promise((ok) => this.waiting.push(ok));
  }

  private wake() {
    if (this.pending) return;
    const w = this.waiting;
    this.waiting = [];
    for (const ok of w) ok();
  }

  get pending(): boolean {
    return !!this.inflight || this.buffer.length > 0;
  }

  /** A gesture's actions (with what it was, for the panel's words). */
  local(ops: readonly ImagePlainAction[], what?: string, filter?: string, group?: string): void {
    if (ops.length) this.buffer.push({ ops: [...ops], what, filter, group });
  }

  flush(): void {
    if (this.inflight || !this.buffer.length) return;
    // One gesture per revision: each can be undone by itself.
    const g = this.buffer.shift() as (typeof this.buffer)[number];
    const action: ImageAction =
      g.ops.length === 1 && !g.filter
        ? (g.ops[0] as ImagePlainAction)
        : ({
            t: "batch",
            ops: g.ops,
            ...(g.what && { what: g.what }),
            ...(g.filter && { filter: g.filter }),
          } as ImageAction);
    this.inflight = { id: newId(), action };
    this.send({ clientId: this.inflight.id, baseRevision: this.revision, action, group: g.group });
  }

  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
    this.wake();
    return true;
  }

  /** Others' revision: "apply" on the page, or "reload" (not the next one, or it meets mine). */
  remote(revision: number, actions: readonly ImageAction[]): "apply" | "reload" {
    if (revision !== this.revision + 1) return "reload";
    const mine = [
      ...(this.inflight ? [this.inflight.action] : []),
      ...this.buffer.map((b) => ({ t: "batch" as const, ops: b.ops })),
    ];
    if (mine.length) {
      const a = touchedLayers(mine);
      for (const x of touchedLayers(actions))
        if (x === "*" || a.has(x) || a.has("*")) return "reload";
    }
    this.revision = revision;
    return "apply";
  }

  rejected(clientId: string): boolean {
    const mine = this.inflight?.id === clientId;
    if (mine) {
      // Refused: the page loads the picture again; nothing is waited for any more.
      this.inflight = undefined;
      this.buffer = [];
      this.wake();
    }
    return mine;
  }
}
