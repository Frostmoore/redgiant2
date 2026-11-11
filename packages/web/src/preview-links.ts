// Links in agent-made pages (3.5.8): a preview opens no windows and cannot take its frame to
// another site, so the server's script in the page hands a link it wants to open to us, and the
// person decides. Only messages from our own preview frames count; one question at a time.
import { askConfirm } from "./components/dialogs.js";
import { t } from "./i18n.js";

/** A link a preview frame asks to open, if the message is one and comes from a preview. */
export function previewLink(e: MessageEvent, frames: Iterable<HTMLIFrameElement>): URL | undefined {
  const d = e.data as { redgiant?: unknown; url?: unknown } | null;
  if (!d || typeof d !== "object" || d.redgiant !== "open-link" || typeof d.url !== "string")
    return undefined;
  let fromPreview = false;
  for (const f of frames)
    if (
      f.contentWindow === e.source &&
      new URL(f.src, location.href).pathname.startsWith("/preview/")
    )
      fromPreview = true;
  if (!fromPreview) return undefined;
  try {
    const u = new URL(d.url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

let listening = false;

/** Listens once for the page's previews asking to open a link. */
export function listenPreviewLinks(): void {
  if (listening) return;
  listening = true;
  let open = false;
  window.addEventListener("message", (e) => {
    const url = previewLink(e, document.querySelectorAll("iframe"));
    if (!url || open) return;
    open = true;
    void askConfirm(t("previewLinkTitle"), { text: url.href, yes: t("previewLinkOpen") })
      .then((yes) => {
        if (yes) window.open(url.href, "_blank", "noopener,noreferrer");
      })
      .finally(() => {
        open = false;
      });
  });
}
