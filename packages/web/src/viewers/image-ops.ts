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
  }[] = [];

  constructor(private readonly send: (o: ImageOutgoing) => void) {}

  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = [];
  }

  get pending(): boolean {
    return !!this.inflight || this.buffer.length > 0;
  }

  /** A gesture's actions (with what it was, for the panel's words). */
  local(ops: readonly ImagePlainAction[], what?: string, filter?: string): void {
    if (ops.length) this.buffer.push({ ops: [...ops], what, filter });
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
    this.send({ clientId: this.inflight.id, baseRevision: this.revision, action });
  }

  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
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
    return this.inflight?.id === clientId;
  }
}
