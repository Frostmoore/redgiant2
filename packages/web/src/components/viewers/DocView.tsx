// Documents (G34.2): DOCX through mammoth (BSD-2-Clause, loaded only for a DOCX) and sanitised
// with DOMPurify; ODT read from its content.xml (office.ts builds the elements itself). A preview
// of the text with its basic formatting, not the page as printed.
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { odfToElements, parseXml, pictureUrls, unzip, utf8 } from "../../viewers/office.js";
import { useBytes, useText, type ViewerProps } from "../../viewers/source.js";

/** A DOCX as clean HTML: the person's text and pictures, nothing that runs. */
export async function docxHtml(bytes: Uint8Array): Promise<{ html: string; warnings: number }> {
  const mammoth = (await import("mammoth/mammoth.browser.min.js")).default;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const r = await mammoth.convertToHtml({ arrayBuffer: buffer as ArrayBuffer });
  return {
    html: DOMPurify.sanitize(r.value, { FORBID_TAGS: ["style", "form", "input"] }),
    warnings: r.messages.length,
  };
}

function Odt({ bytes, flat }: { bytes?: Uint8Array; flat?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let urls = new Map<string, string>();
    try {
      if (flat !== undefined) {
        el.replaceChildren(odfToElements(parseXml(flat), undefined, urls));
      } else if (bytes) {
        const files = unzip(
          bytes,
          (n) => n === "content.xml" || n === "styles.xml" || n.startsWith("Pictures/"),
        );
        urls = pictureUrls(files, /^Pictures\//);
        const styles = files["styles.xml"] ? parseXml(utf8(files["styles.xml"])) : undefined;
        el.replaceChildren(odfToElements(parseXml(utf8(files["content.xml"])), styles, urls));
      }
    } catch (err) {
      setError((err as Error).message);
    }
    return () => {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    };
  }, [bytes, flat]);
  if (error) return <div class="vw-empty">{t("vwDocNo")}</div>;
  return <article class="vw-doc-page md" ref={host} />;
}

function Docx({ bytes }: { bytes: Uint8Array }) {
  const [out, setOut] = useState<{ html: string; warnings: number }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void docxHtml(bytes).then(setOut, (e: unknown) => setError((e as Error).message));
  }, [bytes]);
  if (error) return <div class="vw-empty">{t("vwDocNo")}</div>;
  if (!out) return <div class="vw-empty dim">{t("loading")}</div>;
  return <article class="vw-doc-page md" dangerouslySetInnerHTML={{ __html: out.html }} />;
}

function Flat({ url }: { url: string }) {
  const { value, error } = useText(url);
  if (error) return <div class="vw-empty">{error}</div>;
  if (value === undefined) return <div class="vw-empty dim">{t("loading")}</div>;
  return <Odt flat={value} />;
}

function Zipped({ src }: ViewerProps) {
  const { value, error } = useBytes(src.url);
  if (error) return <div class="vw-empty">{error}</div>;
  if (!value) return <div class="vw-empty dim">{t("loading")}</div>;
  return src.format === "odt" ? <Odt bytes={value} /> : <Docx bytes={value} />;
}

export function DocView({ src }: ViewerProps) {
  return (
    <div class="vw-doc">
      <p class="vw-note">{t("vwDocPreview")}</p>
      {src.format === "fodt" ? <Flat url={src.url} /> : <Zipped src={src} />}
    </div>
  );
}
