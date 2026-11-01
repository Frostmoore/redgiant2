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
