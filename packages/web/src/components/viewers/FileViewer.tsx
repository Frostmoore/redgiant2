// One file in the canvas (G34.2): its first bytes are read, the viewer is chosen from them and
// the name (viewers/kind.ts), and only that viewer's code is loaded (each is its own chunk:
// pdf.js, three.js, SheetJS and mammoth come only when a file needs them). A file taken out of
// an archive opens here too, with the way back to the list.
import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconChevronLeft, IconDownload, IconFile } from "../../icons.js";
import { type ViewerKind, viewerFor } from "../../viewers/kind.js";
import {
  blobType,
  bytesText,
  download,
  peek,
  type ViewerProps,
  type ViewerSource,
} from "../../viewers/source.js";

type View = FunctionComponent<ViewerProps>;

/** Each kind's viewer, loaded the first time one is needed. */
export const VIEWERS: Record<ViewerKind, () => Promise<View>> = {
  video: () => import("./MediaView.js").then((m) => m.MediaView),
  audio: () => import("./MediaView.js").then((m) => m.MediaView),
  image: () => import("./ImageView.js").then((m) => m.ImageView),
  pdf: () => import("./PdfView.js").then((m) => m.PdfView),
  markdown: () => import("./CodeView.js").then((m) => m.CodeView),
  code: () => import("./CodeView.js").then((m) => m.CodeView),
  text: () => import("./CodeView.js").then((m) => m.CodeView),
  // A page from an archive is shown as its source: it never runs here.
  site: () => import("./CodeView.js").then((m) => m.CodeView),
  table: () => import("./TableView.js").then((m) => m.TableView),
  sheet: () => import("./TableView.js").then((m) => m.TableView),
  document: () => import("./DocView.js").then((m) => m.DocView),
  slides: () => import("./SlidesView.js").then((m) => m.SlidesView),
  model: () => import("./ModelView.js").then((m) => m.ModelView),
  archive: () => import("./ArchiveView.js").then((m) => m.ArchiveView),
  font: () => import("./FontView.js").then((m) => m.FontView),
  tree: () => import("./TreeView.js").then((m) => m.TreeView),
  layers: () => import("./OraView.js").then((m) => m.OraView),
  unknown: async () => UnknownView,
};

/** The card of a file no viewer knows: its name, size, kind, and the download. */
export function UnknownView({ src }: ViewerProps) {
  return (
    <div class="vw-empty vw-unknown">
      <span class="vw-unknown-icon">
        <IconFile size={34} />
      </span>
      <strong title={src.name}>{src.name}</strong>
      <dl>
        <dt>{t("vwSize")}</dt>
        <dd>{src.size !== undefined ? bytesText(src.size) : "-"}</dd>
        <dt>{t("vwType")}</dt>
        <dd>{src.format ? src.format.toUpperCase() : t("vwTypeUnknown")}</dd>
      </dl>
      <p class="dim">{t("vwUnknownText")}</p>
      <button type="button" class="vw-btn primary" onClick={() => download(src.url, src.name)}>
        <IconDownload size={16} />
        {t("vwDownload")}
      </button>
    </div>
  );
}

/** The chosen viewer, once its code is here. */
function Loaded({ src, open, convert }: ViewerProps) {
  const [view, setView] = useState<{ v: View }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setView(undefined);
    void VIEWERS[src.kind]().then(
      (v) => setView({ v }),
      (e: unknown) => setError((e as Error).message),
    );
  }, [src.kind]);
  if (error) return <UnknownView src={src} />;
  if (!view) return <div class="vw-empty dim">{t("loading")}</div>;
  const V = view.v;
  return <V src={src} {...(open && { open })} {...(convert && { convert })} />;
}

/** A file taken out of an archive, held as a blob URL while it is shown. */
interface Inner {
  name: string;
  url: string;
  size: number;
}

export function FileViewer({
  name,
  url,
  onKind,
  convert,
  at,
}: {
  name: string;
  url: string;
  /** Where to open it (a citation: page or line). */
  at?: ViewerSource["at"];
  /** Offered where a viewer cannot show the file as it is (G34.4). */
  convert?: () => void;
  /** Told which viewer was chosen (the canvas's bar shows it). */
  onKind?: (src: ViewerSource) => void;
}) {
  const [src, setSrc] = useState<ViewerSource>();
  const [error, setError] = useState<string>();
  const [inner, setInner] = useState<Inner>();
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setError(undefined);
    void peek(url).then(
      ({ head, size }) => {
        if (!live) return;
        const s: ViewerSource = {
          ...viewerFor(name, head),
          name,
          url,
          ...(size !== undefined && { size }),
        };
        setSrc(s);
        onKind?.(s);
      },
      (e: unknown) => {
        if (!live) return;
        // Not readable as a range: chosen from the name alone.
        const s: ViewerSource = { ...viewerFor(name), name, url };
        setSrc(s);
        setError((e as Error).message);
        onKind?.(s);
      },
    );
    return () => {
      live = false;
    };
  }, [url, name]);
  useEffect(() => () => inner && URL.revokeObjectURL(inner.url), [inner]);
  if (inner)
    return (
      <div class="vw-inner">
        <div class="vw-inner-bar">
          <button type="button" class="vw-toggle" onClick={() => setInner(undefined)}>
            <IconChevronLeft size={14} />
            {t("vwBackToArchive")}
          </button>
          <strong title={inner.name}>{inner.name}</strong>
          <span class="dim">{bytesText(inner.size)}</span>
          <div class="spacer" />
          <button
            type="button"
            class="vw-icon"
            title={t("vwDownload")}
            aria-label={t("vwDownload")}
            onClick={() => download(inner.url, inner.name)}
          >
            <IconDownload size={14} />
          </button>
        </div>
        <FileViewer name={inner.name} url={inner.url} />
      </div>
    );
  if (!src) return <div class="vw-empty dim">{t("loading")}</div>;
  if (error && src.kind === "unknown") return <div class="vw-empty">{error}</div>;
  return (
    <Loaded
      src={at ? { ...src, at } : src}
      {...(convert && { convert })}
      open={(innerName, bytes) => {
        const format = viewerFor(innerName, bytes.subarray(0, 512)).format;
        const blob = new Blob([bytes as BlobPart], { type: blobType(format) });
        setInner({ name: innerName, url: URL.createObjectURL(blob), size: bytes.length });
      }}
    />
  );
}
