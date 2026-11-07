// Moving a conversation to a folder (2026-11-03): a small menu with the folders already there,
// a new one written in place, and "out of the folder".
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconFolder, IconPlus } from "../icons.js";

export function FolderMenu({
  current,
  folders,
  onPick,
}: {
  current: string | null;
  /** The folders already used next to this conversation. */
  folders: string[];
  onPick: (folder: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const box = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** Where the menu opens: next to its button, above everything (rows clip what overflows). */
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const inside =
        box.current?.contains(e.target as Node) || list.current?.contains(e.target as Node);
      if (!inside) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (f: string | null) => {
    setOpen(false);
    setCreating(false);
    setName("");
    if (f !== current) onPick(f);
  };
  return (
    <span class="folder-menu" ref={box}>
      <button
        type="button"
        class="icon-button"
        title={t("folderMove")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const width = 220;
          setAt({
            top: Math.min(r.bottom + 4, window.innerHeight - 260),
            left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
          });
          setOpen(!open);
        }}
      >
        <IconFolder size={13} />
      </button>
      {open &&
        // Above the page, not inside the bar: a row or the bar would clip it or scroll.
        createPortal(
          <div
            class="folder-menu-list"
            ref={list}
            role="menu"
            style={{ top: `${at.top}px`, left: `${at.left}px` }}
          >
            <div class="folder-menu-title">{t("folderMove")}</div>
            {folders.map((f) => (
              <button
                key={f}
                type="button"
                role="menuitem"
                class={f === current ? "cur" : undefined}
                aria-current={f === current ? "true" : undefined}
                onClick={() => pick(f)}
              >
                <IconFolder size={13} />
                <span>{f}</span>
              </button>
            ))}
            {creating ? (
              <form
                class="folder-menu-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) pick(name.trim().slice(0, 60));
                }}
              >
                <input
                  // biome-ignore lint/a11y/noAutofocus: the field is what the person just asked for.
                  autoFocus
                  placeholder={t("folderName")}
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                />
                <button type="submit" class="primary tiny" disabled={!name.trim()}>
                  {t("save")}
                </button>
              </form>
            ) : (
              <button type="button" role="menuitem" onClick={() => setCreating(true)}>
                <IconPlus size={13} />
                <span>{t("folderNew")}</span>
              </button>
            )}
            {current && (
              <button type="button" role="menuitem" class="dim" onClick={() => pick(null)}>
                <span>{t("folderOut")}</span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
