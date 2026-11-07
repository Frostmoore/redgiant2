// Slides (G34.2): PPTX and ODP read in the page, one card per slide with its title, its text and
// its pictures, in order, plus the list of slides to jump to. Not the slide as designed: the
// layout, the effects and the fonts stay in the file (said above the cards).
import { useEffect, useMemo, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import {
  type Files,
  odpSlides,
  parseXml,
  pictureUrls,
  pptxSlides,
  type Slide,
  unzip,
  utf8,
} from "../../viewers/office.js";
import { useBytes, type ViewerProps } from "../../viewers/source.js";

export function readSlides(format: string, bytes: Uint8Array): { slides: Slide[]; files: Files } {
  if (format === "odp") {
    const files = unzip(bytes, (n) => n === "content.xml" || n.startsWith("Pictures/"));
    return { slides: odpSlides(parseXml(utf8(files["content.xml"]))), files };
  }
  const files = unzip(bytes, (n) => n.startsWith("ppt/"));
  return { slides: pptxSlides(files), files };
}

export function SlidesView({ src }: ViewerProps) {
  const { value, error } = useBytes(src.url);
  const read = useMemo(() => {
    if (!value) return undefined;
    try {
      return readSlides(src.format, value);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, [value]);
  const [urls, setUrls] = useState(new Map<string, string>());
  useEffect(() => {
    if (!read || "error" in read) return;
    const made = pictureUrls(read.files, src.format === "odp" ? /^Pictures\// : /^ppt\/media\//);
    setUrls(made);
    return () => {
      for (const u of made.values()) URL.revokeObjectURL(u);
    };
  }, [read]);
  if (error) return <div class="vw-empty">{error}</div>;
  if (!read) return <div class="vw-empty dim">{t("loading")}</div>;
  if ("error" in read) return <div class="vw-empty">{t("vwSlidesNo")}</div>;
  const { slides } = read;
  return (
    <div class="vw-slides">
      <nav class="vw-slide-list" aria-label={t("vwSlides")}>
        {slides.map((s, i) => (
          <a
            key={i}
            href={`#vw-slide-${i + 1}`}
            onClick={(e) => {
              e.preventDefault();
              e.currentTarget.ownerDocument
                .getElementById(`vw-slide-${i + 1}`)
                ?.scrollIntoView({ block: "start" });
            }}
          >
            <span class="vw-slide-no">{i + 1}</span>
            <span>{s.title || t("vwSlideN", { n: String(i + 1) })}</span>
          </a>
        ))}
      </nav>
      <div class="vw-slide-cards">
        <p class="vw-note">{t("vwSlidesPreview", { n: String(slides.length) })}</p>
        {slides.map((s, i) => (
          <section key={i} id={`vw-slide-${i + 1}`} class="vw-slide">
            <span class="vw-slide-no">{i + 1}</span>
            {s.title && <h3>{s.title}</h3>}
            {s.lines.length > 0 && (
              <ul>
                {s.lines.map((l, j) => (
                  <li key={j} style={{ marginLeft: `${l.level * 18}px` }}>
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
            {s.pictures.length > 0 && (
              <div class="vw-slide-pics">
                {s.pictures.map((p) =>
                  urls.get(p) ? <img key={p} src={urls.get(p)} alt="" /> : null,
                )}
              </div>
            )}
            {!s.title && s.lines.length === 0 && s.pictures.length === 0 && (
              <p class="dim">{t("vwSlideEmpty")}</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
