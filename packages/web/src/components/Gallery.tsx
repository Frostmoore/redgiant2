// Cards side by side with a panel of details (2026-11-04, the person's choice for the models
// page: "galleria con pannello"). Touching a card opens everything about it on the right; where
// there is no room for both (a phone, a narrow tab) the panel opens above the rest, closed with
// an X.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconX } from "../icons.js";
import { Modal } from "./ui.js";

/** Below this width the panel is a window above the cards. */
const PANEL_ROOM = 900;

export interface GalleryPanel {
  title: string;
  body: ComponentChildren;
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
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([e]) => setWide((e?.contentRect.width ?? 0) >= PANEL_ROOM));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div ref={box} class={`gallery${panel && wide ? " with-panel" : ""}`}>
      <div class="gallery-cards">{children}</div>
      {panel &&
        (wide ? (
          <aside class="gallery-panel" aria-label={panel.title}>
            <header>
              <strong>{panel.title}</strong>
              <button type="button" class="ui-modal-x" aria-label={t("close")} onClick={onClose}>
                <IconX size={18} />
              </button>
            </header>
            <div class="gallery-panel-body">{panel.body}</div>
          </aside>
        ) : (
          <Modal title={panel.title} onClose={onClose}>
            {panel.body}
          </Modal>
        ))}
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
