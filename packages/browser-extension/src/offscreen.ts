// Chromium's hidden page: the service worker cannot touch the clipboard, this page can.
import { clearClipboardHere } from "./clipboard.js";
import { ext } from "./ext.js";

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id || (message as { type?: string })?.type !== "offscreen-clear")
    return undefined;
  clearClipboardHere(document);
  sendResponse({ ok: true });
  return undefined;
});
