// Univer's sheet, made readable (p3.5.11, G37.9): its sheet bar's buttons have no names, its
// canvases a tab index above 0, a wrapper says «expanded» where only a button may, and a slider
// uses a role that does not exist. Univer is not ours: the page fixes its DOM as it appears.
import { t } from "../i18n.js";

/** Names, roles and tab stops for Univer's DOM under `root`. Idempotent. */
export function patchSheetDom(root: HTMLElement): void {
  // The cell (or range) box and the defined names' button.
  for (const box of root.querySelectorAll<HTMLElement>("[data-u-comp=defined-name]")) {
    const input = box.querySelector("input");
    if (input && !input.getAttribute("aria-label"))
      input.setAttribute("aria-label", t("sheetCellBox"));
    for (const a of box.querySelectorAll<HTMLElement>("a[aria-expanded]:not([href])")) {
      if (a.getAttribute("role") !== "button") a.setAttribute("role", "button");
      if (!a.getAttribute("aria-label")) a.setAttribute("aria-label", t("sheetNames"));
    }
  }
  // A wrapper that holds a button says nothing itself: its button opens the menu.
  for (const w of root.querySelectorAll<HTMLElement>("div[aria-expanded]:not([role])")) {
    const inner = w.querySelector("button");
    if (!inner) continue;
    inner.setAttribute("aria-expanded", w.getAttribute("aria-expanded") ?? "false");
    const pop = w.getAttribute("aria-haspopup");
    if (pop) inner.setAttribute("aria-haspopup", pop);
    w.removeAttribute("aria-expanded");
    w.removeAttribute("aria-haspopup");
    w.dataset.rgMenu = "";
  }
  // The sheet bar's buttons: add a sheet, all the sheets, scroll left and right.
  for (const b of root.querySelectorAll<HTMLElement>(
    "button[data-u-comp=sheet-bar-append-button]",
  )) {
    if (b.getAttribute("aria-label")) continue;
    const scroll = b.parentElement?.getAttribute("data-u-comp") === "sheet-bar-scroll-buttons";
    const name = scroll
      ? b === b.parentElement?.firstElementChild
        ? t("sheetScrollLeft")
        : t("sheetScrollRight")
      : b.closest("[data-rg-menu], [data-slot=dropdown-menu-trigger]")
        ? t("sheetAllSheets")
        : t("sheetAddSheet");
    b.setAttribute("aria-label", name);
    b.title ||= name;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[role=track]")) el.removeAttribute("role");
  // One tab stop for the grid; the hidden editors' canvases none.
  for (const c of root.querySelectorAll<HTMLCanvasElement>("canvas[tabindex]")) {
    if (c.tabIndex <= 0) continue;
    c.tabIndex = c.width === 0 || c.height === 0 || c.id.startsWith("univer-doc") ? -1 : 0;
  }
}

/** Keeps `root` patched while Univer changes it; returns what stops. */
export function watchSheetDom(root: HTMLElement): () => void {
  let queued = false;
  const run = () => {
    queued = false;
    observer.disconnect();
    patchSheetDom(root);
    observer.observe(root, OPTIONS);
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  });
  const OPTIONS: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "tabindex", "role"],
  };
  patchSheetDom(root);
  observer.observe(root, OPTIONS);
  return () => observer.disconnect();
}
