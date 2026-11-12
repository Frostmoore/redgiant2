// One engine, two forms (3.5.9, study §7): the frame that runs an artifact in the canvas and a
// widget in the chat. A signed `/preview/` link, `sandbox="allow-scripts allow-forms"` (an opaque
// origin: no access to RedGiant, no popups, no navigation of the page), a policy with no network.
// The page listens only to its frame: height, errors (to the server, for the agent), and «send to
// chat», taken at once only right after the person's click in the frame; otherwise it waits in a
// strip under the frame for «Send» or «Leave it».

import { effect } from "@preact/signals";
import { ARTIFACT_SANDBOX, type ArtifactError, type ArtifactRef } from "@redgiant/protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addErrors,
  ClickGuard,
  frameMessage,
  hostContext,
  messageText,
} from "../artifact-frame.js";
import { lang, t } from "../i18n.js";
import { IconAlert, IconAside, IconCanvas, IconCheck, IconPin, IconSend, IconX } from "../icons.js";
import { frontSession, getApi, getLive, openCanvas } from "../state.js";
import { theme } from "../theme.js";

/** Sends a message as the person's, marked as coming from an artifact or a widget. */
export function sendFromArtifact(sessionId: string, text: string): void {
  getLive().send({
    type: "session.send",
    sessionId,
    text,
    via: "artifact",
    clientId: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  });
}

export function ArtifactFrame({
  src,
  title,
  artifact,
  sessionId,
  auto = false,
  onErrors,
  frameRef,
}: {
  src: string;
  title: string;
  /** What its errors belong to. */
  artifact: ArtifactRef;
  /** The conversation it sends to (a widget's own; for the canvas, the one in front). */
  sessionId?: string | undefined;
  /** Its height follows its content (a widget), at most 70% of the screen, then it scrolls. */
  auto?: boolean;
  onErrors?: (errors: ArtifactError[]) => void;
  frameRef?: { current: HTMLIFrameElement | null };
}) {
  const own = useRef<HTMLIFrameElement>(null);
  const frame = frameRef ?? own;
  const [height, setHeight] = useState(auto ? 48 : undefined);
  const [asking, setAsking] = useState<string>();
  const guard = useMemo(() => new ClickGuard(), [src]);
  const errors = useRef<ArtifactError[]>([]);
  const queued = useRef<ArtifactError[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loads = useRef(0);
  const refKey = JSON.stringify(artifact);

  /** The theme, sent to the frame (only to it) at its start and at every change. */
  const sendTheme = () => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    w.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: hostContext(document, window, lang.value),
      },
      "*",
    );
  };
  useEffect(
    () =>
      effect(() => {
        void theme.value;
        void lang.value;
        requestAnimationFrame(sendTheme);
      }),
    [],
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const change = () => sendTheme();
    mq?.addEventListener?.("change", change);
    return () => mq?.removeEventListener?.("change", change);
  }, []);

  // A click in the frame: the page loses focus to it.
  useEffect(() => {
    const blur = () =>
      setTimeout(() => {
        if (document.activeElement === frame.current) guard.clicked();
      }, 0);
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [guard]);

  useEffect(() => {
    errors.current = [];
    loads.current = 0;
    onErrors?.([]);
    setAsking(undefined);
  }, [src]);

  const flush = (fresh = false) => {
    const batch = queued.current;
    queued.current = [];
    if (!batch.length && !fresh) return;
    void getApi()
      .artifactErrors({
        ref: artifact,
        ...(sessionId && { sessionId }),
        errors: batch,
        ...(fresh && { fresh: true }),
      })
      .catch(() => {});
  };

  useEffect(() => {
    const listen = (e: MessageEvent) => {
      const m = frameMessage(e, frame.current);
      if (!m) return;
      switch (m.method) {
        case "ui/notifications/initialized": {
          sendTheme();
          // Every load (3.5.12): the page says «initialized» before its errors, so what it said
          // before (an older version, an earlier visit) is forgotten, here and on the server.
          if (loads.current++ > 0 || errors.current.length) {
            errors.current = [];
            onErrors?.([]);
          }
          queued.current = [];
          clearTimeout(timer.current);
          flush(true);
          return;
        }
        case "ui/notifications/size-changed":
          if (auto) setHeight(Math.max(24, Math.ceil(m.params.height)));
          return;
        case "redgiant/error": {
          const before = errors.current.length;
          errors.current = addErrors(errors.current, [m.params]);
          if (errors.current.length === before) return;
          onErrors?.(errors.current);
          queued.current.push(m.params);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => flush(), 400);
          return;
        }
        case "ui/message": {
          const text = messageText(m);
          if (!text) return;
          const to = sessionId ?? frontSession();
          const clicked = guard.take(
            document.activeElement === frame.current,
            (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ===
              true,
          );
          if (clicked && to) sendFromArtifact(to, text);
          else setAsking(text);
          return;
        }
      }
    };
    window.addEventListener("message", listen);
    return () => {
      window.removeEventListener("message", listen);
      clearTimeout(timer.current);
      flush();
    };
  }, [src, refKey, sessionId, auto, guard]);

  const to = sessionId ?? frontSession();
  const past = useRef<HTMLSpanElement>(null);
  return (
    <div class={`artifact-frame${auto ? " auto" : ""}`}>
      {/* The app may keep Tab for itself: from the keyboard it can be skipped (p3.5.11). Shown
          only when it has the focus. */}
      <button type="button" class="artifact-skip" onClick={() => past.current?.focus()}>
        {t("artSkip", { name: title })}
      </button>
      <iframe
        ref={frame}
        key={src}
        title={title}
        src={src}
        sandbox={ARTIFACT_SANDBOX}
        // Loaded: the theme again (its first messages may come before the page listens), and the
        // frame answers with its height.
        onLoad={sendTheme}
        style={auto && height !== undefined ? { height: `${height}px` } : undefined}
      />
      <span class="sr-only" tabIndex={-1} ref={past}>
        {t("artAfter", { name: title })}
      </span>
      {asking !== undefined && (
        <div class="artifact-ask" role="status">
          <IconSend size={13} />
          <span class="artifact-ask-text">
            <span class="dim">{to ? t("widgetAsks") : t("widgetNoChat")}</span>
            <q>{asking.length > 300 ? `${asking.slice(0, 300)}…` : asking}</q>
          </span>
          <button
            type="button"
            class="button tiny primary"
            disabled={!to}
            onClick={() => {
              if (to) sendFromArtifact(to, asking);
              setAsking(undefined);
            }}
          >
            <IconCheck size={12} />
            {t("widgetSend")}
          </button>
          <button type="button" class="button tiny" onClick={() => setAsking(undefined)}>
            <IconX size={12} />
            {t("widgetDismiss")}
          </button>
        </div>
      )}
    </div>
  );
}

/** A widget in the chat (3.5.9): the frame, its title, «Open in the Canvas» and «Keep it». */
export function WidgetCard({
  sessionId,
  seq,
  index,
  title,
}: {
  sessionId: string;
  seq: number;
  index: number;
  title: string;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<ArtifactError[]>([]);
  const [kept, setKept] = useState<{ scope: string; path: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getApi()
      .widgetLink(sessionId, seq, index)
      .then(
        (r) => setUrl(r.url),
        (e: unknown) => setError((e as Error).message),
      );
  }, [sessionId, seq, index]);
  const name = title || t("widgetTitle");
  /**
   * Kept once: the canvas opens files, so «Open in the Canvas» and «Keep it» both make the file
   * `artefatti/<name>.html` (the first time) and open it there.
   */
  const keep = async (): Promise<{ scope: string; path: string } | undefined> => {
    if (kept) return kept;
    setBusy(true);
    try {
      const k = await getApi().keepWidget(sessionId, seq, index);
      setKept(k);
      return k;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    const k = await keep();
    if (k) openCanvas(k.path.split("/").pop() ?? name, { kind: "file", ...k });
  };
  return (
    <div class="widget-card" data-widget={`${seq}.${index}`}>
      {/* Quiet (3.5.12): the name small, the actions shown on hover or focus (always on touch). */}
      <div class="widget-head">
        <span class="widget-name" title={name}>
          <IconCanvas size={12} />
          <span>{name}</span>
        </span>
        {errors.length > 0 && (
          <span class="artifact-errors" title={errors.map((e) => e.message).join("\n")}>
            <IconAlert size={12} />
            {errors.length === 1 ? t("artError1") : t("artErrors", { n: String(errors.length) })}
          </span>
        )}
        <div class="widget-tools">
          <button
            type="button"
            class="widget-act"
            disabled={busy}
            title={t("widgetOpenCanvas")}
            onClick={() => void open()}
          >
            <IconAside size={13} />
            <span>{t("widgetOpenCanvas")}</span>
          </button>
          <button
            type="button"
            class={`widget-act${kept ? " done" : ""}`}
            disabled={busy || !!kept}
            title={kept ? t("widgetKept", { path: kept.path }) : t("widgetKeepHint")}
            onClick={() => void open()}
          >
            {kept ? <IconCheck size={13} /> : <IconPin size={13} />}
            <span>{kept ? t("widgetKeptShort") : t("widgetKeep")}</span>
          </button>
        </div>
      </div>
      {error ? (
        <p class="notice error">{error}</p>
      ) : url ? (
        <ArtifactFrame
          src={url}
          title={name}
          artifact={{ kind: "widget", sessionId, seq, index }}
          sessionId={sessionId}
          auto
          onErrors={setErrors}
        />
      ) : (
        <div class="widget-loading dim">{t("loading")}</div>
      )}
      {kept && (
        <div class="widget-kept">
          <IconCheck size={11} />
          <span>{t("widgetKept", { path: kept.path })}</span>
        </div>
      )}
    </div>
  );
}
