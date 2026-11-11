// Keyboard and screen reader helpers (p3.5.11, G37.9): one roving tab stop for our toolbars, tab
// strips and menus (WAI-ARIA Authoring Practices: Tab reaches the group once, the arrows move inside
// it, Home and End go to the ends), one polite live region for what changes on its own, and the
// person's wish for less motion.

/** Which arrows move inside a group: a row, a column, or both (a grid of tools, a menu). */
export type Orientation = "horizontal" | "vertical" | "both";

const usable = (el: HTMLElement) =>
  !(el as HTMLButtonElement).disabled &&
  el.getAttribute("aria-disabled") !== "true" &&
  !el.closest("[hidden]");

/** The group's items, in order, that can take the focus now. */
export function rovingItems(group: HTMLElement, selector: string): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(selector)].filter(usable);
}

/** The item that keeps the tab stop: the focused one, the one chosen (selected, pressed, on), or the first. */
function current(items: HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  return (
    items.find((el) => el === active || el.contains(active)) ??
    items.find(
      (el) =>
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-pressed") === "true" ||
        el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("aria-current") === "true" ||
        el.classList.contains("on") ||
        el.classList.contains("active"),
    ) ??
    items[0]
  );
}

/** One tab stop in the group: the current item has tabindex 0, the others -1. */
export function syncRoving(group: HTMLElement | null, selector: string): void {
  if (!group) return;
  const all = [...group.querySelectorAll<HTMLElement>(selector)];
  const stop = current(rovingItems(group, selector));
  for (const el of all) el.tabIndex = el === stop ? 0 : -1;
}

/**
 * The arrows, Home and End inside a group: moves the focus (and the tab stop) and returns the
 * item reached, or undefined when the key is not ours (it is left to the page).
 */
export function rovingKey(
  e: KeyboardEvent,
  group: HTMLElement,
  selector: string,
  orientation: Orientation = "horizontal",
): HTMLElement | undefined {
  if (e.altKey || e.ctrlKey || e.metaKey) return undefined;
  const rtl = getComputedStyle(group).direction === "rtl";
  // Right to left, the row's arrows swap (a column's do not).
  if (rtl && orientation === "horizontal" && /^Arrow(Left|Right)$/.test(e.key)) {
    const swapped = e.key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
    return rovingKeyIn(
      new KeyboardEvent("keydown", { key: swapped }) as KeyboardEvent & { target: EventTarget },
      rovingItems(group, selector),
      orientation,
      e,
    );
  }
  return rovingKeyIn(e, rovingItems(group, selector), orientation);
}

/** A field, a text editor or a terminal: keys typed there are theirs, never a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (
    el.closest(
      "textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm",
    )
  )
    return true;
  if (el instanceof HTMLInputElement)
    return !["button", "checkbox", "radio", "range", "color", "submit", "reset"].includes(el.type);
  return false;
}

/** The person asked their system for less motion: no marching ants, no flashes, no slides. */
export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

let region: HTMLElement | undefined;
let lastText = "";
let lastAt = 0;
let clear: ReturnType<typeof setTimeout> | undefined;

/**
 * Says `text` to a screen reader, politely, through one hidden live region for the whole page. The
 * same words twice within a moment are said once (two editors on the same file, a re-render).
 */
export function announce(text: string, now = Date.now()): void {
  if (typeof document === "undefined" || !text) return;
  if (text === lastText && now - lastAt < 1500) return;
  lastText = text;
  lastAt = now;
  if (!region?.isConnected) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.dataset.a11yAnnounce = "";
    document.body.append(region);
  }
  // Emptied first: the same words said again later are a change the reader hears.
  region.textContent = "";
  const el = region;
  setTimeout(() => {
    el.textContent = text;
  }, 30);
  if (clear) clearTimeout(clear);
  clear = setTimeout(() => {
    el.textContent = "";
  }, 6000);
}

/** For tests: forget what was said. */
export function resetAnnounce(): void {
  lastText = "";
  lastAt = 0;
  region?.remove();
  region = undefined;
}

// ---- the keyboard in the canvas, delegated (p3.5.11) ---------------------------------------------

/** What moves with the arrows in a toolbar: its buttons (fields and choices keep their own stop). */
const TOOLBAR_ITEMS = "button, a[href], [role=switch], [role=radio]";
const MENU_ITEMS = "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";

/** The toolbar's or tab list's own items: not those of a menu or another group inside it. */
function groupItems(group: HTMLElement): HTMLElement[] {
  const tabs = group.getAttribute("role") === "tablist";
  return rovingItems(group, tabs ? "[role=tab]" : TOOLBAR_ITEMS).filter(
    (el) =>
      el.closest("[role=toolbar], [role=tablist]") === group &&
      !el.closest("[role=menu]") &&
      el.getAttribute("aria-hidden") !== "true",
  );
}

/** One tab stop in a toolbar or a tab list: `stop` (the item just focused) or the chosen one. */
export function syncGroup(group: HTMLElement, stop?: HTMLElement): void {
  const items = groupItems(group);
  const keep = stop && items.includes(stop) ? stop : current(items);
  for (const el of items) el.tabIndex = el === keep ? 0 : -1;
}

/** The button that opened `menu`: the one with `aria-haspopup` beside it. */
export function menuOwner(menu: HTMLElement): HTMLElement | null {
  let box: HTMLElement | null = menu.parentElement;
  for (let i = 0; box && i < 3; i++, box = box.parentElement) {
    const owner = [...box.querySelectorAll<HTMLElement>("[aria-haspopup]")].find(
      (el) => !menu.contains(el) && el.getAttribute("aria-expanded") === "true",
    );
    if (owner) return owner;
  }
  return null;
}

/** The menu `owner` opened, once it shows. */
function menuOf(owner: HTMLElement): HTMLElement | null {
  let box: HTMLElement | null = owner.parentElement;
  for (let i = 0; box && i < 3; i++, box = box.parentElement) {
    const menu = box.querySelector<HTMLElement>("[role=menu]");
    if (menu) return menu;
  }
  return null;
}

/** Into a menu just opened: the item chosen, or the first. */
export function focusMenu(menu: HTMLElement): void {
  const items = rovingItems(menu, MENU_ITEMS);
  const to =
    items.find((el) => el.getAttribute("aria-checked") === "true") ?? (items[0] as HTMLElement);
  for (const el of items) el.tabIndex = el === to ? 0 : -1;
  to?.focus();
}

/**
 * The canvas's keyboard (G37.9): in every toolbar and tab list the arrows move (one tab stop
 * each), Home and End go to the ends; a tab reached by the arrows is chosen; a menu opened from
 * the keyboard takes the focus, its arrows move, Escape closes it and gives the focus back to its
 * button. Returns what removes it.
 */
export function installKeyboard(root: HTMLElement): () => void {
  const key = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    const menu = el.closest<HTMLElement>("[role=menu]");
    if (menu && root.contains(menu)) {
      if (e.key === "Escape") {
        const owner = menuOwner(menu);
        e.preventDefault();
        e.stopPropagation();
        // The menu's own Escape (if any) has run; one still open closes from its button.
        requestAnimationFrame(() => {
          if (menu.isConnected && owner) owner.click();
          owner?.focus();
        });
        return;
      }
      rovingKey(e, menu, MENU_ITEMS, "vertical");
      return;
    }
    if (
      el.matches("[aria-haspopup=menu], [aria-haspopup=true]") &&
      /^(Enter| |ArrowDown)$/.test(e.key)
    ) {
      // The menu opens on the click (Enter and Space make one; the arrow asks for it), then
      // takes the focus.
      if (e.key === "ArrowDown") {
        const group = el.closest("[role=toolbar]");
        if (group?.getAttribute("aria-orientation") === "vertical") return groupKey(e, el);
        e.preventDefault();
        if (el.getAttribute("aria-expanded") !== "true") el.click();
      }
      requestAnimationFrame(() => {
        const m = el.getAttribute("aria-expanded") === "true" ? menuOf(el) : null;
        if (m) focusMenu(m);
      });
      return;
    }
    groupKey(e, el);
  };
  const groupKey = (e: KeyboardEvent, el: HTMLElement) => {
    if (el.matches("input, select, textarea, [contenteditable]")) return;
    const group = el.closest<HTMLElement>("[role=toolbar], [role=tablist]");
    if (!group || !root.contains(group)) return;
    const tabs = group.getAttribute("role") === "tablist";
    const orientation =
      (group.getAttribute("aria-orientation") as Orientation | null) ?? "horizontal";
    const items = groupItems(group);
    if (!items.includes(el)) return;
    const reached = rovingKeyIn(e, items, orientation);
    if (reached && tabs) reached.click();
  };
  // Focus coming into a group makes that item its one stop.
  const focus = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    const group = el.closest?.<HTMLElement>("[role=toolbar], [role=tablist]");
    if (group && root.contains(group) && !el.matches("input, select, textarea"))
      syncGroup(group, el);
  };
  root.addEventListener("keydown", key);
  root.addEventListener("focusin", focus);
  return () => {
    root.removeEventListener("keydown", key);
    root.removeEventListener("focusin", focus);
  };
}

/** `rovingKey` over a list already made. */
function rovingKeyIn(
  e: KeyboardEvent,
  items: HTMLElement[],
  orientation: Orientation,
  /** The real event, when `e` is the same key with its arrow swapped (right to left). */
  real: KeyboardEvent = e,
): HTMLElement | undefined {
  if (e.altKey || e.ctrlKey || e.metaKey || items.length === 0) return undefined;
  const at = items.findIndex((el) => el === real.target || el.contains(real.target as Node));
  if (at < 0) return undefined;
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  let to: number;
  if (e.key === next || (orientation === "both" && e.key === "ArrowDown"))
    to = (at + 1) % items.length;
  else if (e.key === prev || (orientation === "both" && e.key === "ArrowUp"))
    to = (at - 1 + items.length) % items.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  else return undefined;
  real.preventDefault();
  const el = items[to] as HTMLElement;
  for (const x of items) x.tabIndex = x === el ? 0 : -1;
  el.focus();
  return el;
}
