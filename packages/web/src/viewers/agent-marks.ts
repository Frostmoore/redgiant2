// An agent's change highlighted in an editor (G37.1, p3.5.6): told to the shell while it lasts
// (it offers «Annulla questa modifica» on it), and gone only once no agent is editing the file
// anymore and the person could see it a while (viewers/seen.ts). The person's test of 3.5.5: the
// highlights went while «God sta modificando» was still shown, and nothing undid them. An undo of
// one of the file's changes counts the time of the others again (p3.5.7).
import type { DocFile } from "@redgiant/protocol";
import { agentEditingNow, docView, markChange, onKeepMarks, unmarkChange } from "../state.js";
import { afterSeen, elementShown, HIGHLIGHT_SEEN_MS } from "./seen.js";

/**
 * Holds the highlight of `revision`: `fade` is called when it goes. Returns a function that
 * drops it at once (the editor closes, the change was undone).
 */
export function holdMark(
  file: DocFile,
  revision: number,
  el: () => Element | null | undefined,
  fade: () => void,
): () => void {
  markChange(file, revision);
  let live = true;
  const cancel = afterSeen(
    HIGHLIGHT_SEEN_MS,
    () => {
      live = false;
      off();
      unmarkChange(file, revision);
      fade();
    },
    elementShown(el),
    () => agentEditingNow(docView(file).value),
  );
  // One of the file's changes undone (p3.5.7): the highlights left stay while the person goes
  // through them, counted again from the undo.
  const off = onKeepMarks(file, cancel.restart);
  return () => {
    if (!live) return;
    live = false;
    off();
    cancel();
    unmarkChange(file, revision);
  };
}
