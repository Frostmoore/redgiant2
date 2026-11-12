// The frame of artifacts and widgets, on the page's side (3.5.9, study §4.3): the page listens only
// to its own frame (`event.source === iframe.contentWindow`, the origin is "null"), checks every
// message's shape, and answers only that window. The one thing a frame may ask is «send to chat»
// (`ui/message`), taken as the person's only right after a real click in that frame.
import {
  ARTIFACT_CLICK_MS,
  type ArtifactError,
  FrameMessage,
  frameMessageText,
} from "@redgiant/protocol";

/** A frame's message, if it is one of ours and comes from that frame. */
export function frameMessage(
  e: { source: unknown; data: unknown },
  frame: { contentWindow: unknown } | null | undefined,
): FrameMessage | undefined {
  if (!frame || !e.source || e.source !== frame.contentWindow) return undefined;
  const r = FrameMessage.safeParse(e.data);
  return r.success ? r.data : undefined;
}

/**
 * The click rule (study §4.3): the page sees a click in a frame as its own `blur` with the frame
 * as `document.activeElement`; a message within 1.5 s of it is the person's, one per click.
 * When focus already sits in the frame (the person typed in it, then pressed a button) no `blur`
 * comes: then the browser's own user activation, which a frame's code cannot fake and which
 * reaches the page from a click in its frames, counts once, and not again for 5 s.
 */
export class ClickGuard {
  private clickedAt = -Infinity;
  private used = true;
  private lastActivated = -Infinity;
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The page lost focus to this frame (call on window `blur` when activeElement is it). */
  clicked(): void {
    this.clickedAt = this.now();
    this.used = false;
  }

  /**
   * Whether a message arriving now may go at once. `focused`: the frame is the page's
   * activeElement; `activated`: the page has transient user activation now.
   */
  take(focused: boolean, activated: boolean): boolean {
    const now = this.now();
    if (!this.used && now - this.clickedAt <= ARTIFACT_CLICK_MS) {
      this.used = true;
      this.lastActivated = now;
      return true;
    }
    if (focused && activated && now - this.lastActivated > 5000) {
      this.lastActivated = now;
      return true;
    }
    return false;
  }
}

/** The text of a `ui/message`, if it may be sent (not empty, at most 4000 characters). */
export const messageText = frameMessageText;

/** The theme variables a frame gets (`--rg-*`), read from the page's own. */
const VARS = [
  "bg",
  "panel",
  "panel-2",
  "line",
  "text",
  "dim",
  "accent",
  "accent-2",
  "accent-soft",
  "ok",
  "warn",
  "warn-text",
  "err",
  "radius",
  "mono",
];

/** The page's theme and language as frames get them (`ui/notifications/host-context-changed`). */
export function hostContext(
  doc: Document = document,
  win: Window = window,
  locale: string = doc.documentElement.lang || "en",
): {
  theme: "light" | "dark";
  locale: string;
  styles: { variables: Record<string, string> };
} {
  const css = win.getComputedStyle(doc.documentElement);
  const variables: Record<string, string> = {};
  for (const v of VARS) {
    const value = css.getPropertyValue(`--${v}`).trim();
    if (value) variables[`--rg-${v}`] = value;
  }
  const font = doc.body ? win.getComputedStyle(doc.body).fontFamily : "";
  if (font) variables["--rg-font"] = font;
  const set = doc.documentElement.dataset.theme;
  const dark =
    set === "dark" ||
    (set !== "light" &&
      typeof win.matchMedia === "function" &&
      win.matchMedia("(prefers-color-scheme: dark)").matches);
  // The language too (3.5.12): the frame's own words (a blocked picture's placeholder).
  return { theme: dark ? "dark" : "light", locale, styles: { variables } };
}

/** Errors of one frame, deduplicated, at most 20: what the page shows and sends on. */
export function addErrors(kept: ArtifactError[], more: ArtifactError[]): ArtifactError[] {
  const out = [...kept];
  for (const e of more) {
    if (out.length >= 20) break;
    if (!out.some((k) => k.kind === e.kind && k.message === e.message && k.where === e.where))
      out.push(e);
  }
  return out;
}
