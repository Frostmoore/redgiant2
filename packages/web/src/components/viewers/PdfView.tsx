// PDF (G34.2), drawn by pdf.js in the page: pages drawn when they come into view, fitted to the
// panel or zoomed, a page number to jump to, and a search that marks the words it finds.
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconChevronDown, IconMinus, IconPlus, IconSearch } from "../../icons.js";
import { useOrders, useReport } from "../../viewers/live.js";
import type { ViewerProps } from "../../viewers/source.js";
import { zoomStep } from "./ImageView.js";

type PdfJs = typeof import("pdfjs-dist");
let loading: Promise<PdfJs> | undefined;
/** pdf.js and its worker, loaded the first time a PDF opens. */
function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const lib = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return loading;
}

/** The pages whose text holds the words (any case). */
export async function findPages(doc: PDFDocumentProxy, query: string): Promise<number[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const found: number[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
    if (text.toLowerCase().includes(q)) found.push(n);
  }
  return found;
}

function Page({
  doc,
  n,
  scale,
  query,
  guess,
}: {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  query: string;
  guess: { w: number; h: number };
}) {
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy>();
  const [seen, setSeen] = useState(false);
  // Drawn only once near the view: a long PDF opens at once.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), {
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (seen && !page) void doc.getPage(n).then(setPage, () => {});
  }, [seen]);
  useEffect(() => {
    const el = host.current;
    if (!page || !el) return;
    const lib = loading;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const layer = document.createElement("div");
    layer.className = "textLayer";
    el.replaceChildren(canvas, layer);
    el.style.setProperty("--total-scale-factor", String(scale));
    const task = page.render({
      canvas,
      viewport,
      ...(ratio !== 1 && { transform: [ratio, 0, 0, ratio, 0, 0] }),
    });
    let stopped = false;
    void task.promise
      .then(async () => {
        const PDF = await lib;
        if (stopped || !PDF) return;
        const text = new PDF.TextLayer({
          textContentSource: page.streamTextContent(),
          container: layer,
          viewport,
        });
        await text.render();
        if (stopped) return;
        const q = query.trim().toLowerCase();
        if (q)
          for (const span of layer.querySelectorAll("span"))
            if (span.textContent?.toLowerCase().includes(q)) span.classList.add("vw-hit");
      })
      .catch(() => {});
    return () => {
      stopped = true;
      task.cancel();
    };
  }, [page, scale, query]);
  const vp = page?.getViewport({ scale });
  return (
    <div
      class="vw-pdf-page"
      data-page={n}
      ref={host}
      style={{
        width: `${vp?.width ?? guess.w * scale}px`,
        height: `${vp?.height ?? guess.h * scale}px`,
      }}
    />
  );
}

export function PdfView({ src }: ViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [base, setBase] = useState({ w: 612, h: 792 });
  const [error, setError] = useState<string>();
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<number[] | null>(null);
  const [hit, setHit] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | undefined;
    void (async () => {
      try {
        const lib = await pdfjs();
        opened = await lib.getDocument({ url: src.url }).promise;
        const first = (await opened.getPage(1)).getViewport({ scale: 1 });
        if (!live) return void opened.destroy();
        setBase({ w: first.width, h: first.height });
        setDoc(opened);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
      void opened?.destroy();
    };
  }, [src.url]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);
  // A citation's page (G36.4): once the pages are laid out.
  const startPage = src.at?.page;
  useEffect(() => {
    if (!doc || !startPage || width <= 0) return;
    const n = Math.max(1, Math.min(doc.numPages, startPage));
    const id = requestAnimationFrame(() => requestAnimationFrame(() => go(n)));
    return () => cancelAnimationFrame(id);
  }, [doc, startPage, width > 0]);
  const fit = width > 80 ? Math.min(3, (width - 32) / base.w) : 1;
  const scale = zoom ?? fit;
  // Where the person is (G36.12), and an agent's moves: a page, a zoom, words to find.
  const report = useReport();
  useEffect(() => {
    if (doc)
      report({
        page: current,
        pages: doc.numPages,
        zoom: zoom === null ? undefined : Math.round(scale * 100),
      });
  }, [doc, current, zoom, scale]);
  useOrders(
    (d) => {
      if (!doc || (!d.page && d.zoom === undefined && !d.find)) return false;
      if (d.zoom !== undefined) setZoom(d.zoom === "fit" ? null : d.zoom / 100);
      if (d.find) {
        setTyped(d.find);
        void search(d.find);
      } else if (d.page) {
        const n = Math.max(1, Math.min(doc.numPages, d.page));
        requestAnimationFrame(() => requestAnimationFrame(() => go(n)));
      }
      return true;
    },
    !!doc && width > 0,
  );
  const go = (n: number) => {
    const el = scroller.current?.querySelector(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: "start" });
    setCurrent(n);
  };
  const search = async (words = typed) => {
    if (!doc) return;
    setQuery(words);
    const found = await findPages(doc, words);
    setHits(words.trim() ? found : null);
    setHit(0);
    if (found[0]) go(found[0]);
  };
  if (error)
    return (
      <div class="vw-empty">
        <strong>{t("vwPdfNo")}</strong>
        <p class="dim">{error}</p>
      </div>
    );
  if (!doc) return <div class="vw-empty dim">{t("loading")}</div>;
  return (
    <div class="vw-pdf">
      <div class="vw-bar">
        <span class="vw-pages">
          {t("vwPage")}
          <input
            type="number"
            min={1}
            max={doc.numPages}
            value={current}
            aria-label={t("vwPage")}
            onChange={(e) => {
              const n = Math.max(1, Math.min(doc.numPages, Number(e.currentTarget.value) || 1));
              go(n);
            }}
          />
          {t("vwOf", { n: String(doc.numPages) })}
        </span>
        <div class="vw-seg">
          <button
            type="button"
            title={t("vwZoomOut")}
            aria-label={t("vwZoomOut")}
            onClick={() => setZoom(zoomStep(scale, false))}
          >
            <IconMinus size={14} />
          </button>
          <button
            type="button"
            class={zoom === null ? "on" : ""}
            aria-pressed={zoom === null}
            onClick={() => setZoom(null)}
          >
            {zoom === null ? t("vwFitWidth") : `${Math.round(scale * 100)}%`}
          </button>
          <button
            type="button"
            title={t("vwZoomIn")}
            aria-label={t("vwZoomIn")}
            onClick={() => setZoom(zoomStep(scale, true))}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <div class="spacer" />
        <form
          class="vw-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <IconSearch size={14} />
          <input
            type="search"
            value={typed}
            placeholder={t("vwSearchPdf")}
            aria-label={t("vwSearchPdf")}
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </form>
        {hits && (
          <span class="vw-hits">
            {hits.length === 0 ? (
              <span class="dim">{t("vwNoHits")}</span>
            ) : (
              <>
                <span class="dim">
                  {t("vwHitPages", { n: String(hit + 1), all: String(hits.length) })}
                </span>
                <button
                  type="button"
                  class="vw-icon"
                  title={t("vwPrevHit")}
                  aria-label={t("vwPrevHit")}
                  onClick={() => {
                    const i = (hit - 1 + hits.length) % hits.length;
                    setHit(i);
                    go(hits[i] as number);
                  }}
                >
                  <span class="vw-flip">
                    <IconChevronDown size={14} />
                  </span>
                </button>
                <button
                  type="button"
                  class="vw-icon"
                  title={t("vwNextHit")}
                  aria-label={t("vwNextHit")}
                  onClick={() => {
                    const i = (hit + 1) % hits.length;
                    setHit(i);
                    go(hits[i] as number);
                  }}
                >
                  <IconChevronDown size={14} />
                </button>
              </>
            )}
          </span>
        )}
      </div>
      <div
        class="vw-pdf-pages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const top = el.scrollTop + 40;
          let n = 1;
          for (const p of el.querySelectorAll<HTMLElement>(".vw-pdf-page"))
            if (p.offsetTop <= top) n = Number(p.dataset.page);
          if (n !== current) setCurrent(n);
        }}
      >
        {Array.from({ length: Math.min(doc.numPages, 2000) }, (_, i) => (
          <Page key={i + 1} doc={doc} n={i + 1} scale={scale} query={query} guess={base} />
        ))}
      </div>
    </div>
  );
}
