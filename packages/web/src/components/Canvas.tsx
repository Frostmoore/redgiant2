// The canvas (G25.1, G34): whatever an agent showed, next to the chat. A site runs in a sandboxed
// frame on a signed link (it cannot reach the person's access to RedGiant); any other file opens
// in the viewer made for its kind (components/viewers: video and audio players, pictures, PDF,
// documents, sheets, slides, 3D, archives, fonts, trees, code), everything drawn in the page. It
// reloads by itself when the file changes. Office files are laid out by LibreOffice and closed
// formats are seen through their open copy (viewers/OpenCopy.tsx, G34.4).
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconDownload,
  IconExternal,
  IconFullscreen,
  IconFullscreenExit,
  IconRefresh,
} from "../icons.js";
import { type CanvasTarget, getApi } from "../state.js";
import { bytesText, download, type ViewerSource } from "../viewers/source.js";
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

/** The file's own name, from its path in the workspace (or on the computer). */
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function Canvas({ title, target }: { title: string; target: CanvasTarget }) {
  const site = canvasKind(target) === "site";
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
    if (target.kind !== "file") return;
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
          <CanvasFile
            key={url}
            scope={target.kind === "file" ? target.scope : "outside"}
            path={target.kind === "file" ? target.path : name}
            name={name}
            url={url}
            onKind={setShown}
            {...(target.kind === "file" && target.at && { at: target.at })}
          />
        )}
      </div>
    </div>
  );
}
