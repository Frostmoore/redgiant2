import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import { t } from "./i18n.js";

for (const [name, lang] of Object.entries({
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
}))
  hljs.registerLanguage(name, lang);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Code blocks: highlighted, with their language and a copy button (as in Officina). */
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const known = name && hljs.getLanguage(name) ? name : "";
      const body = known
        ? hljs.highlight(text, { language: known, ignoreIllegals: true }).value
        : escapeHtml(text);
      return `<div class="code"><div class="code-head"><span>${escapeHtml(name)}</span><button type="button" class="copy-code">${escapeHtml(t("copy"))}</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
});

/** One listener for every copy button, wherever the Markdown is shown. */
if (typeof document !== "undefined")
  document.addEventListener("click", (e) => {
    const button = (e.target as Element | null)?.closest?.(".copy-code");
    const code = button?.closest(".code")?.querySelector("pre")?.textContent;
    if (!button || code == null) return;
    void navigator.clipboard?.writeText(code).then(() => {
      button.textContent = t("copied");
      setTimeout(() => (button.textContent = t("copy")), 1500);
    });
  });

/** Model output is untrusted: rendered Markdown is always sanitised. */
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}

/** A character models do not write (Unicode private use): where the cursor goes. */
const CURSOR_MARK = "\uE000";
const CURSOR_MARK_URL = encodeURI(CURSOR_MARK);

/**
 * Markdown being written, with the cursor after the last word (2026-11-04). Drawn after the
 * last block, it fell below a list, a table or a quote while the text grew inside them; marked
 * in the text itself it lands in the last item, cell or line, wherever that is.
 */
export function renderStreamingMarkdown(md: string): string {
  const html = renderMarkdown(`${md.replace(/\s+$/, "")}${CURSOR_MARK}`);
  if (typeof document === "undefined") return html.split(CURSOR_MARK).join("");
  // Only where the mark is visible text: in a link's address it is just taken away.
  const box = document.createElement("template");
  box.innerHTML = html;
  let placed = false;
  const walker = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT);
  const marked: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if ((n as Text).data.includes(CURSOR_MARK)) marked.push(n as Text);
  for (const text of marked) {
    const [before = "", ...rest] = text.data.split(CURSOR_MARK);
    text.data = before;
    const after = rest.join("") ? [document.createTextNode(rest.join(""))] : [];
    if (!placed) {
      const cursor = document.createElement("span");
      cursor.className = "stream-cursor";
      cursor.setAttribute("aria-hidden", "true");
      text.after(cursor, ...after);
      placed = true;
    } else text.after(...after);
  }
  // In an attribute (a link's address) the mark goes, as it is or as marked encodes it.
  for (const el of box.content.querySelectorAll("*"))
    for (const attr of [...el.attributes])
      if (attr.value.includes(CURSOR_MARK) || attr.value.includes(CURSOR_MARK_URL))
        el.setAttribute(
          attr.name,
          attr.value.split(CURSOR_MARK).join("").split(CURSOR_MARK_URL).join(""),
        );
  if (!placed) {
    const cursor = document.createElement("span");
    cursor.className = "stream-cursor";
    cursor.setAttribute("aria-hidden", "true");
    box.content.append(cursor);
  }
  return box.innerHTML;
}
