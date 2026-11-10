// The layered picture editor in the canvas (G37.5), inside the editor's shell (DocEditor.tsx):
// its engine in its own island (viewers/image-island.ts, loaded only now) under our own bar and
// panels: tools (move, brush, eraser, rectangle/ellipse/lasso selection, text, colour picker),
// brush options, layers (visibility, lock, opacity, blending, order, merge, rename), masks,
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
  IconEllipse,
  IconEraser,
  IconExternal,
  IconEye,
  IconFlip,
  IconLasso,
  IconLayers,
  IconLock,
  IconMask,
  IconMaximize,
  IconMergeDown,
  IconMove,
  IconOrder,
  IconPipette,
  IconPlus,
  IconRedo,
  IconSelectAll,
  IconSliders,
  IconSpinner,
  IconSquare,
  IconTrash,
  IconType,
  IconUndo,
  IconX,
  IconZoom,
} from "../../icons.js";
import { attempt, getApi, openCanvas, openDoc, sendDoc } from "../../state.js";
import type { ImageIsland, ImageTool, IslandLayer, Rect } from "../../viewers/image-island.js";
import { ImageCollab, imageActionsOf, imageDocOp } from "../../viewers/image-ops.js";
import { afterSeen, elementShown, HIGHLIGHT_SEEN_MS } from "../../viewers/seen.js";
import { download } from "../../viewers/source.js";
import { askText } from "../dialogs.js";
import { SmallSwitch } from "../ui.js";
import { CopyBar } from "./CopyBar.js";

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

const GESTURE_MS = 1500;
const FONTS = ["sans-serif", "serif", "monospace", "cursive"];

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
  const [brush, setBrushNow] = useState({ size: 12, opacity: 1, hardness: 1, color: "#e0482e" });
  const [onMask, setOnMask] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<Rect>();
  const [busy, setBusy] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0, format: "ora" as ImageSnapshot["format"] });
  const [marks, setMarks] = useState<
    { x: number; y: number; w: number; h: number; name: string; id: number }[]
  >([]);
  const [info, setInfo] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["imageInfo"]>>>();
  const [exporting, setExporting] = useState<string>();
  const [filter, setFilter] = useState<{ id: string; params: Record<string, number> }>();
  const [tf, setTf] = useState({ scale: 100, angle: 0 });
  const [text, setText] = useState({ size: 48, bold: false, italic: false, font: "sans-serif" });
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
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    let last = 0;
    /** Remote revisions drawn one after the other (their blobs are fetched). */
    let queue: Promise<unknown> = Promise.resolve();
    const fading = new Set<() => void>();
    const done: number[] = [];
    const undone: number[] = [];
    const asked = new Map<number, "undo" | "redo">();
    const collab = new ImageCollab((o) =>
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: [imageDocOp(o.action)],
        groupId: group,
      }),
    );
    const resync = () => sendDoc({ type: "doc.open", file });
    const show = (s: ImageSnapshot, revision: number) => {
      collab.reset(revision);
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
            const now = Date.now();
            if (now - last > GESTURE_MS) group = `g-${Math.random().toString(36).slice(2, 10)}`;
            last = now;
            collab.local(acts, what, filterId);
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
          onPick: (hex) => setBrushNow((b) => ({ ...b, color: hex })),
          onText: (x, y) =>
            void askText(t("imgTextAsk"), "", { label: t("imgTextAsk") }).then((s) => {
              if (s?.trim()) island?.addText(s, x, y, { ...text, color: island.brush.color });
            }),
          onZoom: setZoom,
          onBusy: setBusy,
          onError: (msg) =>
            setNote(msg === "locked" ? t("imgLocked") : t("imgFailed", { reason: msg })),
        });
        isl.current = island;
        island.brush = { ...brush };
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
        for (const r of m.change.undoOf ?? []) {
          const k = asked.get(r);
          asked.delete(r);
          if (k === "undo") undone.push(m.change.revision);
          else if (k === "redo") done.push(m.change.revision);
        }
        const theirs = m.change.author !== PERSON && !m.change.replaced;
        queue = queue.then(async () => {
          if ((await island?.remote(actions)) === "reload") return resync();
          if (!theirs) return;
          const who = m.change.authorName ?? m.change.author;
          requestAnimationFrame(() => {
            const boxes = island?.boxesOf(actions) ?? [];
            const stamp = Date.now();
            setMarks(boxes.map((b, i) => ({ ...b, name: who, id: stamp + i })));
            const cancel = afterSeen(
              HIGHLIGHT_SEEN_MS,
              () => {
                fading.delete(cancel);
                setMarks((x) => x.filter((b) => b.id < stamp));
              },
              elementShown(() => el),
            );
            fading.add(cancel);
          });
        });
      },
      ack(m) {
        if (!collab.ack(m.clientId, m.revision)) return;
        done.push(m.revision);
        undone.length = 0;
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) resync();
      },
    });
    api.current = {
      undo() {
        void island?.settled().then(() => {
          collab.flush();
          const r = done.pop();
          if (r === undefined) return;
          asked.set(r, "undo");
          sendDoc({ type: "doc.undo", file, clientId: askId(), revision: r });
        });
      },
      redo() {
        const r = undone.pop();
        if (r === undefined) return;
        asked.set(r, "redo");
        sendDoc({ type: "doc.undo", file, clientId: askId(), revision: r });
      },
      flush() {
        collab.flush();
      },
    };
    return () => {
      closed = true;
      for (const cancel of fading) cancel();
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
    if (isl.current) isl.current.tool = to;
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
    if (mod && k === "z")
      return act(() => (e.shiftKey ? api.current?.redo() : api.current?.undo()));
    if (mod && k === "y") return act(() => api.current?.redo());
    if (mod && k === "a") return act(() => x.selectAll());
    if (mod && k === "d") return act(() => x.selectNone());
    if (mod || e.altKey) return;
    if (k === "delete" || k === "backspace") return act(() => x.fillSelection("", true));
    if (k === "escape") return act(() => x.selectNone());
    if (k === "[") return act(() => setBrush({ size: Math.max(1, Math.round(brush.size / 1.25)) }));
    if (k === "]")
      return act(() => setBrush({ size: Math.min(500, Math.round(brush.size * 1.25) + 1) }));
    const tools: Record<string, ImageTool> = {
      m: "move",
      v: "move",
      b: "brush",
      e: "eraser",
      r: "rect",
      o: "ellipse",
      l: "lasso",
      t: "text",
      i: "picker",
    };
    const to = tools[k];
    if (to) act(() => setTool(to));
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

  const Tool = ({
    id,
    label,
    children,
  }: {
    id: ImageTool;
    label: string;
    children: ComponentChildren;
  }) => (
    <button
      type="button"
      class={`vw-icon svg-tool ${tool === id ? "on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={tool === id}
      onClick={() => setTool(id)}
    >
      {children}
    </button>
  );
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
  const painting = tool === "brush" || tool === "eraser";

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
        {(painting || tool === "text") && (
          <label class="img-color">
            <span>{t("imgColor")}</span>
            <input
              type="color"
              value={brush.color}
              onInput={(e) => setBrush({ color: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
        {painting && (
          <>
            <label>
              <span>{t("imgSize")}</span>
              <input
                type="range"
                min={1}
                max={300}
                value={brush.size}
                onInput={(e) => setBrush({ size: Number((e.target as HTMLInputElement).value) })}
              />
              <span class="dim img-val">{brush.size}</span>
            </label>
            <label>
              <span>{t("imgOpacity")}</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={brush.opacity}
                onInput={(e) => setBrush({ opacity: Number((e.target as HTMLInputElement).value) })}
              />
              <span class="dim img-val">{Math.round(brush.opacity * 100)}%</span>
            </label>
            <label>
              <span>{t("imgHardness")}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={brush.hardness}
                onInput={(e) =>
                  setBrush({ hardness: Number((e.target as HTMLInputElement).value) })
                }
              />
            </label>
            {cur?.hasMask && (
              <SmallSwitch
                label={t("imgOnMask")}
                on={onMask}
                onChange={(on) => {
                  if (isl.current) isl.current.onMask = on;
                  setOnMask(on);
                }}
              />
            )}
          </>
        )}
        {tool === "text" && (
          <>
            <Num
              label={t("imgTextSize")}
              value={text.size}
              min={4}
              max={1000}
              onChange={(n) => setText({ ...text, size: n })}
            />
            <label>
              <span>{t("imgTextFont")}</span>
              <select
                value={text.font}
                onChange={(e) => setText({ ...text, font: (e.target as HTMLSelectElement).value })}
              >
                {FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <SmallSwitch
              label={t("imgBold")}
              on={text.bold}
              onChange={(on) => setText({ ...text, bold: on })}
            />
            <SmallSwitch
              label={t("imgItalic")}
              on={text.italic}
              onChange={(on) => setText({ ...text, italic: on })}
            />
            <span class="dim">{t("imgTextHint")}</span>
          </>
        )}
        {(tool === "rect" || tool === "ellipse" || tool === "lasso") && (
          <span class="dim">{t("imgSelectHint")}</span>
        )}
        {tool === "move" && <span class="dim">{t("imgMoveHint")}</span>}
        {tool === "picker" && (
          <span class="dim">
            {t("imgPickHint")} <span class="img-swatch" style={{ background: brush.color }} />{" "}
            {brush.color}
          </span>
        )}
      </div>
      <div class="svg-body">
        <div
          class="svg-tools"
          role="toolbar"
          aria-orientation="vertical"
          aria-label={t("imgTools")}
        >
          <Tool id="move" label={t("imgToolMove")}>
            <IconMove size={16} />
          </Tool>
          <Tool id="brush" label={t("imgToolBrush")}>
            <IconBrush size={16} />
          </Tool>
          <Tool id="eraser" label={t("imgToolEraser")}>
            <IconEraser size={16} />
          </Tool>
          <Tool id="rect" label={t("imgToolRect")}>
            <IconSquare size={16} />
          </Tool>
          <Tool id="ellipse" label={t("imgToolEllipse")}>
            <IconEllipse size={16} />
          </Tool>
          <Tool id="lasso" label={t("imgToolLasso")}>
            <IconLasso size={16} />
          </Tool>
          <Tool id="text" label={t("imgToolText")}>
            <IconType size={16} />
          </Tool>
          <Tool id="picker" label={t("imgToolPicker")}>
            <IconPipette size={16} />
          </Tool>
        </div>
        <div class="svg-stage img-stage">
          <div
            class={`img-area tool-${tool}`}
            ref={area}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the picture takes the keyboard
            tabIndex={0}
            role="application"
            aria-label={`${t("imgEditorLabel")}: ${name}`}
            onKeyDown={onKey}
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
