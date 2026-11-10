// The person's Ctrl+Z in the editors that undo through the host (G37.1: drawings, layered
// pictures, 3D models): their own revisions, the latest gesture first, every revision of it at
// once (a drag sends a batch every moment: p3.5.6, one Ctrl+Z took back only its last moment);
// Ctrl+Shift+Z takes the undo back. An agent's change is undone with «Annulla questa modifica»
// (the panel, or the highlight while it lasts), as in the text editor. Pure: tested on its own.
import type { DocChange } from "@redgiant/protocol";

/** What to ask the host: one revision, or a gesture's revisions (its group). */
export type UndoAsk = { revision: number } | { groupId: string };

export class OwnUndo {
  private readonly done: { revision: number; group: string }[] = [];
  private readonly undone: number[] = [];
  private readonly asked = new Map<number, "undo" | "redo">();

  /** One of the person's revisions, confirmed by the host. */
  made(revision: number, group: string): void {
    this.done.push({ revision, group });
    this.undone.length = 0;
  }

  /** Ctrl+Z: the person's last gesture, or nothing to undo. */
  undo(): UndoAsk | undefined {
    const last = this.done.pop();
    if (!last) return undefined;
    const all = [last];
    while (this.done.at(-1)?.group === last.group) all.push(this.done.pop() as typeof last);
    for (const x of all) this.asked.set(x.revision, "undo");
    return all.length === 1 ? { revision: last.revision } : { groupId: last.group };
  }

  /** Ctrl+Shift+Z: the last undo taken back. */
  redo(): UndoAsk | undefined {
    const r = this.undone.pop();
    if (r === undefined) return undefined;
    this.asked.set(r, "redo");
    return { revision: r };
  }

  /** A revision the host told: the person's undo or redo is remembered for the next key. */
  changed(c: Pick<DocChange, "revision" | "undoOf">): void {
    let kind: "undo" | "redo" | undefined;
    for (const r of c.undoOf ?? []) {
      const k = this.asked.get(r);
      if (!k) continue;
      this.asked.delete(r);
      kind = k;
    }
    if (kind === "undo") this.undone.push(c.revision);
    else if (kind === "redo") this.done.push({ revision: c.revision, group: `redo:${c.revision}` });
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }
}
