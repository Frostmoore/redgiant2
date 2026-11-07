// Documents and slides read in the page (G34.2). OpenDocument (ODT, ODP) is XML in a ZIP: its
// content.xml is turned into page elements here, built one by one (never markup from the file,
// so nothing in it can run). PPTX slides are read for their text and pictures; DOCX goes
// through mammoth (in DocView). Unzipping is fflate's (MIT).
import { unzipSync } from "fflate";

export type Files = Record<string, Uint8Array>;

/** The files of a ZIP (only those `keep` accepts, when given). */
export function unzip(bytes: Uint8Array, keep?: (name: string) => boolean): Files {
  return unzipSync(bytes, keep ? { filter: (f) => keep(f.name) } : {});
}

export const utf8 = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

const NS = {
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  xlink: "http://www.w3.org/1999/xlink",
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
};

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("Unreadable XML");
  return doc;
}

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  parent?: string;
}

/** The text styles of an OpenDocument (bold, italic…), by name. */
function odfStyles(...docs: (Document | undefined)[]): Map<string, TextStyle> {
  const map = new Map<string, TextStyle>();
  for (const d of docs) {
    if (!d) continue;
    for (const s of d.getElementsByTagNameNS(NS.style, "style")) {
      const name = s.getAttributeNS(NS.style, "name");
      if (!name) continue;
      const p = s.getElementsByTagNameNS(NS.style, "text-properties")[0];
      const st: TextStyle = {};
      const parent = s.getAttributeNS(NS.style, "parent-style-name");
      if (parent) st.parent = parent;
      if (p) {
        if (p.getAttributeNS(NS.fo, "font-weight") === "bold") st.bold = true;
        if (p.getAttributeNS(NS.fo, "font-style") === "italic") st.italic = true;
        const u = p.getAttributeNS(NS.style, "text-underline-style");
        if (u && u !== "none") st.underline = true;
        const l = p.getAttributeNS(NS.style, "text-line-through-style");
        if (l && l !== "none") st.strike = true;
      }
      map.set(name, st);
    }
  }
  return map;
}

function styleOf(styles: Map<string, TextStyle>, name: string | null): TextStyle {
  const out: TextStyle = {};
  for (let n = name, depth = 0; n && depth < 8; depth++) {
    const s = styles.get(n);
    if (!s) break;
    out.bold ??= s.bold;
    out.italic ??= s.italic;
    out.underline ??= s.underline;
    out.strike ??= s.strike;
    n = s.parent ?? null;
  }
  return out;
}

function applyStyle(el: HTMLElement, s: TextStyle) {
  if (s.bold) el.style.fontWeight = "bold";
  if (s.italic) el.style.fontStyle = "italic";
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) el.style.textDecoration = deco;
}

/** A link only when it goes to the web or an address: never a script. */
export function safeHref(href: string | null): string | undefined {
  if (!href) return undefined;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

/** Parts of an OpenDocument never shown as text. */
const SKIP = new Set([
  "sequence-decls",
  "tracked-changes",
  "forms",
  "note",
  "annotation",
  "bookmark-ref",
  "soft-page-break",
  "notes",
]);

/**
 * OpenDocument content as page elements: headings, paragraphs with bold, italic and underline,
 * lists, tables, links and pictures (`images`: the ZIP's path → a URL of its bytes).
 */
export function odfToElements(
  content: Document,
  styles: Document | undefined,
  images: Map<string, string>,
  out: Document = document,
): DocumentFragment {
  const map = odfStyles(styles, content);
  const frag = out.createDocumentFragment();
  const walk = (node: Node, into: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        into.appendChild(out.createTextNode(child.nodeValue ?? ""));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const name = el.localName;
      if (SKIP.has(name)) continue;
      const make = (tag: string) => {
        const e = out.createElement(tag);
        into.appendChild(e);
        return e;
      };
      const styled = () => styleOf(map, el.getAttributeNS(NS.text, "style-name"));
      switch (
        el.namespaceURI === NS.text || el.namespaceURI === NS.table || el.namespaceURI === NS.draw
          ? name
          : ""
      ) {
        case "h": {
          const level = Math.min(
            6,
            Math.max(1, Number(el.getAttributeNS(NS.text, "outline-level")) || 1),
          );
          walk(el, make(`h${level}`));
          break;
        }
        case "p": {
          const p = make("p");
          applyStyle(p, styled());
          walk(el, p);
          if (!p.hasChildNodes()) p.appendChild(out.createElement("br"));
          break;
        }
        case "span": {
          const s = make("span");
          applyStyle(s, styled());
          walk(el, s);
          break;
        }
        case "a": {
          const href = safeHref(el.getAttributeNS(NS.xlink, "href"));
          const a = make(href ? "a" : "span") as HTMLAnchorElement;
          if (href) {
            a.href = href;
            a.target = "_blank";
            a.rel = "noreferrer noopener";
          }
          walk(el, a);
          break;
        }
        case "s":
          into.appendChild(
            out.createTextNode(" ".repeat(Number(el.getAttributeNS(NS.text, "c")) || 1)),
          );
          break;
        case "tab":
          into.appendChild(out.createTextNode(" "));
          break;
        case "line-break":
          make("br");
          break;
        case "list":
          walk(el, make("ul"));
          break;
        case "list-item":
        case "list-header":
          walk(el, make("li"));
          break;
        case "table":
          if (el.namespaceURI === NS.table) walk(el, make("table"));
          else walk(el, into);
          break;
        case "table-row":
          walk(el, make("tr"));
          break;
        case "table-cell": {
          const td = make("td") as HTMLTableCellElement;
          const span = Number(el.getAttributeNS(NS.table, "number-columns-spanned"));
          if (span > 1) td.colSpan = span;
          walk(el, td);
          break;
        }
        case "covered-table-cell":
          break;
        case "image": {
          const href = el.getAttributeNS(NS.xlink, "href") ?? "";
          const url = images.get(href.replace(/^\.\//, ""));
          if (url) {
            const img = make("img") as HTMLImageElement;
            img.src = url;
            img.alt = "";
          }
          break;
        }
        default:
          walk(el, into);
      }
    }
  };
  const body =
    content.getElementsByTagNameNS(NS.office, "text")[0] ??
    content.getElementsByTagNameNS(NS.office, "body")[0] ??
    content.documentElement;
  walk(body, frag);
  return frag;
}

/** The pictures of a ZIP, as URLs of their bytes (to be revoked by whoever made them). */
export function pictureUrls(files: Files, under: RegExp): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!under.test(path)) continue;
    const ext = path.toLowerCase().split(".").pop() ?? "";
    const type =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "png"
          ? "image/png"
          : ext === "gif"
            ? "image/gif"
            : /^jpe?g$/.test(ext)
              ? "image/jpeg"
              : ext === "webp"
                ? "image/webp"
                : "";
    if (type) urls.set(path, URL.createObjectURL(new Blob([bytes as BlobPart], { type })));
  }
  return urls;
}

// ---------- Slides ----------

export interface Slide {
  title: string;
  /** Lines of text with their indent level (0 = top). */
  lines: { text: string; level: number }[];
  /** Paths of the pictures on it, inside the ZIP. */
  pictures: string[];
}

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A relationships file: id → target, resolved against the folder of the part it belongs to. */
function rels(files: Files, part: string): Map<string, { target: string; type: string }> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const relsPath = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const map = new Map<string, { target: string; type: string }>();
  const text = utf8(files[relsPath]);
  if (!text) return map;
  for (const r of parseXml(text).getElementsByTagName("Relationship")) {
    const id = r.getAttribute("Id");
    const target = r.getAttribute("Target") ?? "";
    if (!id) continue;
    // Targets are relative to the part's folder ("../media/image1.png").
    const parts = (target.startsWith("/") ? target.slice(1) : dir + target).split("/");
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === "..") resolved.pop();
      else if (p !== ".") resolved.push(p);
    }
    map.set(id, { target: resolved.join("/"), type: r.getAttribute("Type") ?? "" });
  }
  return map;
}

/** The slides of a PPTX, in order: titles, text and pictures. */
export function pptxSlides(files: Files): Slide[] {
  const pres = "ppt/presentation.xml";
  const presXml = utf8(files[pres]);
  let order: string[] = [];
  if (presXml) {
    const r = rels(files, pres);
    order = [...parseXml(presXml).getElementsByTagNameNS(P, "sldId")]
      .map((s) => r.get(s.getAttributeNS(R, "id") ?? "")?.target)
      .filter((x): x is string => !!x && !!files[x]);
  }
  if (order.length === 0)
    order = Object.keys(files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/g)?.pop()) - Number(b.match(/\d+/g)?.pop()));
  return order.map((part) => {
    const doc = parseXml(utf8(files[part]));
    const r = rels(files, part);
    let title = "";
    const lines: Slide["lines"] = [];
    for (const sp of doc.getElementsByTagNameNS(P, "sp")) {
      const ph = sp.getElementsByTagNameNS(P, "ph")[0];
      const kind = ph?.getAttribute("type") ?? "";
      const paras = [...sp.getElementsByTagNameNS(A, "p")].map((p) => ({
        text: [...p.getElementsByTagNameNS(A, "t")].map((x) => x.textContent ?? "").join(""),
        level: Number(p.getElementsByTagNameNS(A, "pPr")[0]?.getAttribute("lvl") ?? 0) || 0,
      }));
      const said = paras.filter((p) => p.text.trim());
      if (!title && (kind === "title" || kind === "ctrTitle"))
        title = said.map((p) => p.text).join(" ");
      else lines.push(...said);
    }
    const pictures = [...doc.getElementsByTagNameNS(A, "blip")]
      .map((b) => r.get(b.getAttributeNS(R, "embed") ?? "")?.target)
      .filter((x): x is string => !!x && !!files[x]);
    return { title, lines, pictures };
  });
}

/** The pages of an ODP: their name, text and pictures. */
export function odpSlides(content: Document): Slide[] {
  return [...content.getElementsByTagNameNS(NS.draw, "page")].map((page, i) => {
    const lines: Slide["lines"] = [];
    let title = "";
    for (const frame of page.getElementsByTagNameNS(NS.draw, "frame")) {
      const cls = frame.getAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
        "class",
      );
      const texts = [
        ...frame.getElementsByTagNameNS(NS.text, "p"),
        ...frame.getElementsByTagNameNS(NS.text, "h"),
      ]
        .map((p) => {
          let level = 0;
          for (let e = p.parentElement; e && e !== frame; e = e.parentElement)
            if (e.localName === "list") level++;
          return { text: p.textContent ?? "", level: Math.max(0, level - 1) };
        })
        .filter((p) => p.text.trim());
      if (!title && cls === "title") title = texts.map((x) => x.text).join(" ");
      else lines.push(...texts);
    }
    const pictures = [...page.getElementsByTagNameNS(NS.draw, "image")]
      .map((im) => (im.getAttributeNS(NS.xlink, "href") ?? "").replace(/^\.\//, ""))
      .filter(Boolean);
    return {
      title: title || page.getAttributeNS(NS.draw, "name") || String(i + 1),
      lines,
      pictures,
    };
  });
}
