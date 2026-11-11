// PDFs in the canvas (G37.8): pdf.js 6's viewer with its annotation editor (highlight, text box,
// drawing) and the form's fields, inside the editor's shell (its bar and the panel «Modifiche»).
// The page shows the head revision the server writes; the person's gestures become the family's
// actions (pdf-ops on the server) and are sent as one revision when the gesture ends, then the
// page shows the file again. Notes, pictures, signatures and redactions are ours (a click or a
// drag on a page); pages turn, move and go from the side panel, which also lists the page's
// annotations to take out. A redaction asks first and is checked by the server before it lands.
// pdf.js's own small labels (inside its editors) are its English ones.
import type {
  DocChange,
  DocFile,
  PdfAnnot,
  PdfDocOp,
  PdfFieldValue,
  PdfOutline,
  PdfPlainAction,
  PdfRect,
} from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "preact/hooks";
import { announce } from "../../a11y.js";
import { type Key, t } from "../../i18n.js";
import {
  IconAlert,
  IconChevronDown,
  IconCursor,
  IconDownload,
  IconHighlighter,
  IconImage,
  IconMinus,
  IconNote,
  IconPencil,
  IconPlus,
  IconRedact,
  IconRotate,
  IconSearch,
  IconSignature,
  IconTrash,
  IconType,
  IconX,
} from "../../icons.js";
import { attempt, docView, getApi, openDoc, sendDoc } from "../../state.js";
import { useOrders, useReport } from "../../viewers/live.js";
import { Modal } from "../ui.js";

type PdfJs = typeof import("pdfjs-dist");
type ViewerMod = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type Viewer = InstanceType<ViewerMod["PDFViewer"]>;
type Bus = InstanceType<ViewerMod["EventBus"]>;

let loading: Promise<{ lib: PdfJs; ui: ViewerMod }> | undefined;
/** pdf.js, its worker, its viewer and the viewer's styles: loaded the first time a PDF is edited. */
function pdfjsEditor(): Promise<{ lib: PdfJs; ui: ViewerMod }> {
  loading ??= (async () => {
    const lib = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    // The viewer reads pdf.js from globalThis (set by the line above's import).
    const ui = await import("pdfjs-dist/web/pdf_viewer.mjs");
    await import("pdfjs-dist/web/pdf_viewer.css");
    return { lib, ui };
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

export const isPdfFile = (path: string) => /\.pdf$/i.test(path);

type Tool = "select" | "highlight" | "freetext" | "ink" | "note" | "stamp" | "sign" | "redact";
const TOOLS: {
  id: Tool;
  label: Key;
  hint?: Key;
  icon: (p: { size?: number }) => preact.JSX.Element;
}[] = [
  { id: "select", label: "pdfToolSelect", icon: IconCursor },
  { id: "highlight", label: "pdfToolHighlight", hint: "pdfHintHighlight", icon: IconHighlighter },
  { id: "freetext", label: "pdfToolText", hint: "pdfHintText", icon: IconType },
  { id: "ink", label: "pdfToolInk", hint: "pdfHintInk", icon: IconPencil },
  { id: "note", label: "pdfToolNote", hint: "pdfHintNote", icon: IconNote },
  { id: "stamp", label: "pdfToolImage", hint: "pdfHintImage", icon: IconImage },
  { id: "sign", label: "pdfToolSign", hint: "pdfHintSign", icon: IconSignature },
  { id: "redact", label: "pdfToolRedact", hint: "pdfHintRedact", icon: IconRedact },
];
/** pdf.js's own editors for the tools that have one. */
const EDITOR_MODE: Partial<Record<Tool, number>> = { highlight: 9, freetext: 3, ink: 15 };

const ANNOT_WORDS: Record<string, Key> = {
  highlight: "pdfKindHighlight",
  underline: "pdfKindUnderline",
  strikeout: "pdfKindStrike",
  freetext: "pdfKindText",
  ink: "pdfKindInk",
  note: "pdfKindNote",
  square: "pdfKindBox",
  stamp: "pdfKindStamp",
  signature: "pdfKindSign",
  link: "pdfKindLink",
};

const wrap = (ops: PdfPlainAction[]): PdfDocOp => ({
  family: "pdf",
  engine: "redgiant-pdf",
  engineVersion: "1",
  op: ops.length === 1 ? (ops[0] as PdfPlainAction) : { t: "batch", ops },
});
const newId = () => `p-${Math.random().toString(36).slice(2, 10)}`;
let asks = 0;
const askId = () => `pdf${Date.now().toString(36)}${(asks++).toString(36)}`;

/** Numbers pdf.js serializes as typed arrays or as objects with numeric keys. */
function numbers(v: unknown): number[] {
  if (!v) return [];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
  if (typeof v === "object") return Object.values(v as Record<string, number>);
  return [];
}
const rgb255 = (c: unknown): [number, number, number] | undefined => {
  const n = numbers(c);
  if (n.length < 3) return undefined;
  const k = n.some((x) => x > 1) ? 255 : 1;
  return [n[0] as number, n[1] as number, n[2] as number].map((x) =>
    Math.max(0, Math.min(1, x / k)),
  ) as [number, number, number];
};
const rectOf = (v: unknown): PdfRect | undefined => {
  const n = numbers(v);
  if (n.length < 4 || !n.every(Number.isFinite)) return undefined;
  return [
    Math.min(n[0] as number, n[2] as number),
    Math.min(n[1] as number, n[3] as number),
    Math.max(n[0] as number, n[2] as number),
    Math.max(n[1] as number, n[3] as number),
  ];
};

/** One of pdf.js's editors, serialized, as the family's actions. */
export function editorActions(
  v: Record<string, unknown>,
  o: PdfOutline,
  id: () => string,
): PdfPlainAction[] {
  const page = Number(v.pageIndex);
  if (!Number.isInteger(page) || !o.pages[page]) return [];
  const out: PdfPlainAction[] = [];
  // An annotation of the file changed or taken out in pdf.js: it goes, the new one comes.
  const existing = typeof v.id === "string" && v.id ? v.id : undefined;
  if (existing) {
    const info = o.pages[page]?.annots.find((a) => a.ref === existing || a.id === existing);
    if (info) out.push({ t: "remove_annotation", page, id: info.id, info });
    if (v.deleted) return out;
  }
  const rect = rectOf(v.rect);
  if (!rect) return out;
  const type = Number(v.annotationType);
  let a: PdfAnnot | undefined;
  if (type === 9) {
    const q = numbers(v.quadPoints);
    a = {
      id: id(),
      page,
      kind: "highlight",
      rect,
      ...(q.length >= 8 && { quads: q.slice(0, q.length - (q.length % 8)) }),
      color: rgb255(v.color) ?? [1, 0.92, 0.23],
      ...(typeof v.opacity === "number" && v.opacity < 1 && { opacity: v.opacity }),
    };
  } else if (type === 3) {
    const text = String(v.value ?? "");
    if (!text.trim()) return out;
    a = {
      id: id(),
      page,
      kind: "freetext",
      rect,
      text,
      size: Number(v.fontSize) || 12,
      color: rgb255(v.color) ?? [0, 0, 0],
    };
  } else if (type === 15) {
    const p = v.paths as { points?: unknown[] } | undefined;
    const paths = (p?.points ?? [])
      .map(numbers)
      .map((x) => x.filter(Number.isFinite))
      .filter((x) => x.length >= 2 && x.length % 2 === 0)
      .map((x) => x.map((n) => Math.round(n * 100) / 100));
    if (!paths.length) return out;
    a = {
      id: id(),
      page,
      kind: "ink",
      rect,
      paths,
      size: Number(v.thickness) || 1,
      color: rgb255(v.color) ?? [0, 0, 0],
      ...(typeof v.opacity === "number" && v.opacity < 1 && { opacity: v.opacity }),
    };
  }
  if (a) out.push({ t: "annotate", a });
  return out;
}

interface Widget {
  name: string;
  type: string;
  exportValue?: string;
}

/** A drag or a click on a page, in the page's PDF points. */
interface Mark {
  page: number;
  rect: PdfRect;
}

export function PdfEditor({
  file,
  page: startPage,
  onReveal,
}: {
  file: DocFile;
  /** A citation's page (1-based). */
  page?: number | undefined;
  onReveal?: (f: ((c: DocChange) => void) | undefined) => void;
}) {
  const scroller = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<PdfOutline>();
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [failed, setFailed] = useState<string>();
  const [tool, setToolNow] = useState<Tool>("select");
  const [current, setCurrent] = useState(1);
  const [scale, setScale] = useState<number | null>(null);
  // The pages' panel opens on demand: the canvas is often narrow beside the chat.
  const [side, setSide] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [redactions, setRedactions] = useState<Mark[]>([]);
  const [confirmRedact, setConfirmRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [ask, setAsk] = useState<{ kind: "note"; mark: Mark } | { kind: "sign" } | undefined>();
  const [picture, setPicture] = useState<{
    blob: string;
    mime: "image/png" | "image/jpeg";
    w: number;
    h: number;
  }>();
  const [signature, setSignature] = useState<
    | { paths: number[][]; w: number; h: number }
    | { blob: string; mime: "image/png" | "image/jpeg"; w: number; h: number }
  >();
  const [versions, setVersions] = useState<{ name: string; size: number; at: string }[]>();
  const [query, setQuery] = useState("");
  const live = useRef<{
    lib?: PdfJs;
    ui?: ViewerMod;
    viewer?: Viewer;
    bus?: Bus;
    doc?: PDFDocumentProxy;
    /** The loading task: destroying it ends the document (pdf.js 6). */
    task?: { destroy(): Promise<void> };
    outline?: PdfOutline;
    widgets: Map<string, Widget>;
    sent: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
    waiting: Map<string, boolean>;
    reloading: boolean;
    again: boolean;
    flash?: number;
    tool: Tool;
  }>({
    widgets: new Map(),
    sent: new Set(),
    waiting: new Map(),
    reloading: false,
    again: false,
    tool: "select",
  });
  const pickRef = useRef<HTMLInputElement>(null);
  const report = useReport();

  const setTool = (next: Tool) => {
    setToolNow(next);
    live.current.tool = next;
    const v = live.current.viewer;
    const mode = EDITOR_MODE[next] ?? 0;
    if (v)
      try {
        v.annotationEditorMode = { mode };
      } catch {
        // The editor is not ready yet: the mode is set when the document is shown.
      }
    if (next === "stamp" && !picture) pickRef.current?.click();
    if (next === "sign" && !signature) setAsk({ kind: "sign" });
  };

  /** The person's edits in pdf.js (annotations, fields), sent as one revision. */
  const commit = () => {
    const L = live.current;
    const d = L.doc;
    const o = L.outline;
    if (!d || !o) return;
    // Still typing in a field or a text box: later.
    const el = document.activeElement;
    if (
      el &&
      scroller.current?.contains(el) &&
      (el.matches("input,textarea,select") || (el as HTMLElement).isContentEditable)
    ) {
      L.timer = setTimeout(commit, 1200);
      return;
    }
    const map = (d.annotationStorage.serializable as { map?: Map<string, Record<string, unknown>> })
      .map;
    if (!map?.size) return;
    const ops: PdfPlainAction[] = [];
    let annots = false;
    const radios = new Map<string, string>();
    for (const [key, v] of map) {
      if (L.sent.has(`${key}:${JSON.stringify(v.value ?? null)}`)) continue;
      if (typeof v.annotationType === "number") {
        if (L.sent.has(key)) continue;
        const made = editorActions(v, o, newId);
        L.sent.add(key);
        if (made.length) {
          ops.push(...made);
          annots = true;
        }
        continue;
      }
      const w = L.widgets.get(key);
      if (!w || !("value" in v)) continue;
      L.sent.add(`${key}:${JSON.stringify(v.value ?? null)}`);
      const f = o.fields.find((x) => x.name === w.name);
      if (!f || f.readOnly) continue;
      let value: PdfFieldValue;
      if (f.type === "radio") {
        if (v.value === true && w.exportValue) radios.set(f.name, w.exportValue);
        continue;
      }
      if (f.type === "checkbox")
        value = v.value === true || (typeof v.value === "string" && v.value !== "Off");
      else if (f.type === "list") value = numbers(v.value).length ? (v.value as string[]) : [];
      else value = Array.isArray(v.value) ? String(v.value[0] ?? "") : String(v.value ?? "");
      if (JSON.stringify(value) === JSON.stringify(f.value)) continue;
      ops.push({ t: "fill_field", name: f.name, value, before: f.value });
      f.value = value;
    }
    for (const [name, value] of radios) {
      const f = o.fields.find((x) => x.name === name);
      if (!f || f.value === value) continue;
      ops.push({ t: "fill_field", name, value, before: f.value });
      f.value = value;
    }
    if (ops.length) send(ops, annots);
  };

  /** Actions of the person, as one revision; the page shows the file again when they draw. */
  const send = (ops: PdfPlainAction[], reload: boolean) => {
    const clientId = askId();
    live.current.waiting.set(clientId, reload);
    sendDoc({
      type: "doc.ops",
      file,
      clientId,
      baseRevision: docView(file).value.revision,
      ops: [wrap(ops)],
      groupId: `g-${Math.random().toString(36).slice(2, 10)}`,
    });
  };

  /** The head revision shown again, at the same place. */
  const reload = async (flashPage?: number) => {
    const L = live.current;
    if (L.reloading) {
      L.again = true;
      return;
    }
    L.reloading = true;
    try {
      const [o, bytes] = await Promise.all([
        getApi().pdfOutline(file.scope, file.path),
        getApi().pdfFile(file.scope, file.path),
      ]);
      L.outline = o.outline;
      setOutline(o.outline);
      await show(bytes, flashPage);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      L.reloading = false;
      if (L.again) {
        L.again = false;
        void reload();
      }
    }
  };

  const show = async (bytes: Uint8Array, flashPage?: number) => {
    const L = live.current;
    const el = scroller.current;
    if (!el) return;
    const { lib, ui } = await pdfjsEditor();
    L.lib = lib;
    L.ui = ui;
    const task = lib.getDocument({ data: bytes });
    const next = await task.promise;
    if (!L.viewer) {
      const bus = new ui.EventBus();
      const link = new ui.PDFLinkService({ eventBus: bus });
      const find = new ui.PDFFindController({ eventBus: bus, linkService: link });
      const viewer = new ui.PDFViewer({
        container: el,
        viewer: el.firstElementChild as HTMLDivElement,
        eventBus: bus,
        linkService: link,
        findController: find,
        annotationMode: lib.AnnotationMode.ENABLE_FORMS,
        annotationEditorMode: lib.AnnotationEditorType.NONE,
        annotationEditorHighlightColors:
          "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F",
      } as never);
      link.setViewer(viewer);
      (viewer as unknown as { _link: unknown })._link = link;
      bus.on("pagechanging", (e: { pageNumber: number }) => setCurrent(e.pageNumber));
      bus.on("scalechanging", (e: { scale: number }) => setScale(e.scale));
      // pdf.js gives a form's fields no name a screen reader can say (p3.5.11): their own.
      bus.on("annotationlayerrendered", (e: { source?: { div?: HTMLElement } }) => {
        if (e.source?.div) nameFields(e.source.div);
      });
      bus.on("annotationeditorstateschanged", () => schedule());
      bus.on("switchannotationeditormode", () => schedule());
      L.viewer = viewer;
      L.bus = bus;
    }
    const viewer = L.viewer as Viewer;
    const keep = L.doc
      ? { top: el.scrollTop, left: el.scrollLeft, scale: viewer.currentScaleValue }
      : undefined;
    const old = L.task;
    L.doc = next;
    L.task = task;
    L.sent = new Set();
    (next.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () =>
      schedule();
    viewer.setDocument(next);
    (viewer as unknown as { _link: { setDocument(d: unknown): void } })._link.setDocument(next);
    await new Promise<void>((r) => L.bus?.on("pagesinit", () => r(), { once: true }));
    viewer.currentScaleValue = keep
      ? keep.scale
      : el.clientWidth < 600
        ? "page-width"
        : "page-width";
    if (keep) {
      el.scrollTop = keep.top;
      el.scrollLeft = keep.left;
    }
    const mode = EDITOR_MODE[L.tool] ?? 0;
    try {
      viewer.annotationEditorMode = { mode };
    } catch {
      // Set once the editor is up.
    }
    // The form's widgets by their pdf.js ids: which field and, for radio buttons, which value.
    const widgets = new Map<string, Widget>();
    if (L.outline?.fields.length)
      for (let p = 1; p <= next.numPages; p++) {
        const list = (await (await next.getPage(p)).getAnnotations().catch(() => [])) as {
          id: string;
          subtype: string;
          fieldName?: string;
          fieldType?: string;
          radioButton?: boolean;
          checkBox?: boolean;
          buttonValue?: string;
          exportValue?: string;
        }[];
        for (const a of list)
          if (a.subtype === "Widget" && a.fieldName)
            widgets.set(a.id, {
              name: a.fieldName,
              type: a.radioButton ? "radio" : a.checkBox ? "checkbox" : (a.fieldType ?? ""),
              ...(a.radioButton &&
                a.buttonValue !== undefined && { exportValue: String(a.buttonValue) }),
            });
      }
    L.widgets = widgets;
    setDoc(next);
    void old?.destroy();
    if (flashPage) {
      viewer.currentPageNumber = flashPage;
      const div = el.querySelector(`.page[data-page-number="${flashPage}"]`);
      div?.classList.add("pdfed-flash");
      window.clearTimeout(L.flash);
      L.flash = window.setTimeout(() => div?.classList.remove("pdfed-flash"), 2600);
    }
  };

  const schedule = () => {
    const L = live.current;
    if (L.timer) clearTimeout(L.timer);
    L.timer = setTimeout(commit, 1200);
  };

  useEffect(() => {
    let closed = false;
    const close = openDoc(file, {
      opened(snapshot) {
        if (snapshot.family !== "pdf") return;
        live.current.outline = snapshot.outline;
        setOutline(snapshot.outline);
        void reload().then(() => {
          if (!closed && startPage && live.current.viewer)
            live.current.viewer.currentPageNumber = Math.max(
              1,
              Math.min(snapshot.outline.pages.length, startPage),
            );
        });
      },
      replaced() {
        void reload();
      },
      changed(m) {
        const p = m.change.summary.pdf?.page;
        void reload(m.change.author !== "person" ? p : undefined);
      },
      ack(m) {
        const wanted = live.current.waiting.get(m.clientId);
        live.current.waiting.delete(m.clientId);
        if (wanted) void reload();
      },
      rejected(m) {
        live.current.waiting.delete(m.clientId);
        setNotice(t("docRefused", { reason: m.reason }));
        void reload();
      },
    });
    onReveal?.((c) => {
      const p = c.summary.pdf?.page;
      if (p && live.current.viewer) live.current.viewer.currentPageNumber = p;
    });
    return () => {
      closed = true;
      const L = live.current;
      if (L.timer) clearTimeout(L.timer);
      commit();
      close();
      onReveal?.(undefined);
      void L.task?.destroy();
      L.viewer = undefined;
      L.doc = undefined;
    };
  }, [file.scope, file.path]);

  // Where the person is (G36.12), and an agent's moves: a page, a zoom, words to find.
  useEffect(() => {
    if (doc)
      report({
        page: current,
        pages: doc.numPages,
        zoom: scale ? Math.round(scale * 100) : undefined,
      });
  }, [doc, current, scale]);
  useOrders((d) => {
    const v = live.current.viewer;
    if (!v || !doc || (!d.page && d.zoom === undefined && !d.find)) return false;
    if (d.zoom !== undefined)
      v.currentScaleValue = d.zoom === "fit" ? "page-width" : String(d.zoom / 100);
    if (d.find) find(d.find);
    else if (d.page) v.currentPageNumber = Math.max(1, Math.min(doc.numPages, d.page));
    return true;
  }, !!doc);

  // Pages from the keyboard (p3.5.11): Page Down / Page Up, Home and End on the pages (outside a
  // field), said as «Pagina 3 di 5».
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      const v = live.current.viewer;
      const total = live.current.doc?.numPages ?? 0;
      const tgt = e.target as HTMLElement;
      if (!v || !total || e.altKey || e.ctrlKey || e.metaKey) return;
      if (tgt.matches?.("input,textarea,select") || tgt.isContentEditable) return;
      const to = pageKey(e.key, v.currentPageNumber, total);
      if (to === undefined) return;
      e.preventDefault();
      v.currentPageNumber = to;
      announce(t("pdfPageOf", { n: String(to), total: String(total) }));
    };
    el.addEventListener("keydown", key);
    return () => el.removeEventListener("keydown", key);
  }, [file.scope, file.path]);

  // Ctrl+Z (Cmd+Z) outside a field or a text box: the person's own last change, taken back (their
  // stack, never an agent's: those are undone from the panel «Modifiche»).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "z")
        return;
      const tgt = e.target as HTMLElement;
      if (tgt.matches?.("input,textarea,select") || tgt.isContentEditable) return;
      const mine = docView(file).value.changes.find(
        (c) => c.author === PERSON && !c.undoneBy && !c.undoOf && !c.replaced,
      );
      if (!mine) return;
      e.preventDefault();
      sendDoc({ type: "doc.undo", file, clientId: askId(), revision: mine.revision });
    };
    el.addEventListener("keydown", key);
    return () => el.removeEventListener("keydown", key);
  }, [file.scope, file.path]);

  // The person typing in a field or a text box holds the file a moment against the agents.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const typing = (e: Event) => {
      const tgt = e.target as HTMLElement;
      if (tgt.matches?.("input,textarea,select") || tgt.isContentEditable)
        sendDoc({ type: "doc.presence", file, editing: true });
    };
    const left = () => {
      sendDoc({ type: "doc.presence", file, editing: false });
      schedule();
    };
    el.addEventListener("input", typing);
    el.addEventListener("focusout", left);
    return () => {
      el.removeEventListener("input", typing);
      el.removeEventListener("focusout", left);
    };
  }, [file.scope, file.path]);

  const find = (q: string) => {
    setQuery(q);
    live.current.bus?.dispatch("find", {
      source: null,
      type: "",
      query: q,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    });
  };

  // ---- our own tools: a click or a drag on a page ----------------------------------------------

  /** Where a pointer is on a page, in PDF points: the page under it, or the one given (a drag). */
  const markAt = (
    e: PointerEvent,
    on?: HTMLElement,
  ): { page: number; x: number; y: number; div: HTMLElement } | undefined => {
    const div = on ?? ((e.target as HTMLElement).closest?.(".page") as HTMLElement | null);
    const v = live.current.viewer;
    if (!div || !v) return undefined;
    const n = Number(div.dataset.pageNumber);
    const pv = v.getPageView(n - 1) as unknown as {
      viewport: { convertToPdfPoint(x: number, y: number): number[] };
      div: HTMLElement;
    };
    const box = (div.querySelector(".canvasWrapper") ?? div).getBoundingClientRect();
    const [x, y] = pv.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top) as [
      number,
      number,
    ];
    return { page: n - 1, x, y, div };
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let start:
      | { page: number; x: number; y: number; cx: number; cy: number; div: HTMLElement }
      | undefined;
    let band: HTMLDivElement | undefined;
    const ours = () => ["note", "stamp", "sign", "redact"].includes(live.current.tool);
    const down = (e: PointerEvent) => {
      if (!ours() || e.button !== 0) return;
      const m = markAt(e);
      if (!m) return;
      e.preventDefault();
      start = { ...m, cx: e.clientX, cy: e.clientY };
      band = document.createElement("div");
      band.className = `pdfed-band ${live.current.tool}`;
      m.div.appendChild(band);
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!start || !band) return;
      const r = start.div.getBoundingClientRect();
      const x1 = Math.min(start.cx, e.clientX) - r.left;
      const y1 = Math.min(start.cy, e.clientY) - r.top;
      Object.assign(band.style, {
        left: `${x1}px`,
        top: `${y1}px`,
        width: `${Math.abs(e.clientX - start.cx)}px`,
        height: `${Math.abs(e.clientY - start.cy)}px`,
      });
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const s = start;
      start = undefined;
      band?.remove();
      band = undefined;
      // The pointer is captured: the end is read on the page the drag started on.
      const m = markAt(e, s.div) ?? { page: s.page, x: s.x, y: s.y, div: s.div };
      const dragged = Math.abs(e.clientX - s.cx) > 6 || Math.abs(e.clientY - s.cy) > 6;
      const rect: PdfRect = [
        Math.min(s.x, m.x),
        Math.min(s.y, m.y),
        Math.max(s.x, m.x),
        Math.max(s.y, m.y),
      ];
      placedRef.current(s.page, dragged ? rect : undefined, s.x, s.y);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
  }, []);

  // The pointer's listeners stay for the editor's life (a drag survives a render): they call this.
  const placedRef = useRef<(page: number, rect: PdfRect | undefined, x: number, y: number) => void>(
    () => {},
  );
  placedRef.current = (page, rect, x, y) => placed(page, rect, x, y);
  /** A tool used on a page: at a point (a click) or over an area (a drag). */
  const placed = (page: number, rect: PdfRect | undefined, x: number, y: number) => {
    const tool = live.current.tool;
    if (tool === "note") setAsk({ kind: "note", mark: { page, rect: [x, y - 20, x + 20, y] } });
    else if (tool === "redact") {
      if (rect && rect[2] - rect[0] > 2 && rect[3] - rect[1] > 2)
        setRedactions((r) => [...r, { page, rect }]);
    } else if (tool === "stamp" || tool === "sign") {
      const what = tool === "stamp" ? picture : signature;
      if (!what) return tool === "stamp" ? pickRef.current?.click() : setAsk({ kind: "sign" });
      const w0 = tool === "sign" ? 160 : 180;
      const h0 = (w0 * what.h) / Math.max(1, what.w);
      const r: PdfRect = rect ?? [x - w0 / 2, y - h0 / 2, x + w0 / 2, y + h0 / 2];
      const a: PdfAnnot =
        "paths" in what
          ? {
              id: newId(),
              page,
              kind: "signature",
              rect: r,
              paths: what.paths.map((p) =>
                p
                  .map((n, i) =>
                    i % 2 === 0
                      ? r[0] + (n / what.w) * (r[2] - r[0])
                      : r[3] - (n / what.h) * (r[3] - r[1]),
                  )
                  .map((n) => Math.round(n * 100) / 100),
              ),
              size: 1.6,
              color: [0.05, 0.1, 0.35],
            }
          : {
              id: newId(),
              page,
              kind: tool === "sign" ? "signature" : "stamp",
              rect: r,
              image: { blob: what.blob, mime: what.mime },
            };
      send([{ t: "annotate", a }], true);
    }
  };

  const pickPicture = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const img = await createImageBitmap(new Blob([bytes])).catch(() => undefined);
    const up = await getApi().pdfBlob(file.scope, file.path, bytes);
    return { ...up, w: img?.width ?? 300, h: img?.height ?? 150 };
  };

  const redactNow = async () => {
    setConfirmRedact(false);
    setRedacting(true);
    setNotice(undefined);
    try {
      const byPage = new Map<number, PdfRect[]>();
      for (const r of redactions) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r.rect]);
      for (const [page, rects] of byPage)
        await getApi().pdfRedact({ scope: file.scope, path: file.path, page, rects });
      setRedactions([]);
      setTool("select");
    } catch (e) {
      setNotice(t("pdfRedactFailed", { reason: (e as Error).message }));
    } finally {
      setRedacting(false);
    }
  };

  // The redactions marked, drawn on their pages.
  useEffect(() => {
    const el = scroller.current;
    const v = live.current.viewer;
    if (!el) return;
    for (const old of el.querySelectorAll(".pdfed-redact-mark")) old.remove();
    if (!v) return;
    for (const r of redactions) {
      const pv = v.getPageView(r.page) as unknown as
        | {
            viewport: { convertToViewportPoint(x: number, y: number): number[] };
            div: HTMLElement;
          }
        | undefined;
      if (!pv?.div) continue;
      const [a, b] = pv.viewport.convertToViewportPoint(r.rect[0], r.rect[1]) as [number, number];
      const [c, d] = pv.viewport.convertToViewportPoint(r.rect[2], r.rect[3]) as [number, number];
      const m = document.createElement("div");
      m.className = "pdfed-redact-mark";
      Object.assign(m.style, {
        left: `${Math.min(a, c)}px`,
        top: `${Math.min(b, d)}px`,
        width: `${Math.abs(c - a)}px`,
        height: `${Math.abs(d - b)}px`,
      });
      pv.div.appendChild(m);
    }
  }, [redactions, doc, scale]);

  // ---- pages ----------------------------------------------------------------------------------

  const pageOp = (op: PdfPlainAction) => send([op], true);
  const o = outline;
  const curPage = o?.pages[current - 1];
  const readOnly = !!o?.encrypted;
  const hint = TOOLS.find((x) => x.id === tool)?.hint;

  if (failed)
    return (
      <div class="vw-empty">
        <strong>{t("vwPdfNo")}</strong>
        <p class="dim">{failed}</p>
      </div>
    );
  return (
    <div class={`pdfed ${side ? "with-side" : ""} tool-${tool}`}>
      <div class="vw-bar pdfed-bar" role="toolbar" aria-label={t("pdfTools")}>
        {!readOnly && (
          <div class="vw-seg pdfed-tools">
            {TOOLS.map((x) => (
              <button
                key={x.id}
                type="button"
                class={tool === x.id ? "on" : ""}
                aria-pressed={tool === x.id}
                title={t(x.label)}
                aria-label={t(x.label)}
                onClick={() => setTool(x.id)}
              >
                <x.icon size={15} />
                <span class="pdfed-tool-name">{t(x.label)}</span>
              </button>
            ))}
          </div>
        )}
        <span class="vw-pages">
          {t("vwPage")}
          <input
            type="number"
            min={1}
            max={doc?.numPages ?? 1}
            value={current}
            aria-label={t("vwPage")}
            onChange={(e) => {
              const n = Number(e.currentTarget.value) || 1;
              if (live.current.viewer)
                live.current.viewer.currentPageNumber = Math.max(
                  1,
                  Math.min(doc?.numPages ?? 1, n),
                );
            }}
          />
          {t("vwOf", { n: String(doc?.numPages ?? 0) })}
        </span>
        <div class="vw-seg">
          <button
            type="button"
            title={t("vwZoomOut")}
            aria-label={t("vwZoomOut")}
            onClick={() => live.current.viewer?.decreaseScale()}
          >
            <IconMinus size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (live.current.viewer) live.current.viewer.currentScaleValue = "page-width";
            }}
          >
            {scale ? `${Math.round(scale * 100)}%` : t("vwFitWidth")}
          </button>
          <button
            type="button"
            title={t("vwZoomIn")}
            aria-label={t("vwZoomIn")}
            onClick={() => live.current.viewer?.increaseScale()}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <form
          class="vw-search pdfed-search"
          onSubmit={(e) => {
            e.preventDefault();
            find(query);
          }}
        >
          <IconSearch size={14} />
          <input
            type="search"
            value={query}
            placeholder={t("vwSearchPdf")}
            aria-label={t("vwSearchPdf")}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </form>
        <div class="spacer" />
        <button
          type="button"
          class={`vw-toggle ${side ? "on" : ""}`}
          aria-pressed={side}
          onClick={() => setSide(!side)}
        >
          {t("pdfPages")}
        </button>
      </div>
      {(hint && tool !== "select") || o?.signed || readOnly ? (
        <div class="pdfed-hint" role="status">
          {readOnly ? (
            <>
              <IconAlert size={14} /> {t("pdfEncrypted")}
            </>
          ) : o?.signed ? (
            <>
              <IconAlert size={14} /> {t("pdfSigned")}
            </>
          ) : null}
          {hint && tool !== "select" && <span>{t(hint)}</span>}
          {tool === "stamp" && picture && (
            <button type="button" class="link" onClick={() => pickRef.current?.click()}>
              {t("pdfPickPicture")}
            </button>
          )}
          {tool === "sign" && signature && (
            <button type="button" class="link" onClick={() => setAsk({ kind: "sign" })}>
              {t("pdfSignTitle")}
            </button>
          )}
        </div>
      ) : null}
      {notice && (
        <div class="doc-notice" role="alert">
          <span>{notice}</span>
          <button
            type="button"
            class="vw-icon"
            aria-label={t("pdfCancel")}
            onClick={() => setNotice(undefined)}
          >
            <IconX size={13} />
          </button>
        </div>
      )}
      <div class="pdfed-main">
        <div class="pdfed-view">
          <section
            class="pdfed-scroll"
            ref={scroller}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the pages take the keyboard (Page Down, Home, End)
            tabIndex={0}
            aria-label={
              doc
                ? t("pdfPagesRegion", {
                    name: fileNameOf(file.path),
                    n: String(current),
                    total: String(doc.numPages),
                  })
                : t("loading")
            }
          >
            <div class="pdfViewer" />
          </section>
          {!doc && <div class="vw-empty dim pdfed-loading">{t("loading")}</div>}
          {redactions.length > 0 && (
            <div class="pdfed-redact-bar" role="status">
              <span>
                {redactions.length === 1
                  ? t("pdfRedactArea1")
                  : t("pdfRedactAreas", { n: String(redactions.length) })}
              </span>
              <button
                type="button"
                class="vw-btn small danger"
                disabled={redacting}
                onClick={() => setConfirmRedact(true)}
              >
                <IconRedact size={14} />
                {redacting ? t("pdfRedacting") : t("pdfRedactDo")}
              </button>
              <button
                type="button"
                class="vw-btn small"
                disabled={redacting}
                onClick={() => setRedactions([])}
              >
                {t("pdfCancel")}
              </button>
            </div>
          )}
        </div>
        {side && o && (
          <aside class="pdfed-side" aria-label={t("pdfPages")}>
            <p class="dim pdfed-side-note">{t("pdfPagesNote")}</p>
            <ol class="pdfed-thumbs">
              {o.pages.map((p, i) => (
                <li key={p.pid} class={i + 1 === current ? "on" : ""}>
                  <button
                    type="button"
                    class="pdfed-thumb"
                    aria-label={`${t("vwPage")} ${i + 1}`}
                    onClick={() => {
                      if (live.current.viewer) live.current.viewer.currentPageNumber = i + 1;
                    }}
                  >
                    {doc && <Thumb doc={doc} n={i + 1} />}
                    <span>{i + 1}</span>
                  </button>
                  {!readOnly && (
                    <div class="pdfed-page-acts">
                      <button
                        type="button"
                        class="vw-icon"
                        title={t("pdfRotateRight")}
                        aria-label={t("pdfRotateRight")}
                        onClick={() =>
                          pageOp({
                            t: "rotate_page",
                            page: i,
                            to: (p.rotate + 90) % 360,
                            before: p.rotate,
                          })
                        }
                      >
                        <IconRotate size={14} />
                      </button>
                      <button
                        type="button"
                        class="vw-icon"
                        title={t("pdfMoveUp")}
                        aria-label={t("pdfMoveUp")}
                        disabled={i === 0}
                        onClick={() => pageOp({ t: "move_page", from: i, to: i - 1 })}
                      >
                        <span class="vw-flip">
                          <IconChevronDown size={14} />
                        </span>
                      </button>
                      <button
                        type="button"
                        class="vw-icon"
                        title={t("pdfMoveDown")}
                        aria-label={t("pdfMoveDown")}
                        disabled={i === o.pages.length - 1}
                        onClick={() => pageOp({ t: "move_page", from: i, to: i + 1 })}
                      >
                        <IconChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        class="vw-icon"
                        title={t("pdfDeletePage")}
                        aria-label={t("pdfDeletePage")}
                        disabled={o.pages.length < 2}
                        onClick={() => pageOp({ t: "delete_page", page: i, info: p })}
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <h4>{t("pdfAnnotsHere", { page: String(current) })}</h4>
            {!curPage?.annots.length ? (
              <p class="dim">{t("pdfNoAnnots")}</p>
            ) : (
              <ul class="pdfed-annots">
                {curPage.annots.map((a) => (
                  <li key={a.id}>
                    <span>
                      <strong>{t(ANNOT_WORDS[a.kind] ?? "pdfKindOther")}</strong>
                      {a.text && <span class="dim"> {a.text.slice(0, 60)}</span>}
                    </span>
                    {!readOnly && (a.ref || a.data) && (
                      <button
                        type="button"
                        class="vw-icon"
                        title={t("pdfRemoveAnnot")}
                        aria-label={t("pdfRemoveAnnot")}
                        onClick={() =>
                          pageOp({ t: "remove_annotation", page: current - 1, id: a.id, info: a })
                        }
                      >
                        <IconTrash size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h4>{t("pdfVersions")}</h4>
            {versions === undefined ? (
              <button
                type="button"
                class="link"
                onClick={() =>
                  void attempt(async () =>
                    setVersions((await getApi().pdfVersions(file.scope, file.path)).versions),
                  )
                }
              >
                {t("pdfShowVersions")}
              </button>
            ) : versions.length === 0 ? (
              <p class="dim">{t("pdfNoVersions")}</p>
            ) : (
              <ul class="pdfed-versions">
                {versions.map((x) => (
                  <li key={x.name}>
                    <button
                      type="button"
                      class="link"
                      onClick={() =>
                        void attempt(async () => {
                          const b = await getApi().pdfVersion(file.scope, file.path, x.name);
                          const url = URL.createObjectURL(
                            new Blob([b as BlobPart], { type: "application/pdf" }),
                          );
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = x.name;
                          link.click();
                          setTimeout(() => URL.revokeObjectURL(url), 30_000);
                        })
                      }
                    >
                      <IconDownload size={13} /> {new Date(x.at).toLocaleString()}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
      <input
        ref={pickRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (f) void attempt(async () => setPicture(await pickPicture(f)));
        }}
      />
      {ask?.kind === "note" && (
        <NoteAsk
          onCancel={() => setAsk(undefined)}
          onSave={(text) => {
            const m = ask.mark;
            setAsk(undefined);
            send(
              [
                {
                  t: "annotate",
                  a: {
                    id: newId(),
                    page: m.page,
                    kind: "note",
                    rect: m.rect,
                    text,
                    color: [1, 0.85, 0.2],
                  },
                },
              ],
              true,
            );
          }}
        />
      )}
      {ask?.kind === "sign" && (
        <SignAsk
          onCancel={() => {
            setAsk(undefined);
            if (!signature) setTool("select");
          }}
          onPicture={async (f) => {
            const p = await pickPicture(f);
            setSignature(p);
            setAsk(undefined);
          }}
          onDrawn={(paths, w, h) => {
            setSignature({ paths, w, h });
            setAsk(undefined);
          }}
        />
      )}
      {confirmRedact && (
        <Modal
          title={t("pdfRedactConfirmTitle")}
          onClose={() => setConfirmRedact(false)}
          foot={
            <>
              <button type="button" class="vw-btn" onClick={() => setConfirmRedact(false)}>
                {t("pdfCancel")}
              </button>
              <button type="button" class="vw-btn danger" onClick={() => void redactNow()}>
                <IconRedact size={14} />
                {t("pdfRedactDo")}
              </button>
            </>
          }
        >
          <p>{t("pdfRedactConfirm")}</p>
        </Modal>
      )}
    </div>
  );
}

/** A page drawn small (the side panel). */
function Thumb({ doc, n }: { doc: PDFDocumentProxy; n: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stop = false;
    let task: { cancel(): void; promise: Promise<unknown> } | undefined;
    const el = ref.current;
    if (!el) return;
    const io =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((e) => {
            if (!e.some((x) => x.isIntersecting)) return;
            io?.disconnect();
            draw();
          });
    const draw = () =>
      void doc.getPage(n).then((p) => {
        if (stop) return;
        const vp0 = p.getViewport({ scale: 1 });
        const vp = p.getViewport({ scale: 96 / vp0.width });
        el.width = Math.floor(vp.width * 2);
        el.height = Math.floor(vp.height * 2);
        el.style.width = `${Math.floor(vp.width)}px`;
        el.style.height = `${Math.floor(vp.height)}px`;
        task = p.render({ canvas: el, viewport: vp, transform: [2, 0, 0, 2, 0, 0] } as never);
        task.promise.catch(() => {});
      });
    if (io) io.observe(el);
    else draw();
    return () => {
      stop = true;
      io?.disconnect();
      task?.cancel();
    };
  }, [doc, n]);
  return <canvas ref={ref} />;
}

function NoteAsk({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <Modal
      title={t("pdfNoteTitle")}
      onClose={onCancel}
      foot={
        <>
          <button type="button" class="vw-btn" onClick={onCancel}>
            {t("pdfCancel")}
          </button>
          <button
            type="button"
            class="vw-btn primary"
            disabled={!text.trim()}
            onClick={() => onSave(text.trim())}
          >
            {t("pdfSave")}
          </button>
        </>
      }
    >
      <textarea
        class="pdfed-note-text"
        rows={4}
        value={text}
        placeholder={t("pdfNotePlaceholder")}
        aria-label={t("pdfNoteTitle")}
        ref={(el) => el?.focus()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
    </Modal>
  );
}

/** A signature drawn with the mouse or a finger, or a picture of one. */
function SignAsk({
  onDrawn,
  onPicture,
  onCancel,
}: {
  onDrawn: (paths: number[][], w: number, h: number) => void;
  onPicture: (f: File) => Promise<void>;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<"draw" | "picture">("draw");
  const canvas = useRef<HTMLCanvasElement>(null);
  const paths = useRef<number[][]>([]);
  const [drawn, setDrawn] = useState(0);
  const W = 420;
  const H = 160;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    let cur: number[] | undefined;
    const pos = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as [
        number,
        number,
      ];
    };
    const ink = getComputedStyle(el).color || "#123";
    const down = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      cur = [...pos(e)];
      paths.current.push(cur);
    };
    const move = (e: PointerEvent) => {
      if (!cur || !g) return;
      const [x, y] = pos(e);
      const lx = cur[cur.length - 2] as number;
      const ly = cur[cur.length - 1] as number;
      cur.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
      g.strokeStyle = ink;
      g.lineWidth = 2.2;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(x, y);
      g.stroke();
    };
    const up = () => {
      cur = undefined;
      setDrawn(paths.current.length);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
  }, [tab]);
  const clear = () => {
    paths.current = [];
    setDrawn(0);
    canvas.current?.getContext("2d")?.clearRect(0, 0, W, H);
  };
  const use = () => {
    // The strokes cropped to what was drawn.
    const all = paths.current.flat();
    const xs = all.filter((_, i) => i % 2 === 0);
    const ys = all.filter((_, i) => i % 2 === 1);
    const x0 = Math.min(...xs) - 4;
    const y0 = Math.min(...ys) - 4;
    const w = Math.max(...xs) + 4 - x0;
    const h = Math.max(...ys) + 4 - y0;
    onDrawn(
      paths.current.map((p) =>
        p.map((n, i) => Math.round((n - (i % 2 === 0 ? x0 : y0)) * 10) / 10),
      ),
      w,
      h,
    );
  };
  return (
    <Modal
      title={t("pdfSignTitle")}
      onClose={onCancel}
      foot={
        <>
          {tab === "draw" && (
            <button type="button" class="vw-btn" disabled={!drawn} onClick={clear}>
              {t("pdfSignClear")}
            </button>
          )}
          <button type="button" class="vw-btn" onClick={onCancel}>
            {t("pdfCancel")}
          </button>
          {tab === "draw" && (
            <button type="button" class="vw-btn primary" disabled={!drawn} onClick={use}>
              {t("pdfSignUse")}
            </button>
          )}
        </>
      }
    >
      <div class="vw-seg pdfed-sign-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "draw"}
          class={tab === "draw" ? "on" : ""}
          onClick={() => setTab("draw")}
        >
          {t("pdfSignDraw")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "picture"}
          class={tab === "picture" ? "on" : ""}
          onClick={() => setTab("picture")}
        >
          {t("pdfSignPicture")}
        </button>
      </div>
      {tab === "draw" ? (
        <canvas
          ref={canvas}
          class="pdfed-sign-pad"
          width={W}
          height={H}
          aria-label={t("pdfSignDraw")}
        />
      ) : (
        <label class="vw-btn pdfed-sign-pick">
          <IconImage size={14} />
          {t("pdfPickPicture")}
          <input
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void attempt(() => onPicture(f));
            }}
          />
        </label>
      )}
      <p class="dim pdfed-sign-note">{t("pdfSignNote")}</p>
    </Modal>
  );
}

/** The page a key goes to (p3.5.11): Page Down / Up one page, Home / End the ends; else undefined. */
export function pageKey(key: string, page: number, total: number): number | undefined {
  if (key === "PageDown") return Math.min(total, page + 1);
  if (key === "PageUp") return Math.max(1, page - 1);
  if (key === "Home") return 1;
  if (key === "End") return total;
  return undefined;
}

/**
 * A name for each field of a form's layer that has none (p3.5.11): its title, else the field's
 * own name in words («data_nascita» says «data nascita»).
 */
export function nameFields(layer: HTMLElement): void {
  for (const el of layer.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("input, select, textarea")) {
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title) continue;
    if (el.labels && el.labels.length > 0) continue;
    const words = (el.name || "").replace(/[._-]+/g, " ").trim();
    el.setAttribute("aria-label", words || t("pdfField"));
  }
}

const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
