// The layered picture editor in the canvas (G37.5), inside the editor's shell (DocEditor.tsx):
// its engine in its own island (viewers/image-island.ts, loaded only now) under our own bar and
// panels: Photoshop's tools on the left (p3.5.7, ImageToolbar.tsx: groups, flyouts, the same
// letters and the colours), their options on top (ImageOptions.tsx), layers (visibility, lock, opacity, blending, order, merge, rename), masks,
// the selection's actions (fill, clear, crop), the filter catalog with a preview, transforms,
// the picture's size, undo (the host's: the person's own revisions), zoom, «Esporta come…» and
// «Apri in Krita». The person's edits go to the host as tiles; the agents' arrive the same way,
// outlined a while.
import { signal } from "@preact/signals";
import {
  type DocFile,
  IMAGE_BLENDS,
  IMAGE_FILTERS,
  type ImagePlainAction,
  type ImageSnapshot,
  imageBlendName,
  PERSON,
} from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t, tOptional } from "../../i18n.js";
import {
  IconBrush,
  IconCopy,
  IconCrop,
  IconDownload,
  IconEraser,
  IconExternal,
  IconEye,
  IconFlip,
  IconLayers,
  IconLock,
  IconMask,
  IconMaximize,
  IconMergeDown,
  IconMove,
  IconOrder,
  IconPlus,
  IconRedo,
  IconSelectAll,
  IconSliders,
  IconSpinner,
  IconTransform,
  IconTrash,
  IconUndo,
  IconX,
  IconZoom,
} from "../../icons.js";
import { attempt, getApi, openCanvas, openDoc, sendDoc } from "../../state.js";
import { holdMark } from "../../viewers/agent-marks.js";
import type {
  Brush,
  ImageIsland,
  IslandLayer,
  IslandNote,
  Rect,
} from "../../viewers/image-island.js";
import { ImageCollab, imageActionsOf, imageDocOp } from "../../viewers/image-ops.js";
import {
  BRUSHED,
  brushStep,
  DEFAULT_OPTIONS,
  defaultShown,
  groupOf,
  type ImageTool,
  SELECTING,
  type ToolOptions,
  toolForKey,
} from "../../viewers/image-tools.js";
import { OwnUndo } from "../../viewers/own-undo.js";
import { download } from "../../viewers/source.js";
import { askText } from "../dialogs.js";
import { CopyBar } from "./CopyBar.js";
import { ImageOptions, type TextOptions } from "./ImageOptions.js";
import { ImageToolbar } from "./ImageToolbar.js";

/** Pictures the editor opens as they are: OpenRaster always. */
export const IMAGE_LAYERED = /\.ora$/i;
/** PNG and JPEG open in the editor when the person asks («Modifica»). */
export const IMAGE_FLAT = /\.(png|jpe?g)$/i;
/** Closed layered formats edited on their OpenRaster copy. */
export const IMAGE_COPIES = /\.(psd|psb)$/i;

/** The PNG and JPEG pictures the person opened in the editor (by scope and path). */
export const editingPictures = signal<ReadonlySet<string>>(new Set());
const pictureKey = (f: { scope: string; path: string }) => `${f.scope}\u0000${f.path}`;
export const pictureEditable = (f: { scope: string; path: string }) =>
  IMAGE_LAYERED.test(f.path) ||
  (IMAGE_FLAT.test(f.path) && editingPictures.value.has(pictureKey(f)));
export function setEditingPicture(f: { scope: string; path: string }, on: boolean): void {
  const next = new Set(editingPictures.value);
  if (on) next.add(pictureKey(f));
  else next.delete(pictureKey(f));
  editingPictures.value = next;
}

/** «Modifica» on a PNG or JPEG shown in the canvas: the editor instead of the viewer. */
export function EditPictureButton({ scope, path }: { scope: string; path: string }) {
  return (
    <button
      type="button"
      class="vw-btn small"
      title={t("imgEditHint")}
      onClick={() => setEditingPicture({ scope, path }, true)}
    >
      <IconBrush size={14} />
      {t("imgEdit")}
    </button>
  );
}

/** The island's notes in the person's words. */
const NOTES: Record<IslandNote, Parameters<typeof t>[0]> = {
  locked: "imgLocked",
  cloneSource: "imgCloneSource",
  cloneSet: "imgCloneSet",
  nothingSelected: "imgNothingSelected",
  noLayer: "imgNoLayer",
};

let asks = 0;
const askId = () => `i${Date.now().toString(36)}${(asks++).toString(36)}`;

/** A layer's blending in the person's words. */
export const blendLabel = (op: string) =>
  tOptional(`imgBlend_${imageBlendName(op)}`) ?? imageBlendName(op);

export function ImageEditor({ file }: { file: DocFile }) {
  const area = useRef<HTMLDivElement>(null);
  const isl = useRef<ImageIsland | undefined>(undefined);
  const api = useRef<{ undo(): void; redo(): void; flush(): void } | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const [layers, setLayers] = useState<IslandLayer[]>([]);
  const [current, setCurrent] = useState<string>();
  const [tool, setToolNow] = useState<ImageTool>("brush");
  /** The tool each group of the left bar shows (its last used). */
  const [shown, setShown] = useState(defaultShown);
  const [brush, setBrushNow] = useState<Brush>({
    size: 12,
    opacity: 1,
    hardness: 1,
    flow: 1,
    color: "#e0482e",
  });
  const [background, setBackground] = useState("#ffffff");
  const [opts, setOptsNow] = useState<ToolOptions>({ ...DEFAULT_OPTIONS });
  const [crop, setCrop] = useState<Rect>();
  const [transforming, setTransforming] = useState(false);
  const [onMask, setOnMask] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<Rect>();
  const [busy, setBusy] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0, format: "ora" as ImageSnapshot["format"] });
  const [marks, setMarks] = useState<
    { x: number; y: number; w: number; h: number; name: string; id: number; rev: number }[]
  >([]);
  const [info, setInfo] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["imageInfo"]>>>();
  const [exporting, setExporting] = useState<string>();
  const [filter, setFilter] = useState<{ id: string; params: Record<string, number> }>();
  const [tf, setTf] = useState({ scale: 100, angle: 0 });
  const [text, setText] = useState<TextOptions>({
    size: 48,
    bold: false,
    italic: false,
    font: "sans-serif",
  });
  /** The text options as they are now, for the island's callbacks made once. */
  const textNow = useRef(text);
  textNow.current = text;
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  useEffect(() => setCanvasSize({ w: size.w, h: size.h }), [size.w, size.h]);

  const refresh = () => {
    const i = isl.current;
    if (!i) return;
    setLayers(i.layerList());
    setCurrent(i.current);
    setOnMask(i.onMask);
    setSize({ w: i.width, h: i.height, format: i.format });
  };

  useEffect(() => {
    void getApi()
      .imageInfo(file.scope, file.path)
      .then(setInfo, () => {});
  }, [file.scope, file.path, size.format, layers.length > 1]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let closed = false;
    let island: ImageIsland | undefined;
    let latest: { s: ImageSnapshot; revision: number } | undefined;
    /** Remote revisions drawn one after the other (their blobs are fetched). */
    let queue: Promise<unknown> = Promise.resolve();
    /** The highlights waiting to be seen, by revision: dropped when the editor closes. */
    const fading = new Map<number, () => void>();
    /** The person's revisions, to undo the last gesture; the undos, to redo (p3.5.6). */
    const own = new OwnUndo();
    let undoing: Promise<void> = Promise.resolve();
    const sentIn = new Map<string, string>();
    const collab = new ImageCollab((o) => {
      const group = o.group ?? `g-${Math.random().toString(36).slice(2, 10)}`;
      sentIn.set(o.clientId, group);
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: [imageDocOp(o.action)],
        groupId: group,
      });
    });
    const resync = () => sendDoc({ type: "doc.open", file });
    const show = (s: ImageSnapshot, revision: number) => {
      collab.reset(revision);
      own.forget();
      if (!island) {
        latest = { s, revision };
        return;
      }
      const first = loading;
      queue = queue.then(() =>
        island?.load(s).then(
          () => {
            if (first) setZoom(island?.setZoom("fit") ?? 1);
            setLoading(false);
            setCanvasSize({ w: s.width, h: s.height });
          },
          (e: unknown) => setFailed(t("imgFailed", { reason: (e as Error).message })),
        ),
      );
    };
    const blobs = new Map<string, Promise<Blob>>();
    void import("../../viewers/image-island.js").then(
      (m) => {
        if (closed) return;
        island = m.mountImage({
          area: el,
          blob(hash) {
            let p = blobs.get(hash);
            if (!p) {
              p = getApi()
                .imageBlobBytes(hash)
                .then((b) => new Blob([b as BlobPart], { type: "image/png" }));
              p.catch(() => blobs.delete(hash));
              blobs.set(hash, p);
              while (blobs.size > 400) blobs.delete(blobs.keys().next().value as string);
            }
            return p;
          },
          upload: (png) => getApi().imageBlob(file.scope, file.path, png),
          onActions(acts: ImagePlainAction[], what?: string, filterId?: string) {
            // Each gesture is one revision and one Ctrl+Z (p3.5.7: gestures within 1.5 s shared
            // a group before, and one Ctrl+Z took them back together).
            const group = `g-${Math.random().toString(36).slice(2, 10)}`;
            collab.local(acts, what, filterId, group);
            collab.flush();
          },
          onLayers: refresh,
          onSelection: setSel,
          onEditing: (editing) =>
            sendDoc({
              type: "doc.presence",
              file,
              editing,
              from: 0,
              to: 0,
              revision: collab.revision,
            }),
          onPick: (hex, which) => {
            if (which === "bg") {
              setBackground(hex);
              if (island) island.background = hex;
            } else setBrushNow((b) => ({ ...b, color: hex }));
          },
          onText: (x, y) =>
            void askText(t("imgTextAsk"), "", { label: t("imgTextAsk") }).then((s) => {
              if (s?.trim())
                island?.addText(s, x, y, { ...textNow.current, color: island.brush.color });
            }),
          onNote: (n: IslandNote) => setNote(t(NOTES[n])),
          onCrop: setCrop,
          onTransform: setTransforming,
          label: (k) =>
            k === "copy"
              ? t("imgLayerVia")
              : t(
                  k === "shape-rect"
                    ? "imgShapeName_rect"
                    : k === "shape-ellipse"
                      ? "imgShapeName_ellipse"
                      : "imgShapeName_line",
                ),
          onZoom: setZoom,
          onBusy: setBusy,
          onError: (msg) =>
            setNote(msg === "locked" ? t("imgLocked") : t("imgFailed", { reason: msg })),
        });
        isl.current = island;
        island.brush = { ...brush };
        island.background = background;
        island.opts = { ...opts };
        island.tool = tool;
        if (latest) {
          show(latest.s, latest.revision);
          latest = undefined;
        }
      },
      (e: unknown) => setFailed(t("imgFailed", { reason: (e as Error).message })),
    );
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family === "image") show(snapshot, revision);
      },
      replaced(m) {
        if (m.snapshot.family === "image") show(m.snapshot, m.revision);
      },
      changed(m) {
        if (!island) return resync();
        const actions = imageActionsOf(m.ops);
        if (collab.remote(m.revision, actions) === "reload") return resync();
        own.changed(m.change);
        // An undone change loses its highlight (and its «Annulla questa modifica»).
        for (const r of m.change.undoOf ?? []) {
          fading.get(r)?.();
          fading.delete(r);
          setMarks((x) => x.filter((b) => b.rev !== r));
        }
        const theirs = m.change.author !== PERSON && !m.change.replaced;
        const rev = m.change.revision;
        queue = queue.then(async () => {
          if ((await island?.remote(actions)) === "reload") return resync();
          if (!theirs) return;
          const who = m.change.authorName ?? m.change.author;
          requestAnimationFrame(() => {
            const boxes = island?.boxesOf(actions) ?? [];
            const stamp = Date.now();
            // Added to the others (p3.5.6: each change replaced the highlights before it).
            setMarks((x) => [
              ...x,
              ...boxes.map((b, i) => ({ ...b, name: who, id: stamp + i, rev })),
            ]);
            fading.set(
              rev,
              holdMark(
                file,
                rev,
                () => el,
                () => {
                  fading.delete(rev);
                  setMarks((x) => x.filter((b) => b.rev !== rev));
                },
              ),
            );
          });
        });
      },
      ack(m) {
        if (!collab.ack(m.clientId, m.revision)) return;
        own.made(m.revision, sentIn.get(m.clientId) ?? `r${m.revision}`);
        sentIn.delete(m.clientId);
        // Ctrl+Z pressed before this was confirmed (p3.5.7): asked now, for the right gesture.
        for (const ask of own.release(collab.pending))
          sendDoc({ type: "doc.undo", file, clientId: askId(), ...ask });
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) {
          own.forget();
          resync();
        }
      },
    });
    api.current = {
      // Ctrl+Z waits for the gestures made to be confirmed by the host (p3.5.7, the person's
      // test of 3.5.6: right after a Move its revision was not known yet, so Ctrl+Z did nothing,
      // or undid the gesture before and the host refused it for the place the Move changed).
      // The pixels being made ready first (`settled`), then OwnUndo.press keeps the key until
      // the ack (`release`). Presses stay in order.
      undo() {
        undoing = undoing.then(async () => {
          await island?.settled();
          collab.flush();
          const ask = own.press("undo", collab.pending);
          if (ask) sendDoc({ type: "doc.undo", file, clientId: askId(), ...ask });
        });
      },
      redo() {
        undoing = undoing.then(async () => {
          await island?.settled();
          collab.flush();
          const ask = own.press("redo", collab.pending);
          if (ask) sendDoc({ type: "doc.undo", file, clientId: askId(), ...ask });
        });
      },
      flush() {
        collab.flush();
      },
    };
    return () => {
      closed = true;
      for (const cancel of fading.values()) cancel();
      collab.flush();
      close();
      island?.dispose();
      isl.current = undefined;
    };
  }, [file.scope, file.path]);

  const i = isl.current;
  const cur = layers.find((l) => l.id === current);
  const run = (fn: (x: ImageIsland) => void) => () => {
    const x = isl.current;
    if (x) fn(x);
    area.current?.focus();
  };
  const setTool = (to: ImageTool) => {
    setToolNow(to);
    setShown((m) => ({ ...m, [groupOf(to).id]: to }));
    const x = isl.current;
    if (x) {
      x.tool = to;
      // A tool change ends the polygon under way (as Photoshop's), not a crop or a transform.
      if (!SELECTING.has(to)) x.cancelPolygon();
    }
  };
  const setOpts = (o: Partial<ToolOptions>) => {
    const next = { ...opts, ...o };
    setOptsNow(next);
    if (isl.current) isl.current.opts = next;
  };
  const setColors = (fg: string, bg: string) => {
    setBrush({ color: fg });
    setBackground(bg);
    if (isl.current) isl.current.background = bg;
  };
  const setBrush = (b: Partial<typeof brush>) => {
    const next = { ...brush, ...b };
    setBrushNow(next);
    if (isl.current) isl.current.brush = next;
  };
  useEffect(() => {
    if (isl.current) isl.current.brush = { ...brush };
  }, [brush]);

  const onKey = (e: KeyboardEvent) => {
    const x = isl.current;
    if (!x || (e.target as HTMLElement).closest("input, select, textarea")) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "Alt") x.altHeld = true;
    // Space held: the hand for a while (Photoshop's).
    if (e.key === " ") return act(() => (x.spaceHand = true));
    if (mod && k === "z")
      return act(() => (e.shiftKey ? api.current?.redo() : api.current?.undo()));
    if (mod && k === "y") return act(() => api.current?.redo());
    if (mod && k === "a") return act(() => x.selectAll());
    if (mod && e.shiftKey && k === "d") return act(() => x.reselect());
    if (mod && k === "d") return act(() => x.selectNone());
    if (mod && e.shiftKey && k === "i") return act(() => x.invertSelection());
    if (mod && k === "t") return act(() => x.freeTransform());
    if (mod && k === "j") return act(() => x.layerViaCopy(t("imgLayerVia")));
    if (mod && (k === "+" || k === "=")) return act(() => x.zoomAt(1));
    if (mod && k === "-") return act(() => x.zoomAt(-1));
    if (mod && k === "0") return act(() => setZoom(x.setZoom("fit")));
    if (mod) return;
    if (k === "enter") return x.commit() ? act(() => {}) : undefined;
    if (k === "escape") return x.cancel() ? act(() => {}) : undefined;
    if (k === "backspace" && x.polyBack()) return act(() => {});
    if (k === "delete" || k === "backspace") return act(() => x.fillSelection("", true));
    const arrows: Record<string, [number, number]> = {
      arrowleft: [-1, 0],
      arrowright: [1, 0],
      arrowup: [0, -1],
      arrowdown: [0, 1],
    };
    const arrow = arrows[k];
    if (arrow) {
      const n = e.shiftKey ? 10 : 1;
      return act(() => x.nudge(arrow[0] * n, arrow[1] * n));
    }
    if (e.altKey) return;
    if (k === "[" || k === "]") {
      const dir = k === "]" ? 1 : -1;
      return act(() =>
        tool === "quick-select"
          ? setOpts({ quickSize: brushStep(opts.quickSize, dir) })
          : setBrush({ size: brushStep(brush.size, dir) }),
      );
    }
    if (k === "x") return act(() => setColors(background, brush.color));
    if (k === "d") return act(() => setColors("#000000", "#ffffff"));
    const to = toolForKey(k, e.shiftKey, tool, shown);
    if (to) act(() => setTool(to));
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const x = isl.current;
    if (!x) return;
    if (e.key === " ") x.spaceHand = false;
    if (e.key === "Alt") x.altHeld = false;
  };

  const exportAs = (to: "png" | "jpeg" | "webp" | "ora" | "psd") =>
    void attempt(async () => {
      setExporting(to);
      setNote(undefined);
      try {
        api.current?.flush();
        const stem = name.replace(/\.[^.]+$/, "");
        let blob: Blob;
        if (to === "ora" || to === "psd")
          blob = await getApi().imageExport(file.scope, file.path, to);
        else {
          const x = isl.current;
          if (!x) return;
          const c = x.composite();
          if (to === "jpeg") {
            // A JPEG has no transparency: over white.
            const w = document.createElement("canvas");
            w.width = c.width;
            w.height = c.height;
            const g = w.getContext("2d") as CanvasRenderingContext2D;
            g.fillStyle = "#ffffff";
            g.fillRect(0, 0, w.width, w.height);
            g.drawImage(c, 0, 0);
            blob = await new Promise<Blob>((ok, ko) =>
              w.toBlob((b) => (b ? ok(b) : ko(new Error("JPEG"))), "image/jpeg", 0.92),
            );
          } else
            blob = await new Promise<Blob>((ok, ko) =>
              c.toBlob(
                (b) => (b && b.type === `image/${to}` ? ok(b) : ko(new Error(to.toUpperCase()))),
                `image/${to}`,
                0.92,
              ),
            );
        }
        const url = URL.createObjectURL(blob);
        download(url, `${stem}.${to === "jpeg" ? "jpg" : to}`);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (e) {
        setNote(t("imgExportFailed", { reason: (e as Error).message }));
      } finally {
        setExporting(undefined);
      }
    });

  const Btn = ({
    label,
    on,
    disabled,
    children,
    wide,
  }: {
    label: string;
    on: () => void;
    disabled?: boolean | undefined;
    children: ComponentChildren;
    wide?: boolean;
  }) => (
    <button
      type="button"
      class={wide ? "vw-btn small" : "vw-icon"}
      title={label}
      aria-label={wide ? undefined : label}
      disabled={disabled}
      onClick={on}
    >
      {children}
      {wide && <span>{label}</span>}
    </button>
  );
  const Num = ({
    label,
    value,
    min,
    max,
    step = 1,
    onChange,
  }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (n: number) => void;
  }) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </label>
  );

  const flatCopy = size.format !== "ora" && layers.length > 1;
  const filterDef = filter && IMAGE_FILTERS.find((f) => f.id === filter.id);

  return (
    <div class="svg-editor img-editor">
      <div class="svg-bar" role="toolbar" aria-label={t("imgEditorLabel")}>
        <div class="svg-group">
          <Btn label={t("imgUndo")} on={() => api.current?.undo()}>
            <IconUndo size={16} />
          </Btn>
          <Btn label={t("imgRedo")} on={() => api.current?.redo()}>
            <IconRedo size={16} />
          </Btn>
        </div>
        <div class="svg-group">
          <Btn label={t("svgZoomOut")} on={run((x) => setZoom(x.setZoom(x.zoom / 1.25)))}>
            <IconZoom size={16} out />
          </Btn>
          <span class="svg-zoom dim" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Btn label={t("svgZoomIn")} on={run((x) => setZoom(x.setZoom(x.zoom * 1.25)))}>
            <IconZoom size={16} />
          </Btn>
          <Btn label={t("svgZoomFit")} on={run((x) => setZoom(x.setZoom("fit")))}>
            <IconMaximize size={16} />
          </Btn>
        </div>
        <span class="dim img-size">
          {t("imgSizeNow", { w: String(size.w), h: String(size.h) })}
        </span>
        {busy > 0 && (
          <span class="dim img-busy" role="status">
            <IconSpinner size={13} /> {t("imgSaving")}
          </span>
        )}
        <div class="spacer" />
        <label class="sheet-export svg-export img-export">
          {exporting ? <IconSpinner size={14} /> : <IconDownload size={14} />}
          <select
            aria-label={t("imgExport")}
            value=""
            disabled={!!exporting}
            onChange={(e) => {
              const to = (e.target as HTMLSelectElement).value as
                | "png"
                | "jpeg"
                | "webp"
                | "ora"
                | "psd"
                | "";
              (e.target as HTMLSelectElement).value = "";
              if (to) exportAs(to);
            }}
          >
            <option value="">{t("imgExport")}</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="ora">{t("imgExportOra")}</option>
            <option value="psd">{t("imgExportPsd")}</option>
          </select>
        </label>
        {info?.krita && (
          <button
            type="button"
            class="vw-btn small"
            title={t("imgKritaHint")}
            onClick={() =>
              void attempt(async () => {
                api.current?.flush();
                await getApi().openInKrita(file.scope, file.path);
                setNote(t("imgKritaOpened"));
              })
            }
          >
            <IconExternal size={14} />
            {t("imgKrita")}
          </button>
        )}
        {IMAGE_FLAT.test(file.path) && (
          <Btn label={t("imgCloseEditor")} on={() => setEditingPicture(file, false)}>
            <IconX size={16} />
          </Btn>
        )}
      </div>
      {info?.original && <CopyBar original={info.original} />}
      {(note || failed || flatCopy) && (
        <div class="sheet-notes">
          {flatCopy && (
            <p class="sheet-note" role="status">
              {t("imgFlatNote", { format: size.format === "png" ? "PNG" : "JPEG" })}
              {info?.layers && (
                <button
                  type="button"
                  class="link"
                  onClick={() =>
                    openCanvas(info.layers?.split(/[\\/]/).pop() ?? "", {
                      kind: "file",
                      scope: file.scope,
                      path: info.layers as string,
                    })
                  }
                >
                  {t("imgLayersCopy")}
                </button>
              )}
            </p>
          )}
          {note && (
            <p class="sheet-note" role="status">
              {note}
              <button
                type="button"
                class="vw-icon"
                aria-label={t("close")}
                title={t("close")}
                onClick={() => setNote(undefined)}
              >
                <IconX size={12} />
              </button>
            </p>
          )}
          {failed && (
            <p class="sheet-note warn" role="alert">
              {failed}
            </p>
          )}
        </div>
      )}
      <div class="img-options" role="toolbar" aria-label={t("imgOptions")}>
        <ImageOptions
          tool={tool}
          opts={opts}
          setOpts={setOpts}
          brush={brush}
          setBrush={setBrush}
          text={text}
          setText={setText}
          sel={sel}
          hasMask={!!cur?.hasMask}
          onMask={onMask}
          setOnMask={(on) => {
            if (isl.current) isl.current.onMask = on;
            setOnMask(on);
          }}
          crop={crop}
          transforming={transforming}
          act={(what) => {
            const x = isl.current;
            if (!x) return;
            if (what === "apply") x.commit();
            else if (what === "cancel") x.cancel();
            else if (what === "cropFromSel") x.cropBox(sel);
            else x.freeTransform();
            area.current?.focus();
          }}
        />
      </div>
      <div class="svg-body">
        <ImageToolbar
          tool={tool}
          shown={shown}
          onTool={(to) => {
            setTool(to);
            area.current?.focus();
          }}
          fg={brush.color}
          bg={background}
          onColor={(which, hex) =>
            which === "fg" ? setBrush({ color: hex }) : setColors(brush.color, hex)
          }
          onSwap={() => setColors(background, brush.color)}
          onDefault={() => setColors("#000000", "#ffffff")}
        />
        <div class="svg-stage img-stage">
          <div
            class={`img-area tool-${tool}${BRUSHED.has(tool) ? " brushed" : ""}`}
            ref={area}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the picture takes the keyboard
            tabIndex={0}
            role="application"
            aria-label={`${t("imgEditorLabel")}: ${name}`}
            onKeyDown={onKey}
            onKeyUp={onKeyUp}
          />
          {marks.length > 0 && (
            <div class="svg-marks" aria-hidden="true">
              {marks.map((m) => (
                <div
                  key={m.id}
                  class="svg-mark"
                  style={{
                    left: `${m.x - 3 - (area.current?.scrollLeft ?? 0)}px`,
                    top: `${m.y - 3 - (area.current?.scrollTop ?? 0)}px`,
                    width: `${m.w + 6}px`,
                    height: `${m.h + 6}px`,
                  }}
                >
                  <span>{m.name}</span>
                </div>
              ))}
            </div>
          )}
          {loading && !failed && (
            <div class="vw-empty dim svg-loading">
              <IconSpinner size={16} /> {t("imgLoading")}
            </div>
          )}
        </div>
        <aside class="svg-side img-side" aria-label={t("imgLayers")}>
          <section>
            <h4>
              <IconLayers size={14} /> {t("imgLayers")}
            </h4>
            <ul class="img-layers">
              {layers.map((l) => (
                <li key={l.id} class={l.id === current ? "current" : ""}>
                  <button
                    type="button"
                    class={`vw-icon ${l.visible ? "" : "off"}`}
                    title={
                      l.visible
                        ? t("imgLayerHide", { name: l.name })
                        : t("imgLayerShow", { name: l.name })
                    }
                    aria-label={
                      l.visible
                        ? t("imgLayerHide", { name: l.name })
                        : t("imgLayerShow", { name: l.name })
                    }
                    aria-pressed={l.visible}
                    onClick={run((x) => x.setProps(l.id, { visible: !l.visible }))}
                  >
                    <IconEye size={14} />
                  </button>
                  <button
                    type="button"
                    class="img-layer"
                    aria-current={l.id === current}
                    title={
                      l.groups?.length
                        ? t("imgInGroup", { name: l.groups.map((g) => g.name).join(" / ") })
                        : l.name
                    }
                    onClick={run((x) => x.setCurrent(l.id))}
                    onDblClick={() =>
                      void askText(t("imgLayerRename"), l.name, { label: t("imgLayerName") }).then(
                        (n) => {
                          if (n?.trim() && n.trim() !== l.name)
                            isl.current?.setProps(l.id, { name: n.trim() });
                        },
                      )
                    }
                  >
                    <img src={l.thumb} alt="" class="img-thumb" />
                    <span
                      class="img-layer-name"
                      style={{ paddingLeft: `${(l.groups?.length ?? 0) * 10}px` }}
                    >
                      {l.name || t("vwOraUnnamed")}
                    </span>
                    {l.hasMask && (
                      <span class="dim" title={t("imgMask")}>
                        <IconMask size={12} />
                      </span>
                    )}
                    {l.blend !== "svg:src-over" && (
                      <span class="dim img-blend-tag">{blendLabel(l.blend)}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    class={`vw-icon ${l.locked ? "on" : "off"}`}
                    title={l.locked ? t("imgLayerUnlock") : t("imgLayerLock")}
                    aria-label={l.locked ? t("imgLayerUnlock") : t("imgLayerLock")}
                    aria-pressed={!!l.locked}
                    onClick={run((x) => x.setProps(l.id, { locked: !l.locked }))}
                  >
                    <IconLock size={12} />
                  </button>
                </li>
              ))}
            </ul>
            <div class="img-row">
              <Btn
                label={t("imgLayerNew")}
                on={run((x) => x.addLayer(t("imgLayerNewName", { n: String(layers.length + 1) })))}
              >
                <IconPlus size={14} />
              </Btn>
              <Btn
                label={t("imgLayerDuplicate")}
                on={run((x) => x.duplicateLayer(t("imgLayerCopyName", { name: cur?.name ?? "" })))}
                disabled={!cur}
              >
                <IconCopy size={14} />
              </Btn>
              <Btn
                label={t("imgLayerUp")}
                on={run((x) => x.stepLayer(1))}
                disabled={!cur || layers[0]?.id === cur.id}
              >
                <IconOrder size={14} to="up" />
              </Btn>
              <Btn
                label={t("imgLayerDown")}
                on={run((x) => x.stepLayer(-1))}
                disabled={!cur || layers.at(-1)?.id === cur.id}
              >
                <IconOrder size={14} to="down" />
              </Btn>
              <Btn
                label={t("imgLayerMerge")}
                on={run((x) => x.mergeDown())}
                disabled={!cur || layers.at(-1)?.id === cur.id}
              >
                <IconMergeDown size={14} />
              </Btn>
              <Btn
                label={t("imgLayerDelete")}
                on={run((x) => x.deleteLayer())}
                disabled={!cur || layers.length < 2}
              >
                <IconTrash size={14} />
              </Btn>
            </div>
            {cur && (
              <div class="svg-fields">
                <label>
                  <span>{t("imgOpacity")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={cur.opacity}
                    onChange={(e) =>
                      i?.setProps(cur.id, { opacity: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                  <span class="dim img-val">{Math.round(cur.opacity * 100)}%</span>
                </label>
                <label class="wide">
                  <span>{t("imgBlend")}</span>
                  <select
                    value={cur.blend}
                    onChange={(e) =>
                      i?.setProps(cur.id, { blend: (e.target as HTMLSelectElement).value })
                    }
                  >
                    {!(IMAGE_BLENDS as readonly string[]).includes(cur.blend) && (
                      <option value={cur.blend}>{cur.blend}</option>
                    )}
                    {IMAGE_BLENDS.map((b) => (
                      <option key={b} value={b}>
                        {blendLabel(b)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </section>
          <section>
            <h4>
              <IconMask size={14} /> {t("imgMask")}
            </h4>
            <div class="img-row">
              {!cur?.hasMask ? (
                <Btn
                  wide
                  label={sel ? t("imgMaskFromSel") : t("imgMaskAdd")}
                  on={run((x) => x.addMask())}
                  disabled={!cur}
                >
                  <IconPlus size={13} />
                </Btn>
              ) : (
                <>
                  <Btn wide label={t("imgMaskApply")} on={run((x) => x.applyMask())}>
                    <IconMergeDown size={13} />
                  </Btn>
                  <Btn wide label={t("imgMaskDelete")} on={run((x) => x.deleteMask())}>
                    <IconTrash size={13} />
                  </Btn>
                </>
              )}
            </div>
            {cur?.hasMask && <p class="dim img-help">{t("imgMaskHelp")}</p>}
          </section>
          <section>
            <h4>
              <IconSelectAll size={14} /> {t("imgSelection")}
            </h4>
            <p class="dim img-help">
              {sel
                ? t("imgSelBox", {
                    w: String(Math.round(sel.w)),
                    h: String(Math.round(sel.h)),
                    x: String(Math.round(sel.x)),
                    y: String(Math.round(sel.y)),
                  })
                : t("imgSelNoneYet")}
            </p>
            <div class="img-row wrap">
              <Btn wide label={t("imgSelAll")} on={run((x) => x.selectAll())}>
                <IconSelectAll size={13} />
              </Btn>
              <Btn wide label={t("imgSelNone")} on={run((x) => x.selectNone())} disabled={!sel}>
                <IconX size={13} />
              </Btn>
              <Btn wide label={t("imgSelInvert")} on={run((x) => x.invertSelection())}>
                <IconFlip size={13} />
              </Btn>
              <Btn wide label={t("imgSelReselect")} on={run((x) => x.reselect())} disabled={!!sel}>
                <IconUndo size={13} />
              </Btn>
              <Btn
                wide
                label={t("imgLayerViaCopy")}
                on={run((x) => x.layerViaCopy(t("imgLayerVia")))}
                disabled={!cur}
              >
                <IconCopy size={13} />
              </Btn>
              <Btn wide label={t("imgXform")} on={run((x) => x.freeTransform())} disabled={!cur}>
                <IconTransform size={13} />
              </Btn>
              <Btn
                wide
                label={t("imgSelFill")}
                on={run((x) => x.fillSelection(brush.color))}
                disabled={!cur}
              >
                <span class="img-swatch" style={{ background: brush.color }} />
              </Btn>
              <Btn
                wide
                label={t("imgSelClear")}
                on={run((x) => x.fillSelection("", true))}
                disabled={!cur}
              >
                <IconEraser size={13} />
              </Btn>
              <Btn
                wide
                label={t("imgSelCrop")}
                on={run((x) => x.cropToSelection())}
                disabled={!sel}
              >
                <IconCrop size={13} />
              </Btn>
            </div>
          </section>
          <section>
            <h4>
              <IconSliders size={14} /> {t("imgFilters")}
            </h4>
            <label class="wide img-filter-pick">
              <select
                aria-label={t("imgFilterPick")}
                value={filter?.id ?? ""}
                disabled={!cur}
                onChange={(e) => {
                  const id = (e.target as HTMLSelectElement).value;
                  const def = IMAGE_FILTERS.find((f) => f.id === id);
                  if (!def) {
                    isl.current?.cancelFilter();
                    return setFilter(undefined);
                  }
                  const params = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
                  setFilter({ id, params });
                  isl.current?.previewFilter(id, params);
                }}
              >
                <option value="">{t("imgFilterPick")}</option>
                {IMAGE_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {tOptional(`imgFilter_${f.id}`) ?? f.id}
                  </option>
                ))}
              </select>
            </label>
            {filter && filterDef && (
              <div class="svg-fields">
                {filterDef.params.map((p) => (
                  <label key={p.id}>
                    <span>{tOptional(`imgParam_${p.id}`) ?? p.id}</span>
                    <input
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step ?? 1}
                      value={filter.params[p.id] ?? p.default}
                      onInput={(e) => {
                        const params = {
                          ...filter.params,
                          [p.id]: Number((e.target as HTMLInputElement).value),
                        };
                        setFilter({ ...filter, params });
                        isl.current?.previewFilter(filter.id, params);
                      }}
                    />
                    <span class="dim img-val">{filter.params[p.id] ?? p.default}</span>
                  </label>
                ))}
                <div class="img-row">
                  <button
                    type="button"
                    class="vw-btn small primary"
                    onClick={() => {
                      isl.current?.applyFilter(filter.id, filter.params);
                      setFilter(undefined);
                    }}
                  >
                    {t("imgFilterApply")}
                  </button>
                  <button
                    type="button"
                    class="vw-btn small"
                    onClick={() => {
                      isl.current?.cancelFilter();
                      setFilter(undefined);
                    }}
                  >
                    {t("imgFilterCancel")}
                  </button>
                </div>
              </div>
            )}
          </section>
          <section>
            <h4>
              <IconMove size={14} /> {t("imgTransform")}
            </h4>
            <div class="svg-fields">
              <Num
                label={t("imgScale")}
                value={tf.scale}
                min={1}
                max={2000}
                onChange={(n) => setTf({ ...tf, scale: n })}
              />
              <Num
                label={t("imgRotate")}
                value={tf.angle}
                min={-360}
                max={360}
                onChange={(n) => setTf({ ...tf, angle: n })}
              />
            </div>
            <div class="img-row">
              <Btn
                label={t("imgFlipH")}
                on={run((x) => x.transform(100, 0, true, false))}
                disabled={!cur}
              >
                <IconFlip size={14} />
              </Btn>
              <Btn
                label={t("imgFlipV")}
                on={run((x) => x.transform(100, 0, false, true))}
                disabled={!cur}
              >
                <IconFlip size={14} axis="y" />
              </Btn>
              <button
                type="button"
                class="vw-btn small"
                disabled={!cur || (tf.scale === 100 && tf.angle === 0)}
                onClick={run((x) => {
                  x.transform(tf.scale, tf.angle, false, false);
                  setTf({ scale: 100, angle: 0 });
                })}
              >
                {t("imgTransformApply")}
              </button>
            </div>
          </section>
          <section>
            <h4>
              <IconCrop size={14} /> {t("imgImage")}
            </h4>
            <div class="svg-fields">
              <Num
                label={t("imgWidth")}
                value={canvasSize.w || size.w}
                min={1}
                max={16384}
                onChange={(n) => setCanvasSize({ w: n, h: canvasSize.h || size.h })}
              />
              <Num
                label={t("imgHeight")}
                value={canvasSize.h || size.h}
                min={1}
                max={16384}
                onChange={(n) => setCanvasSize({ w: canvasSize.w || size.w, h: n })}
              />
            </div>
            <div class="img-row wrap">
              <button
                type="button"
                class="vw-btn small"
                disabled={canvasSize.w === size.w && canvasSize.h === size.h}
                onClick={run((x) =>
                  x.setCanvas(
                    canvasSize.w,
                    canvasSize.h,
                    (canvasSize.w - size.w) / 2,
                    (canvasSize.h - size.h) / 2,
                  ),
                )}
              >
                {t("imgCanvasSize")}
              </button>
              <button
                type="button"
                class="vw-btn small"
                disabled={canvasSize.w === size.w && canvasSize.h === size.h}
                onClick={run((x) => x.scaleImage(canvasSize.w, canvasSize.h))}
              >
                {t("imgScaleImage")}
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
