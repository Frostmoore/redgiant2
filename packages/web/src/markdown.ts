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

/**
 * An answer with its sources (2026-11-06, the person: «le fonti dovrebbero essere mostrate come
 * link già nel testo… un po' come fa ChatGPT»). When the answer ends with a numbered list of
 * links, every [n] in the text becomes a small link to source n named after its site, several in
 * a row become one («cbsnews.com +2»), and the list itself is drawn small. The person's own
 * documents (G36.5, `search_knowledge`) are cited the same way with `#kb:<piece>` links: named
 * after the file and its page, they open the Canvas at that point (state.ts listens for them).
 */
export function renderAnswer(md: string): string {
  return linkCitations(renderMarkdown(md));
}

export function linkCitations(html: string): string {
  if (typeof document === "undefined" || !/\[\d+\]/.test(html)) return html;
  const box = document.createElement("template");
  box.innerHTML = html;
  const sourcesOf = (ol: Element) => [...ol.children].filter((li) => li.tagName === "LI");
  const SOURCE = 'a[href^="http"], a[href^="#kb:"]';
  const list = [...box.content.querySelectorAll("ol")].reverse().find((ol) => {
    const items = sourcesOf(ol);
    return items.length > 0 && items.every((li) => li.querySelector(SOURCE));
  });
  if (!list) return html;
  const first = Number(list.getAttribute("start") ?? "1") || 1;
  const sources = new Map<number, { href: string; site: string; title: string; kb?: boolean }>();
  sourcesOf(list).forEach((li, i) => {
    const link = li.querySelector(SOURCE);
    const href = link?.getAttribute("href") ?? "";
    if (href.startsWith("#kb:")) {
      // A document of the person's: named after the file (and page) the link says.
      // The tool names places in English (`p. 3`, `lines 4-9`): said here in the page's language.
      const title =
        (link?.textContent ?? "")
          .trim()
          .replace(/, p\. (\d+)$/, (_, n) => `, ${t("kbPage", { n })}`)
          .replace(/, lines (\d+)-(\d+)$/, (_, a, b) => `, ${t("kbLines", { a, b })}`)
          .replace(/, line (\d+)$/, (_, n) => `, ${t("kbLine", { n })}`) || t("kbCiteFallback");
      if (link) link.textContent = title;
      // A long name is shortened, its page or lines kept: they are the point of the citation.
      const cut = title.lastIndexOf(", ");
      const [name, place] = cut > 0 ? [title.slice(0, cut), title.slice(cut)] : [title, ""];
      const site = name.length > 24 ? `${name.slice(0, 22).trimEnd()}…${place}` : title;
      sources.set(first + i, { href, site, title, kb: true });
      return;
    }
    try {
      const site = new URL(href).hostname.replace(/^www\./, "");
      const title = (li.textContent ?? "").split(/:\s/)[0]?.trim() || site;
      sources.set(first + i, { href, site, title });
    } catch {
      // not an address: that source has no link
    }
  });
  list.classList.add("sources");
  const before = list.previousElementSibling;
  if (before && /^(fonti|sources|riferimenti|references)\b/i.test(before.textContent?.trim() ?? ""))
    before.classList.add("sources-title");
  const walker = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (text.parentElement?.closest("a, code, pre, ol.sources")) continue;
    if (/\[\d+\]/.test(text.data)) texts.push(text);
  }
  for (const text of texts) {
    const out = document.createDocumentFragment();
    let rest = text.data;
    // Runs of citations, spaces between them allowed: one link each run.
    for (let m = /(?:\[\d+\]\s*)+/.exec(rest); m; m = /(?:\[\d+\]\s*)+/.exec(rest)) {
      const found = [...m[0].matchAll(/\[(\d+)\]/g)].flatMap((x) => {
        const s = sources.get(Number(x[1]));
        return s ? [s] : [];
      });
      const end = m.index + m[0].length;
      if (found.length === 0) {
        out.append(rest.slice(0, end));
        rest = rest.slice(end);
        continue;
      }
      const [head] = found as [(typeof found)[0]];
      out.append(rest.slice(0, m.index));
      const a = document.createElement("a");
      a.className = head.kb ? "cite kb" : "cite";
      a.href = head.href;
      if (!head.kb) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      a.title = found.map((s) => s.title).join("\n");
      a.textContent = found.length > 1 ? `${head.site} +${found.length - 1}` : head.site;
      out.append(a);
      // The space after the run stays, so the next word does not touch the link.
      if (/\s$/.test(m[0])) out.append(" ");
      rest = rest.slice(end);
    }
    out.append(rest);
    text.replaceWith(out);
  }
  return box.innerHTML;
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
