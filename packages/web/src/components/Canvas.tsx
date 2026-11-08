// The canvas (G25.1, G34): whatever an agent showed, next to the chat. A site runs in a sandboxed
// frame on a signed link (it cannot reach the person's access to RedGiant); any other file opens
// in the viewer made for its kind (components/viewers: video and audio players, pictures, PDF,
// documents, sheets, slides, 3D, archives, fonts, trees, code), everything drawn in the page. It
// reloads by itself when the file changes. Office files are laid out by LibreOffice and closed
// formats are seen through their open copy (viewers/OpenCopy.tsx, G34.4).

import type { CanvasDo } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconDownload,
  IconExternal,
  IconFullscreen,
  IconFullscreenExit,
  IconRefresh,
} from "../icons.js";
import { type CanvasTarget, canvasViewId, getApi } from "../state.js";
import { CanvasTab, lastMove, report, setTabKind } from "../viewers/live.js";
import { hasOfficeCopy, isOfficeFile } from "../viewers/office-bridge.js";
import { bytesText, download, type ViewerSource } from "../viewers/source.js";
import { DocEditor, editableInCanvas } from "./viewers/DocEditor.js";
import { EditCopyButton } from "./viewers/OfficeEditor.js";
import { CanvasFile } from "./viewers/OpenCopy.js";

export { parseDelimited } from "../viewers/delimited.js";

export type CanvasKind =
  | "site"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "sheet"
  | "xlsx"
  | "model"
  | "markdown"
  | "json"
  | "text";

/**
 * A rough kind from the name alone (the chat's cards: pictures, videos and sounds in place). A
 * folder is a site. The canvas itself chooses with `viewerFor`, which reads the file too.
 */
export function canvasKind(target: CanvasTarget): CanvasKind {
  if (target.kind === "port") return "site";
  const ext = target.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext || ext === "html" || ext === "htm") return "site";
  if (/^(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(ext)) return "image";
  if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return "video";
  if (/^(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/.test(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "sheet";
  if (ext === "xlsx") return "xlsx";
  if (/^(glb|gltf|stl|obj|fbx|ply)$/.test(ext)) return "model";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  return "text";
}

/** An agent's move in words, for the tab's head (G36.12): «The agent went to page 3». */
export function moveText(d: CanvasDo): string {
  const parts: string[] = [];
  if (d.page) parts.push(t("canvasMovePage", { n: String(d.page) }));
  if (d.line)
    parts.push(
      d.toLine && d.toLine > d.line
        ? t("canvasMoveLines", { from: String(d.line), to: String(d.toLine) })
        : t("canvasMoveLine", { n: String(d.line) }),
    );
  if (d.time !== undefined) parts.push(t("canvasMoveTime", { at: clockOf(d.time) }));
  if (d.play === true) parts.push(t("canvasMovePlay"));
  if (d.play === false) parts.push(t("canvasMovePause"));
  if (d.zoom === "fit") parts.push(t("canvasMoveFit"));
  else if (d.zoom) parts.push(t("canvasMoveZoom", { n: String(Math.round(d.zoom)) }));
  if (d.find) parts.push(t("canvasMoveFind", { words: d.find }));
  if (d.sheet) parts.push(t("canvasMoveSheet", { name: d.sheet }));
  if (d.cells) parts.push(t("canvasMoveCells", { cells: d.cells.toUpperCase() }));
  return parts.length ? t("canvasAgentMoved", { what: parts.join(", ") }) : t("canvasAgentOpened");
}

const clockOf = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

/** The file's own name, from its path in the workspace (or on the computer). */
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function Canvas({ title, target }: { title: string; target: CanvasTarget }) {
  const site = canvasKind(target) === "site";
  // A file the editor knows opens editable (G37.1): the host keeps it, no reloading here.
  const editable = target.kind === "file" && editableInCanvas(target);
  const id = canvasViewId(target);
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [shown, setShown] = useState<ViewerSource>();
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  // The file on the whole screen (p3.3.2): Esc, or the same button, ends it.
  useEffect(() => {
    const change = () => setFull(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const toggleFull = () => {
    if (full) void document.exitFullscreen?.().catch(() => {});
    else void box.current?.requestFullscreen?.().catch(() => {});
  };
  // What the person selects in the tab is part of where they are (G36.12), read when an agent asks.
  useEffect(() => {
    const change = () => {
      const sel = document.getSelection();
      const el = box.current;
      if (!sel || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      report(id, { selection: sel.toString().trim().slice(0, 2000) || undefined });
    };
    document.addEventListener("selectionchange", change);
    return () => document.removeEventListener("selectionchange", change);
  }, [id]);
  useEffect(
    () =>
      setTabKind(
        id,
        site
          ? "site"
          : editable && target.kind === "file" && isOfficeFile(target.path)
            ? /\.odp$/i.test(target.path)
              ? "slides"
              : "document"
            : editable
              ? "text"
              : shown?.kind,
      ),
    [id, site, editable, shown?.kind],
  );
  // The agent's move, said for a few seconds in the head.
  const move = lastMove.value?.id === id ? lastMove.value : undefined;
  const [moveShown, setMoveShown] = useState<number>();
  useEffect(() => {
    if (!move) return;
    setMoveShown(move.n);
    const timer = setTimeout(() => setMoveShown(undefined), 6000);
    return () => clearTimeout(timer);
  }, [move?.n]);
  const key = JSON.stringify(target);
  useEffect(() => {
    setError(undefined);
    void getApi()
      .canvasLink(target)
      .then(
        (r) => setLink(r.url),
        (e: unknown) => setError((e as Error).message),
      );
  }, [key]);
  // Files: when they change, what is shown follows (a viewer: the file alone; a site: its folder).
  useEffect(() => {
    if (target.kind !== "file" || editable) return;
    let stopped = false;
    const look = () =>
      void getApi()
        .canvasVersion(target.scope, target.path, !site)
        .then(
          (r) => !stopped && setVersion((v) => (v === r.version ? v : r.version)),
          () => {},
        );
    look();
    const timer = setInterval(look, site ? 2000 : 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);
  const url = link && `${link}${link.includes("?") ? "&" : "?"}v=${version}-${reloads}`;
  const name = target.kind === "file" ? fileName(target.path) : title;
  return (
    <div class="canvas" ref={box}>
      <div class="canvas-head">
        <span class="canvas-title">
          <strong title={target.kind === "file" ? target.path : title}>{title}</strong>
          {shown && !site && (
            <span class="dim canvas-meta">
              {t(`vwKind_${shown.kind}`)}
              {shown.size !== undefined && ` · ${bytesText(shown.size)}`}
            </span>
          )}
        </span>
        <div class="spacer" />
        {target.kind === "file" && target.scope !== "outside" && hasOfficeCopy(target.path) && (
          <EditCopyButton scope={target.scope} path={target.path} />
        )}
        {move && moveShown === move.n && (
          <span class="canvas-agent" role="status" title={moveText(move.do)}>
            {moveText(move.do)}
          </span>
        )}
        <button
          type="button"
          class="icon-button"
          title={t("canvasReload")}
          aria-label={t("canvasReload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
        {url && !site && (
          <button
            type="button"
            class="icon-button"
            title={t("vwDownload")}
            aria-label={t("vwDownload")}
            onClick={() => download(url, name)}
          >
            <IconDownload size={14} />
          </button>
        )}
        {document.fullscreenEnabled && (
          <button
            type="button"
            class="icon-button"
            title={full ? t("canvasFullscreenExit") : t("canvasFullscreen")}
            aria-label={full ? t("canvasFullscreenExit") : t("canvasFullscreen")}
            aria-pressed={full}
            onClick={toggleFull}
          >
            {full ? <IconFullscreenExit size={14} /> : <IconFullscreen size={14} />}
          </button>
        )}
        {url && (
          <a
            class="button tiny canvas-open-tab"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={t("canvasOpenTab")}
          >
            <IconExternal size={13} />
            <span>{t("canvasOpenTab")}</span>
          </a>
        )}
      </div>
      <div class={`canvas-body ${site ? "canvas-site" : "canvas-viewer"}`}>
        {error ? (
          <p class="notice error">{error}</p>
        ) : !url ? (
          <div class="empty">{t("loading")}</div>
        ) : editable && target.kind === "file" ? (
          <CanvasTab.Provider value={id}>
            <DocEditor file={{ scope: target.scope, path: target.path }} />
          </CanvasTab.Provider>
        ) : site ? (
          <iframe
            key={url}
            title={title}
            src={url}
            // An opaque origin: the site cannot read RedGiant's storage or its access.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
            allow="fullscreen; autoplay; clipboard-write"
          />
        ) : (
          <CanvasTab.Provider value={id}>
            <CanvasFile
              key={url}
              scope={target.kind === "file" ? target.scope : "outside"}
              path={target.kind === "file" ? target.path : name}
              name={name}
              url={url}
              onKind={setShown}
              {...(target.kind === "file" && target.at && { at: target.at })}
            />
          </CanvasTab.Provider>
        )}
      </div>
    </div>
  );
}
