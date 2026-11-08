// Emptying the clipboard where a document can write it (Chromium's offscreen page, Firefox's
// background page): a copy whose text is empty.
export function clearClipboardHere(doc: Document): void {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", "");
    e.preventDefault();
  };
  doc.addEventListener("copy", onCopy);
  try {
    doc.execCommand("copy");
  } finally {
    doc.removeEventListener("copy", onCopy);
  }
}
