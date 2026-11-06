// Pieces shared by the wizard's steps (2026-11-06): the context each step reads, its heading,
// the big squares to pick and the windows' buttons.
import { type ComponentChildren, createContext, type JSX } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import type { StepKey } from "../wizard.js";

/** Narrow screens: the phone's layout (bottom bar, sheets, one column). */
export const PHONE = "(max-width: 640px)";

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    mq.addEventListener("change", change);
    change();
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

export interface Wz {
  s: SetupState;
  reload: () => void;
  /** Goes to a step, saving the one shown first. */
  go: (k: StepKey) => void;
  phone: boolean;
  /** What the step shown does when Next is pressed: save it; false keeps the step. */
  next: { current: (() => Promise<boolean>) | undefined };
  /** Ends the wizard, then does `then` (open a chat…). */
  finish: (then?: () => void) => void;
}
export const WzCtx = createContext<Wz | null>(null);
export const useWz = () => useContext(WzCtx) as Wz;
/** Registers the step's saving for Next (the latest closure, every render). */
export const useOnNext = (fn: () => Promise<boolean>) => {
  useWz().next.current = fn;
};

/** A step's heading: an optional small line, the question, the line under it. */
export function Head({
  eyebrow,
  q,
  lead,
}: {
  eyebrow?: string | undefined;
  q: string;
  lead?: ComponentChildren;
}) {
  return (
    <>
      {eyebrow && <p class="wz-eyebrow">{eyebrow}</p>}
      <h1 class="wz-q">{q}</h1>
      {lead && <p class="wz-lead">{lead}</p>}
    </>
  );
}

/** A big square to pick: lit (border and background) when on, never a check mark. */
export function Tile({
  on,
  icon,
  title,
  badge,
  text,
  state,
  onClick,
  wide,
}: {
  on: boolean;
  icon: JSX.Element;
  title: string;
  badge?: string | undefined;
  text: string;
  state?: string | undefined;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      class={`wz-tile${on ? " on" : ""}${wide ? " wz-tile-v" : ""}`}
      aria-pressed={on}
      onClick={onClick}
    >
      <span class="wz-ico">{icon}</span>
      <span class="wz-tile-text">
        <span class="wz-tile-title">
          {title}
          {badge && <span class="wz-badge">{badge}</span>}
        </span>
        <span class="wz-tile-p">{text}</span>
        {state && <span class="wz-state">{state}</span>}
      </span>
    </button>
  );
}

/** The window's buttons, at the bottom right (on a phone, stuck to the sheet's foot). */
export const Acts = ({ children }: { children: ComponentChildren }) => (
  <div class="wz-acts">{children}</div>
);
