// A request's buttons ignore clicks for a moment after they appear (3.5.6: two approvals given in
// seconds by a click meant for something else, «non mi pare di aver cliccato consenti»). They
// look off, then turn on; when the buttons leave the view and come back, the wait starts again.
import { useEffect, useRef, useState } from "preact/hooks";

/** How long a request's buttons stay off once they are in view. */
export const ARM_MS = 800;

/**
 * `ref` goes on the buttons' row; `armed` is true once it has been in view for `ms`. A new
 * request (`key`) starts off again, even when the page reuses the same buttons.
 */
export function useArmed<T extends Element>(key: string, ms = ARM_MS) {
  const ref = useRef<T>(null);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  useEffect(() => {
    setArmedFor(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => setArmedFor(key), ms);
    };
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
      setArmedFor(null);
    };
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return () => clearTimeout(timer);
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) start();
      else stop();
    });
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, [key, ms]);
  return { ref, armed: armedFor === key };
}

/**
 * Enter never says yes (3.5.6): a key pressed for something else must not approve a request
 * whose button happens to have the focus. Space or a click still do.
 */
export const noEnter = (e: KeyboardEvent) => {
  if (e.key === "Enter") e.preventDefault();
};
