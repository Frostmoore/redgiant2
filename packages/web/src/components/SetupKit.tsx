// The wizard's context (2026-11-06): what each step reads, and the phone's media query. The
// pieces it draws with (heading, squares, the windows' buttons…) live in SettingsKit.
import { createContext } from "preact";
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
  /**
   * Signed in with a first start's setup code and no password yet (G39.3): the password step
   * cannot be skipped, or the page could not sign in again later.
   */
  mustSetPassword?: boolean;
}
export const WzCtx = createContext<Wz | null>(null);
export const useWz = () => useContext(WzCtx) as Wz;
/** Registers the step's saving for Next (the latest closure, every render). */
export const useOnNext = (fn: () => Promise<boolean>) => {
  useWz().next.current = fn;
};
