// Cards with their details in a window above everything (2026-11-06, the person: «mettiamola come
// semplicissima modale che si apre sopra a tutto»; before, on wide screens, a panel on the right).
import type { ComponentChildren } from "preact";
import { Modal } from "./ui.js";

export interface GalleryPanel {
  title: string;
  body: ComponentChildren;
  wide?: boolean | undefined;
}

export function Gallery({
  children,
  panel,
  onClose,
}: {
  children: ComponentChildren;
  panel: GalleryPanel | null;
  onClose: () => void;
}) {
  return (
    <div class="gallery">
      <div class="gallery-cards">{children}</div>
      {panel && (
        <Modal title={panel.title} onClose={onClose} wide={panel.wide}>
          <div class="gallery-panel-body">{panel.body}</div>
        </Modal>
      )}
    </div>
  );
}

/** One card: a button that opens its panel. */
export function GalleryCard({
  selected,
  tone,
  onOpen,
  children,
}: {
  selected: boolean;
  /** "ok": in use, connected; "usable": fast enough here to work with (2026-11-05). */
  tone?: "ok" | "usable" | undefined;
  onOpen: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      class={`gcard${selected ? " selected" : ""}${tone ? ` ${tone}` : ""}`}
      aria-pressed={selected}
      onClick={onOpen}
    >
      {children}
    </button>
  );
}
