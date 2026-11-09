// The drawing editor in the canvas (G37.6), inside the editor's shell (DocEditor.tsx): svgcanvas
// in its own island (viewers/svg-island.ts, loaded only now) under our own bar and panels: tools
// (select, nodes, rectangle, ellipse, line, polygon, pen, pencil, text), group, order, align and
// distribute, fill, stroke, opacity, rotation, text, layers, zoom, undo (the host's: the person's
// own revisions), «Esporta come…» and «Apri in Inkscape». The person's commands go to the host as
// actions on the file (viewers/svg-ops.ts); the agents' arrive the same way, outlined a while.

import { signal } from "@preact/signals";
import type { DocChange, DocFile } from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import {
  IconAlign,
  IconChevronDown,
  IconCopy,
  IconDistribute,
  IconDownload,
  IconEllipse,
  IconExternal,
  IconEye,
  IconGroup,
  IconLayers,
  IconLine,
  IconLock,
  IconMaximize,
  IconNodes,
  IconOrder,
  IconPencil,
  IconPenTool,
  IconPlus,
  IconPointer,
  IconPolygon,
  IconRedo,
  IconSpinner,
  IconSquare,
  IconTrash,
  IconType,
  IconUndo,
  IconUngroup,
  IconX,
  IconZoom,
} from "../../icons.js";
import { attempt, getApi, openDoc, sendDoc } from "../../state.js";
import { download } from "../../viewers/source.js";
import type { SvgIsland, SvgLayer, SvgSelection, SvgTool } from "../../viewers/svg-island.js";
import { SvgCollab, svgActionsOf, svgDocOp, touchedIds } from "../../viewers/svg-ops.js";
import { SmallSwitch } from "../ui.js";
import { CopyBar } from "./CopyBar.js";

/** The drawings the page edits (G37.6); an AI or EPS is edited on its SVG copy. */
export const SVG_EDITABLE = /\.svg$/i;
/** Closed vector formats edited on their SVG copy. */
export const SVG_COPIES = /\.(ai|eps|epsf|epsi|ps)$/i;

const GESTURE_MS = 2000;
const MARK_MS = 8000;

/** Which drawing has the engine now (svgcanvas is one per page). */
const engineOwner = signal<string | undefined>(undefined);
let owners = 0;

const toHex = (css: string | undefined): string | undefined => {
  if (!css || css === "none" || css.startsWith("url(")) return undefined;
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return undefined;
  c.fillStyle = "#000000";
  c.fillStyle = css;
  const v = String(c.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
};

let asks = 0;
const askId = () => `s${Date.now().toString(36)}${(asks++).toString(36)}`;

export function SvgEditor({
  file,
  onReveal,
}: {
  file: DocFile;
  onReveal?: (reveal: ((c: DocChange) => void) | undefined) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isl = useRef<SvgIsland | undefined>(undefined);
  const api = useRef<{ undo(): void; redo(): void; save(): void } | undefined>(undefined);
  const [me] = useState(() => `svg-${owners++}`);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [sel, setSel] = useState<SvgSelection>({ count: 0 });
  const [layers, setLayers] = useState<SvgLayer[]>([]);
  const [tool, setTool] = useState<SvgTool>("select");
  const [zoom, setZoom] = useState(1);
  const [sides, setSides] = useState(5);
  const [marks, setMarks] = useState<
    { x: number; y: number; w: number; h: number; name: string; id: number }[]
  >([]);
  const [info, setInfo] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["svgInfo"]>>>();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [round, setRound] = useState(0);
  /** The bar's menu open now (order, align). */
  const [open, setOpen] = useState<string>();
  const mine = engineOwner.value === me;
  const name = file.path.split(/[\\/]/).pop() ?? file.path;

  useEffect(() => {
    void getApi()
      .svgInfo(file.scope, file.path)
      .then(setInfo, () => {});
  }, [file.scope, file.path]);

  // A menu closes when the person clicks elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".svg-menu")) setOpen(undefined);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    engineOwner.value = me;
    return () => {
      if (engineOwner.value === me) engineOwner.value = undefined;
    };
  }, [round]);

  useEffect(() => {
    const el = area.current;
    const ti = input.current;
    if (!el || !ti || !mine) return;
    let closed = false;
    let island: SvgIsland | undefined;
    let latest: { text: string; revision: number } | undefined;
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The person's revisions, to undo the last; the undos, to redo. */
    const done: number[] = [];
    const undone: number[] = [];
    const asked = new Map<number, "undo" | "redo">();
    const collab = new SvgCollab((o) =>
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: o.actions.map(svgDocOp),
        groupId: group,
      }),
    );
    const resync = () => sendDoc({ type: "doc.open", file });
    const show = (text: string, revision: number) => {
      collab.reset(revision);
      if (!island) {
        latest = { text, revision };
        return;
      }
      if (!island.load(text)) setFailed(t("svgFailed", { reason: "SVG" }));
      else setZoom(island.getZoom());
      setLoading(false);
    };
    void import("../../viewers/svg-island.js").then(
      (m) => {
        if (closed) return;
        island = m.mountSvg({
          area: el,
          textInput: ti,
          onActions(actions) {
            collab.local(actions);
            const now = Date.now();
            if (now - last > GESTURE_MS) group = `g-${Math.random().toString(36).slice(2, 10)}`;
            last = now;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => collab.flush(), 120);
          },
          onSelect: setSel,
          onLayers: () => island && setLayers(island.layers()),
          onEditing: (editing) =>
            sendDoc({
              type: "doc.presence",
              file,
              editing,
              from: 0,
              to: 0,
              revision: collab.revision,
            }),
          onTool: setTool,
        });
        isl.current = island;
        if (latest) {
          show(latest.text, latest.revision);
          latest = undefined;
        }
      },
      (e: unknown) => setFailed(t("svgFailed", { reason: (e as Error).message })),
    );
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family === "svg") show(snapshot.text, revision);
      },
      replaced(m) {
        if (m.snapshot.family === "svg") show(m.snapshot.text, m.revision);
      },
      changed(m) {
        if (!island) return resync();
        const actions = svgActionsOf(m.ops);
        if (collab.remote(m.revision, actions) === "reload") return resync();
        if (island.remote(actions, m.change.author !== PERSON) === "reload") return resync();
        for (const r of m.change.undoOf ?? []) {
          const k = asked.get(r);
          asked.delete(r);
          if (k === "undo") undone.push(m.change.revision);
          else if (k === "redo") done.push(m.change.revision);
        }
        if (m.change.author !== PERSON && !m.change.replaced) {
          const ids = [...touchedIds(actions)].filter((x) => x !== "*");
          const who = m.change.authorName ?? m.change.author;
          requestAnimationFrame(() => {
            const boxes = island?.boxesOf(ids) ?? [];
            const stamp = Date.now();
            setMarks(boxes.map((b, i) => ({ ...b, name: who, id: stamp + i })));
            setTimeout(() => setMarks((x) => x.filter((b) => b.id < stamp)), MARK_MS);
          });
        }
      },
      ack(m) {
        if (!collab.ack(m.clientId, m.revision)) return;
        done.push(m.revision);
        undone.length = 0;
        if (island?.takeReload()) resync();
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) resync();
      },
    });
    api.current = {
      undo() {
        collab.flush();
        const r = done.pop();
        if (r === undefined) return;
        asked.set(r, "undo");
        sendDoc({ type: "doc.undo", file, clientId: askId(), revision: r });
      },
      redo() {
        const r = undone.pop();
        if (r === undefined) return;
        asked.set(r, "redo");
        sendDoc({ type: "doc.undo", file, clientId: askId(), revision: r });
      },
      save() {
        collab.flush();
      },
    };
    onReveal?.(() => undefined);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      collab.flush();
      close();
      onReveal?.(undefined);
      island?.dispose();
      isl.current = undefined;
    };
  }, [file.scope, file.path, mine]);

  const i = isl.current;
  const has = sel.count > 0;
  const run = (fn: (x: SvgIsland) => void) => () => {
    const x = isl.current;
    if (x) fn(x);
    area.current?.focus();
  };
  const pick = (to: SvgTool) => run((x) => x.setTool(to));

  const onKey = (e: KeyboardEvent) => {
    const x = isl.current;
    if (!x) return;
    const target = e.target as HTMLElement;
    if (target !== area.current && target.tagName !== "svg" && !area.current?.contains(target))
      return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (mod && k === "z")
      return act(() => (e.shiftKey ? api.current?.redo() : api.current?.undo()));
    if (mod && k === "y") return act(() => api.current?.redo());
    if (mod && k === "g") return act(() => (e.shiftKey ? x.ungroup() : x.group()));
    if (mod && k === "d") return act(() => x.duplicate());
    if (mod && k === "a") return act(() => x.selectAll());
    if (mod || e.altKey) return;
    if (k === "delete" || k === "backspace") return act(() => x.remove());
    if (k === "escape") return act(() => x.setTool("select"));
    const step = e.shiftKey ? 10 : 1;
    if (k === "arrowleft") return act(() => x.nudge(-step, 0));
    if (k === "arrowright") return act(() => x.nudge(step, 0));
    if (k === "arrowup") return act(() => x.nudge(0, -step));
    if (k === "arrowdown") return act(() => x.nudge(0, step));
    const tools: Record<string, SvgTool> = {
      v: "select",
      r: "rect",
      e: "ellipse",
      l: "line",
      p: "path",
      t: "text",
    };
    const to = tools[k];
    if (to) return act(() => x.setTool(to));
  };

  const exportAs = (to: "svg" | "png" | "pdf") =>
    void attempt(async () => {
      setBusy(to);
      setNote(undefined);
      try {
        api.current?.save();
        const stem = name.replace(/\.[^.]+$/, "");
        if (to === "pdf") {
          const blob = await getApi().svgExport(file.scope, file.path, "pdf");
          const url = URL.createObjectURL(blob);
          download(url, `${stem}.pdf`);
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          return;
        }
        // The file as the host has it now (written first).
        const { url: link } = await getApi().canvasLink({
          kind: "file",
          scope: file.scope,
          path: file.path,
        });
        const text = await (await fetch(link)).text();
        const svgBlob = new Blob([text], { type: "image/svg+xml" });
        const svgUrl = URL.createObjectURL(svgBlob);
        if (to === "svg") {
          download(svgUrl, name);
          setTimeout(() => URL.revokeObjectURL(svgUrl), 30_000);
          return;
        }
        const img = new Image();
        await new Promise<void>((ok, ko) => {
          img.onload = () => ok();
          img.onerror = () => ko(new Error("PNG"));
          img.src = svgUrl;
        });
        const scale = Math.min(
          4,
          Math.max(1, 2400 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1)),
        );
        const c = document.createElement("canvas");
        c.width = Math.round((img.naturalWidth || 800) * scale);
        c.height = Math.round((img.naturalHeight || 600) * scale);
        c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(svgUrl);
        const png = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
        if (!png) throw new Error("PNG");
        const url = URL.createObjectURL(png);
        download(url, `${stem}.png`);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (e) {
        setNote(t("svgExportFailed", { reason: (e as Error).message }));
      } finally {
        setBusy(undefined);
      }
    });

  const Tool = ({
    id,
    label,
    children,
  }: {
    id: SvgTool;
    label: string;
    children: preact.ComponentChildren;
  }) => (
    <button
      type="button"
      class={`vw-icon svg-tool ${tool === id ? "on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={tool === id}
      onClick={pick(id)}
    >
      {children}
    </button>
  );
  const Btn = ({
    label,
    on,
    disabled,
    wide,
    children,
  }: {
    label: string;
    on: () => void;
    disabled?: boolean;
    /** In a menu: the words beside the icon. */
    wide?: boolean;
    children: preact.ComponentChildren;
  }) => (
    <button
      type="button"
      class={wide ? "svg-menu-item" : "vw-icon"}
      title={wide ? undefined : label}
      aria-label={wide ? undefined : label}
      disabled={disabled}
      onClick={() => {
        setOpen(undefined);
        on();
      }}
    >
      {children}
      {wide && <span>{label}</span>}
    </button>
  );
  const Menu = ({
    label,
    icon,
    disabled,
    children,
  }: {
    label: string;
    icon: preact.ComponentChildren;
    disabled?: boolean;
    children: preact.ComponentChildren;
  }) => (
    <span class="svg-menu">
      <button
        type="button"
        class="vw-icon"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open === label}
        disabled={disabled}
        onClick={() => setOpen(open === label ? undefined : label)}
      >
        {icon}
        <IconChevronDown size={11} />
      </button>
      {open === label && !disabled && (
        <div class="svg-menu-list" role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </span>
  );

  if (!mine)
    return (
      <div class="svg-editor">
        <div class="vw-empty svg-elsewhere">
          <p>{t("svgElsewhere")}</p>
          <button type="button" class="vw-btn primary" onClick={() => setRound((n) => n + 1)}>
            {t("svgResume")}
          </button>
        </div>
      </div>
    );

  const fillHex = toHex(sel.fill);
  const strokeHex = toHex(sel.stroke);
  return (
    <div class="svg-editor">
      <div class="svg-bar" role="toolbar" aria-label={t("svgEditorLabel")}>
        <div class="svg-group">
          <Btn label={t("svgGroup")} on={run((x) => x.group())} disabled={sel.count < 2}>
            <IconGroup size={16} />
          </Btn>
          <Btn label={t("svgUngroup")} on={run((x) => x.ungroup())} disabled={!sel.isGroup}>
            <IconUngroup size={16} />
          </Btn>
          <Menu label={t("svgOrder")} icon={<IconOrder size={16} to="front" />} disabled={!has}>
            {(["front", "up", "down", "back"] as const).map((to) => (
              <Btn
                key={to}
                label={t(
                  to === "front"
                    ? "svgOrderFront"
                    : to === "up"
                      ? "svgOrderUp"
                      : to === "down"
                        ? "svgOrderDown"
                        : "svgOrderBack",
                )}
                on={run((x) => x.order(to))}
                wide
              >
                <IconOrder size={16} to={to} />
              </Btn>
            ))}
          </Menu>
          <Menu
            label={t("svgAlign")}
            icon={<IconAlign size={16} to="l" />}
            disabled={sel.count < 2}
          >
            {(["l", "c", "r", "t", "m", "b"] as const).map((to) => (
              <Btn
                key={to}
                label={t(`svgAlign${to.toUpperCase() as "L" | "C" | "R" | "T" | "M" | "B"}`)}
                on={run((x) => x.align(to))}
                wide
              >
                <IconAlign size={16} to={to} />
              </Btn>
            ))}
            <Btn
              label={t("svgDistX")}
              on={run((x) => x.distribute("x"))}
              disabled={sel.count < 3}
              wide
            >
              <IconDistribute size={16} axis="x" />
            </Btn>
            <Btn
              label={t("svgDistY")}
              on={run((x) => x.distribute("y"))}
              disabled={sel.count < 3}
              wide
            >
              <IconDistribute size={16} axis="y" />
            </Btn>
          </Menu>
        </div>
        <div class="svg-group">
          <Btn label={t("svgDuplicate")} on={run((x) => x.duplicate())} disabled={!has}>
            <IconCopy size={16} />
          </Btn>
          <Btn label={t("svgDelete")} on={run((x) => x.remove())} disabled={!has}>
            <IconTrash size={16} />
          </Btn>
          <Btn label={t("svgUndo")} on={() => api.current?.undo()}>
            <IconUndo size={16} />
          </Btn>
          <Btn label={t("svgRedo")} on={() => api.current?.redo()}>
            <IconRedo size={16} />
          </Btn>
        </div>
        <div class="svg-group">
          <Btn label={t("svgZoomOut")} on={run((x) => setZoom(x.zoom(x.getZoom() / 1.25)))}>
            <IconZoom size={16} out />
          </Btn>
          <span class="svg-zoom dim" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Btn label={t("svgZoomIn")} on={run((x) => setZoom(x.zoom(x.getZoom() * 1.25)))}>
            <IconZoom size={16} />
          </Btn>
          <Btn label={t("svgZoomFit")} on={run((x) => setZoom(x.zoom("fit")))}>
            <IconMaximize size={16} />
          </Btn>
        </div>
        <div class="spacer" />
        <label class="sheet-export svg-export">
          {busy ? <IconSpinner size={14} /> : <IconDownload size={14} />}
          <select
            aria-label={t("svgExport")}
            value=""
            disabled={!!busy}
            onChange={(e) => {
              const to = (e.target as HTMLSelectElement).value as "svg" | "png" | "pdf" | "";
              (e.target as HTMLSelectElement).value = "";
              if (to) exportAs(to);
            }}
          >
            <option value="">{t("svgExport")}</option>
            <option value="svg">{t("svgExportSvg")}</option>
            <option value="png">{t("svgExportPng")}</option>
            {info && info.pdf !== "missing" && (
              <option value="pdf">
                {info.pdf === "inkscape" ? t("svgExportPdf") : t("svgExportPdfSimple")}
              </option>
            )}
          </select>
        </label>
        {info?.inkscape && (
          <button
            type="button"
            class="vw-btn small"
            title={t("svgInkscapeHint")}
            onClick={() =>
              void attempt(async () => {
                api.current?.save();
                await getApi().openInInkscape(file.scope, file.path);
                setNote(t("svgInkscapeOpened"));
              })
            }
          >
            <IconExternal size={14} />
            {t("svgInkscape")}
          </button>
        )}
      </div>
      {info?.original && <CopyBar original={info.original} />}
      {(note || failed) && (
        <div class="sheet-notes">
          {note && (
            <p class="sheet-note" role="status">
              {note}
            </p>
          )}
          {failed && (
            <p class="sheet-note warn" role="alert">
              {failed}
            </p>
          )}
        </div>
      )}
      <div class="svg-body">
        <div
          class="svg-tools"
          role="toolbar"
          aria-orientation="vertical"
          aria-label={t("svgTools")}
        >
          <Tool id="select" label={t("svgToolSelect")}>
            <IconPointer size={16} />
          </Tool>
          <Tool id="pathedit" label={t("svgToolNodes")}>
            <IconNodes size={16} />
          </Tool>
          <Tool id="rect" label={t("svgToolRect")}>
            <IconSquare size={16} />
          </Tool>
          <Tool id="ellipse" label={t("svgToolEllipse")}>
            <IconEllipse size={16} />
          </Tool>
          <Tool id="line" label={t("svgToolLine")}>
            <IconLine size={16} />
          </Tool>
          <Btn
            label={`${t("svgToolPolygon")} (${t("svgSides")}: ${sides})`}
            on={run((x) => x.addPolygon(sides))}
          >
            <IconPolygon size={16} />
          </Btn>
          <input
            class="svg-sides"
            type="number"
            min={3}
            max={24}
            value={sides}
            aria-label={t("svgSides")}
            title={t("svgSides")}
            onChange={(e) => setSides(Number((e.target as HTMLInputElement).value) || 5)}
          />
          <Tool id="path" label={t("svgToolPen")}>
            <IconPenTool size={16} />
          </Tool>
          <Tool id="fhpath" label={t("svgToolPencil")}>
            <IconPencil size={16} />
          </Tool>
          <Tool id="text" label={t("svgToolText")}>
            <IconType size={16} />
          </Tool>
        </div>
        <div class="svg-stage">
          <div
            class={`svg-area tool-${tool}`}
            ref={area}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the drawing takes the keyboard
            tabIndex={0}
            role="application"
            aria-label={`${t("svgEditorLabel")}: ${name}`}
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
              <IconSpinner size={16} /> {t("svgLoading")}
            </div>
          )}
        </div>
        <aside class="svg-side" aria-label={t("svgProps")}>
          <section>
            <h4>{t("svgProps")}</h4>
            <p class="dim svg-sel">
              {sel.count === 0
                ? t("svgNothing")
                : sel.count === 1
                  ? t("svgSelected1", { what: sel.tag ?? "" })
                  : t("svgSelectedN", { n: String(sel.count) })}
            </p>
            {has && (
              <div class="svg-fields">
                <label>
                  <span>{t("svgFill")}</span>
                  <input
                    type="color"
                    value={fillHex ?? "#000000"}
                    title={sel.fill}
                    onInput={(e) => i?.setFill((e.target as HTMLInputElement).value)}
                  />
                  <button
                    type="button"
                    class={`vw-icon svg-none ${sel.fill === "none" ? "on" : ""}`}
                    title={t("svgNone")}
                    aria-label={t("svgNone")}
                    aria-pressed={sel.fill === "none"}
                    onClick={() => i?.setFill("none")}
                  >
                    <IconX size={13} />
                  </button>
                </label>
                <label>
                  <span>{t("svgStroke")}</span>
                  <input
                    type="color"
                    value={strokeHex ?? "#000000"}
                    title={sel.stroke}
                    onInput={(e) => i?.setStroke((e.target as HTMLInputElement).value)}
                  />
                  <button
                    type="button"
                    class={`vw-icon svg-none ${sel.stroke === "none" ? "on" : ""}`}
                    title={t("svgNone")}
                    aria-label={t("svgNone")}
                    aria-pressed={sel.stroke === "none"}
                    onClick={() => i?.setStroke("none")}
                  >
                    <IconX size={13} />
                  </button>
                </label>
                <label>
                  <span>{t("svgStrokeWidth")}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={sel.strokeWidth ?? 0}
                    onChange={(e) =>
                      i?.setStrokeWidth(Number((e.target as HTMLInputElement).value))
                    }
                  />
                </label>
                <label>
                  <span>{t("svgOpacity")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sel.opacity ?? 1}
                    onInput={(e) => i?.setOpacity(Number((e.target as HTMLInputElement).value))}
                  />
                </label>
                {sel.count === 1 && (
                  <label>
                    <span>{t("svgAngle")}</span>
                    <input
                      type="number"
                      min={-360}
                      max={360}
                      step={1}
                      value={sel.angle ?? 0}
                      onChange={(e) => i?.setAngle(Number((e.target as HTMLInputElement).value))}
                    />
                  </label>
                )}
                {sel.text !== undefined && sel.count === 1 && (
                  <>
                    <label class="wide">
                      <span>{t("svgText")}</span>
                      <input
                        type="text"
                        value={sel.text}
                        onChange={(e) => i?.setText((e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label>
                      <span>{t("svgFontSize")}</span>
                      <input
                        type="number"
                        min={1}
                        step={0.5}
                        value={sel.fontSize ?? 16}
                        onChange={(e) =>
                          i?.setFontSize(Number((e.target as HTMLInputElement).value))
                        }
                      />
                    </label>
                    <label class="wide">
                      <span>{t("svgFont")}</span>
                      <input
                        type="text"
                        value={sel.fontFamily ?? ""}
                        onChange={(e) => i?.setFontFamily((e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <div class="svg-checks">
                      <SmallSwitch
                        label={t("svgBold")}
                        on={!!sel.bold}
                        onChange={(on) => i?.setBold(on)}
                      />
                      <SmallSwitch
                        label={t("svgItalic")}
                        on={!!sel.italic}
                        onChange={(on) => i?.setItalic(on)}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
          <section>
            <h4>
              <IconLayers size={14} /> {t("svgLayers")}
            </h4>
            <ul class="svg-layers">
              {layers.map((l) => (
                <li key={l.name} class={l.current ? "current" : ""}>
                  <button
                    type="button"
                    class={`vw-icon ${l.visible ? "" : "off"}`}
                    title={
                      l.visible
                        ? t("svgLayerHide", { name: l.name })
                        : t("svgLayerShow", { name: l.name })
                    }
                    aria-label={
                      l.visible
                        ? t("svgLayerHide", { name: l.name })
                        : t("svgLayerShow", { name: l.name })
                    }
                    aria-pressed={l.visible}
                    onClick={run((x) => x.toggleLayer(l.name))}
                  >
                    <IconEye size={14} />
                  </button>
                  <button
                    type="button"
                    class="link svg-layer-name"
                    title={l.locked ? t("svgLayerLocked") : t("svgLayerCurrent")}
                    aria-current={l.current}
                    disabled={l.locked}
                    onClick={run((x) => x.setLayer(l.name))}
                  >
                    {l.own ? t("svgLayerDrawing") : l.name}
                  </button>
                  {l.locked && (
                    <span class="dim svg-lock" title={t("svgLayerLocked")}>
                      <IconLock size={12} />
                      <span class="svg-hidden">{t("svgLayerLocked")}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              class="vw-btn small"
              onClick={run((x) =>
                x.newLayer(t("svgLayerNewName", { n: String(layers.length + 1) })),
              )}
            >
              <IconPlus size={13} />
              {t("svgLayerNew")}
            </button>
          </section>
          <p class="dim svg-kept">{t("svgKeptNote")}</p>
        </aside>
      </div>
      <input
        ref={input}
        class="svg-text-input"
        aria-label={t("svgText")}
        autocomplete="off"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            isl.current?.setTool("select");
            area.current?.focus();
          }
        }}
      />
    </div>
  );
}
