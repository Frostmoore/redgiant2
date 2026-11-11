// What a library hangs on the window while it starts, to take off when it ends (3.5.11: svgcanvas
// has no way to end, and its window listener kept every closed drawing editor alive).

/**
 * The listeners added to the window while `windowListeners()` records (until `stop()`), to be
 * taken off with `remove()`.
 */
export function windowListeners(target: EventTarget = window) {
  const added: [
    string,
    EventListenerOrEventListenerObject,
    boolean | AddEventListenerOptions | undefined,
  ][] = [];
  const add = target.addEventListener;
  target.addEventListener = function (
    this: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    opts?: boolean | AddEventListenerOptions,
  ) {
    if (fn) added.push([type, fn, opts]);
    return add.call(this, type, fn, opts);
  };
  return {
    stop() {
      // Own property set above: removing it gives back the prototype's.
      delete (target as { addEventListener?: unknown }).addEventListener;
      if (target.addEventListener !== add) target.addEventListener = add;
    },
    remove() {
      for (const [type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts);
    },
  };
}
