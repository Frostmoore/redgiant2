import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const PDF = /\.pdf$/i;

/** What the side area opens instead of the editor. */
export const previewKind = (path: string): "image" | "pdf" | null =>
  IMAGE.test(path) ? "image" : PDF.test(path) ? "pdf" : null;

/** Downloads a workspace file as a blob URL, released when the view goes. */
export function useBlobUrl(scope: string, path: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    void attempt(() => getApi().download(scope, path)).then((blob) => {
      if (cancelled) return;
      if (!blob) return setFailed(true);
      made = URL.createObjectURL(
        // An SVG shown as an image runs no script; the right type makes it display.
        path.toLowerCase().endsWith(".svg") ? new Blob([blob], { type: "image/svg+xml" }) : blob,
      );
      setUrl(made);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [scope, path]);
  return { url, failed };
}

/** The pages of a PDF, drawn with pdf.js (loaded only when a PDF is opened). */
function PdfPages({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;
        setPages(doc.numPages);
        // A panel still being laid out measures 0: draw at a sensible width then.
        const measured = host.current?.parentElement?.clientWidth ?? 0;
        const width = measured > 200 ? measured - 24 : 760;
        for (let n = 1; n <= Math.min(doc.numPages, 200); n++) {
          const page = await doc.getPage(n);
          if (cancelled || !host.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2, width / base.width) * (window.devicePixelRatio || 1);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
          host.current.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (host.current) host.current.textContent = "";
    };
  }, [url]);
  return (
    <>
      {error && <div class="notice error">{error}</div>}
      {pages === null && !error && <div class="empty">{t("loading")}</div>}
      <div class="pdf-pages" ref={host} />
    </>
  );
}

/** A picture from the workspace inside the chat (generate_image's result); a click opens it. */
export function WorkspaceImage({ scope, path }: { scope: string; path: string }) {
  const { url, failed } = useBlobUrl(scope, path);
  if (failed) return <div class="dim">{path}</div>;
  if (!url) return <div class="drawing-frame" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" class="generated">
      <img src={url} alt={path} />
    </a>
  );
}

/** An image or a PDF from the workspace, read-only, with its download. */
export function Preview({ scope, path }: { scope: string; path: string }) {
  const { url, failed } = useBlobUrl(scope, path);
  const kind = previewKind(path);
  const name = path.split("/").pop() ?? path;
  return (
    <div class="editor">
      <div class="toolbar">
        <span class="path">{path}</span>
        {url && (
          <button
            type="button"
            onClick={() => {
              const a = document.createElement("a");
              a.href = url;
              a.download = name;
              a.click();
            }}
          >
            {t("download")}
          </button>
        )}
      </div>
      <div class="preview">
        {failed && <div class="empty">{t("cannotOpen")}</div>}
        {url && kind === "image" && <img src={url} alt={name} />}
        {url && kind === "pdf" && <PdfPages url={url} />}
      </div>
    </div>
  );
}
