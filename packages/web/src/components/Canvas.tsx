// The canvas (G25.1, G34): whatever an agent showed, next to the chat. A site runs in a sandboxed
// frame on a signed link (it cannot reach the person's access to RedGiant); any other file opens
// in the viewer made for its kind (components/viewers: video and audio players, pictures, PDF,
// documents, sheets, slides, 3D, archives, fonts, trees, code), everything drawn in the page. It
// reloads by itself when the file changes. Office files are laid out by LibreOffice and closed
// formats are seen through their open copy (viewers/OpenCopy.tsx, G34.4). It is the one place a file
// opens (p3.5.1): the list of files and the Extensions open the same tab an agent would.

import type { ArtifactError, CanvasDo } from "@redgiant/protocol";
import { FILES_SANDBOX, PROGRAM_SANDBOX } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconAlert,
  IconClose,
  IconCode,
  IconDownload,
  IconExternal,
  IconFolderPlus,
  IconFullscreen,
  IconFullscreenExit,
  IconInfo,
  IconKeyboard,
  IconPlay,
  IconRefresh,
} from "../icons.js";
import { phoneScreen, phoneViewNote } from "../phone.js";
import {
  type CanvasTarget,
  canvasViewId,
  frontSession,
  getApi,
  lastError,
  openCanvas,
  retargetCanvas,
} from "../state.js";
import { canvasKind } from "../viewers/canvas-kind.js";
import { extensionOf, viewerFor } from "../viewers/kind.js";
import { CanvasTab, lastMove, report, setTabKind } from "../viewers/live.js";
import { copyQuestion, hasOfficeCopy, isOfficeFile } from "../viewers/office-bridge.js";
import { bytesText, download, type ViewerSource } from "../viewers/source.js";
import { ArtifactFrame } from "./ArtifactFrame.js";
import { shortcutsOpen } from "./Shortcuts.js";
import { CopyStale } from "./viewers/CopyBar.js";
import { DocEditor, editableInCanvas } from "./viewers/DocEditor.js";
import { EditPictureButton, IMAGE_FLAT, pictureEditable } from "./viewers/ImageEditor.js";
import { EditCopyButton, EditCopyNote } from "./viewers/OfficeEditor.js";
import { CanvasFile } from "./viewers/OpenCopy.js";

export { type CanvasKind, canvasKind } from "../viewers/canvas-kind.js";
export { parseDelimited } from "../viewers/delimited.js";

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
  /** Whether the path is a folder (its site): a name with no extension can be either. */
  const [folder, setFolder] = useState<boolean>();
  /** An artifact (3.5.9): the server says so (its folder or its header). */
  const [artifact, setArtifact] = useState(false);
  const [artView, setArtView] = useState<"app" | "source">("app");
  const [artErrors, setArtErrors] = useState<ArtifactError[]>([]);
  const [making, setMaking] = useState(false);
  /** Imported and never run (3.5.9): it opens on its source, and runs only on «Esegui». */
  const [pendingRun, setPendingRun] = useState(false);
  const site =
    !artifact &&
    canvasKind(target) === "site" &&
    (target.kind === "port" || extensionOf(target.path) !== "" || folder === true);
  // A file the editor knows opens editable (G37.1): the host keeps it, no reloading here.
  const editable = target.kind === "file" && folder === false && editableInCanvas(target);
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
        artifact
          ? "artifact"
          : site
            ? "site"
            : editable && target.kind === "file"
              ? viewerFor(target.path).kind
              : shown?.kind,
      ),
    [id, site, artifact, editable, shown?.kind],
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
    setFolder(undefined);
    setArtifact(false);
    setPendingRun(false);
    setArtView("app");
    setArtErrors([]);
    void getApi()
      .canvasLink(target)
      .then(
        (r) => {
          setFolder(!!r.folder);
          setArtifact(!!r.artifact);
          setLink(r.url);
          if (r.artifact && target.kind === "file" && target.scope !== "outside")
            void getApi()
              .artifactState(target.scope, target.path)
              .then(
                (st) => {
                  setPendingRun(st.pendingRun);
                  if (st.pendingRun) setArtView("source");
                },
                () => {},
              );
        },
        (e: unknown) => setError((e as Error).message),
      );
  }, [key]);
  // Files: when they change, what is shown follows (a viewer: the file alone; a site: its folder).
  useEffect(() => {
    if (target.kind !== "file" || editable || folder === undefined) return;
    let stopped = false;
    const look = () =>
      void getApi()
        .canvasVersion(target.scope, target.path, !site || artifact)
        .then(
          (r) => !stopped && setVersion((v) => (v === r.version ? v : r.version)),
          () => {},
        );
    look();
    const timer = setInterval(look, site || artifact ? 2000 : 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, site, artifact, editable, folder]);
  // Open copies (p3.5.12): an original that has one is shown through it, in its tab (with the
  // copy's bar); a copy older than its original says so and offers «Rifai la copia».
  const copyQ =
    target.kind === "file" && target.scope !== "outside" ? copyQuestion(target.path) : undefined;
  const [copyWait, setCopyWait] = useState(copyQ?.showing === "original");
  const [stale, setStale] = useState(false);
  const [copyAsked, setCopyAsked] = useState(0);
  useEffect(() => {
    setStale(false);
    if (!copyQ || target.kind !== "file") {
      setCopyWait(false);
      return;
    }
    const scope = target.scope;
    setCopyWait(copyQ.showing === "original");
    let live = true;
    void getApi()
      .editorCopy(scope, copyQ.original)
      .then(
        (r) => {
          if (!live) return;
          if (copyQ.showing === "copy") setStale(!!r.copy && r.stale === true);
          else if (r.copy) retargetCanvas(id, { kind: "file", scope, path: r.copy });
          setCopyWait(false);
        },
        () => live && setCopyWait(false),
      );
    return () => {
      live = false;
    };
  }, [key, copyAsked]);
  // On a phone documents and presentations are only looked at: said over them (p3.5.12).
  const [phoneNoteClosed, setPhoneNoteClosed] = useState(false);
  const phoneNote =
    !phoneNoteClosed &&
    target.kind === "file" &&
    target.scope !== "outside" &&
    phoneViewNote({ phone: phoneScreen(), path: target.path, editor: isOfficeFile(target.path) });
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
        {target.kind === "file" &&
          target.scope !== "outside" &&
          folder === false &&
          IMAGE_FLAT.test(target.path) &&
          !pictureEditable(target) && <EditPictureButton scope={target.scope} path={target.path} />}
        {artifact && target.kind === "file" && (
          <>
            <div class="vw-seg art-views" title={t("artView")}>
              <button
                type="button"
                class={artView === "app" ? "on" : ""}
                aria-pressed={artView === "app"}
                disabled={pendingRun}
                title={pendingRun ? t("artPendingHint") : undefined}
                onClick={() => setArtView("app")}
              >
                <IconPlay size={12} />
                {t("artApp")}
              </button>
              <button
                type="button"
                class={artView === "source" ? "on" : ""}
                aria-pressed={artView === "source"}
                onClick={() => setArtView("source")}
              >
                <IconCode size={12} />
                {t("artSource")}
              </button>
            </div>
            {pendingRun && target.scope !== "outside" && (
              <button
                type="button"
                class="button tiny primary art-make"
                title={t("artPendingHint")}
                onClick={() =>
                  void getApi()
                    .artifactRun(target.scope, target.path)
                    .then(
                      () => {
                        setPendingRun(false);
                        setArtView("app");
                      },
                      (e: unknown) => {
                        lastError.value = (e as Error).message;
                      },
                    )
                }
              >
                <IconPlay size={12} />
                <span>{t("artRun")}</span>
              </button>
            )}
            {artErrors.length > 0 && (
              <span
                class="artifact-errors"
                role="status"
                title={artErrors
                  .map((e) => `${e.message}${e.where ? ` (${e.where})` : ""}`)
                  .join("\n")}
              >
                <IconAlert size={12} />
                {artErrors.length === 1
                  ? t("artError1")
                  : t("artErrors", { n: String(artErrors.length) })}
              </span>
            )}
            {target.scope !== "outside" && (
              <button
                type="button"
                class="button tiny art-make"
                disabled={making}
                title={t("artMakeProjectHint")}
                onClick={() => {
                  setMaking(true);
                  const session = frontSession();
                  void getApi()
                    .artifactToProject(target.scope, target.path, session)
                    .then(
                      // The new folder's page opens next to it: that is the answer.
                      (r) => openCanvas(r.path, { kind: "file", ...r }),
                      (e: unknown) => {
                        lastError.value = (e as Error).message;
                      },
                    )
                    .finally(() => setMaking(false));
                }}
              >
                <IconFolderPlus size={13} />
                <span>{t("artMakeProject")}</span>
              </button>
            )}
          </>
        )}
        {move && moveShown === move.n && (
          <span class="canvas-agent" role="status" title={moveText(move.do)}>
            {moveText(move.do)}
          </span>
        )}
        <button
          type="button"
          class="icon-button"
          title={`${t("kbTitle")} (?)`}
          aria-label={t("kbTitle")}
          aria-keyshortcuts="?"
          onClick={() => (shortcutsOpen.value = true)}
        >
          <IconKeyboard size={14} />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("canvasReload")}
          aria-label={t("canvasReload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
        {url && !site && !artifact && (
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
      {phoneNote ? (
        <div class="canvas-edit-strip canvas-phone-note" role="note">
          <IconInfo size={13} />
          <span class="canvas-edit-text">{t("phoneViewOnly")}</span>
          <button
            type="button"
            class="icon-button tiny"
            title={t("dismiss")}
            aria-label={t("dismiss")}
            onClick={() => setPhoneNoteClosed(true)}
          >
            <IconClose size={12} />
          </button>
        </div>
      ) : (
        target.kind === "file" &&
        target.scope !== "outside" &&
        (hasOfficeCopy(target.path) || isOfficeFile(target.path)) && (
          <EditCopyNote editing={!hasOfficeCopy(target.path)} />
        )
      )}
      {stale && copyQ && target.kind === "file" && (
        <CopyStale
          scope={target.scope}
          original={copyQ.original}
          onDone={() => setCopyAsked((n) => n + 1)}
        />
      )}
      <div class={`canvas-body ${site || artifact ? "canvas-site" : "canvas-viewer"}`}>
        {error ? (
          <p class="notice error">{error}</p>
        ) : !url || copyWait ? (
          <div class="empty">{t("loading")}</div>
        ) : artifact && target.kind === "file" ? (
          (artView === "source" || pendingRun) && target.scope !== "outside" ? (
            <CanvasTab.Provider value={id}>
              <DocEditor file={{ scope: target.scope, path: target.path }} />
            </CanvasTab.Provider>
          ) : (
            <ArtifactFrame
              src={url}
              title={title}
              artifact={{ kind: "file", scope: target.scope, path: target.path }}
              // Its errors go to the conversation in front too (and to those that showed it).
              sessionId={frontSession()}
              onErrors={setArtErrors}
            />
          )
        ) : editable && target.kind === "file" ? (
          <CanvasTab.Provider value={id}>
            <DocEditor
              file={{ scope: target.scope, path: target.path }}
              line={target.at?.line}
              page={target.at?.page}
              fallback={() => (
                <CanvasFile
                  scope={target.scope}
                  path={target.path}
                  name={name}
                  url={url}
                  onKind={setShown}
                  {...(target.at && { at: target.at })}
                />
              )}
            />
          </CanvasTab.Provider>
        ) : site ? (
          <iframe
            key={url}
            title={title}
            src={url}
            // An opaque origin: the site cannot read RedGiant's storage or its access. Agent-made
            // pages open no windows (3.5.8: their links ask the person); a project's program may.
            sandbox={target.kind === "port" ? PROGRAM_SANDBOX : FILES_SANDBOX}
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
