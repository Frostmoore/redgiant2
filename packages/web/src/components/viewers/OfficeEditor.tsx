// Documents and presentations in the canvas (G37.4): LibreOffice in the browser (ZetaOffice),
// served by RedGiant in an isolated frame (/zeta/), inside the editor's shell (its bar and the
// panel «Modifiche»). Before anything loads the canvas checks what the engine needs (a secure
// page, an isolated frame, WebGL in workers, enough memory); the engine comes down the first time
// with its bar (on the server, then into this browser's storage). The agents' revisions are
// applied in the frame as they come (in Writer each one is an entry of LibreOffice's own undo
// list), the person's own edits are saved from the frame and sent as one revision. Without the
// full editor: the laid-out pages, refreshed as LibreOffice on the server writes the file, and a
// find and replace; one sentence says why and how to get the full editor. LibreOffice's own
// menus are English; everything around it is ours, in the person's language.

import type { DocChange, DocFile, DocOp, DocSnapshot, Job } from "@redgiant/protocol";
import { docKey, PERSON } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconAlert, IconDownload, IconPencil, IconSpinner } from "../../icons.js";
import { attempt, getApi, openCanvas, openDoc, saveDoc, sendDoc } from "../../state.js";
import {
  exportsOf,
  fallbackOf,
  type OfficeFallback,
  originalOf,
  picturesOf,
  plainActions,
} from "../../viewers/office-bridge.js";
import {
  type FrameMsg,
  NotHolderError,
  type OfficeTenant,
  sharedOffice,
} from "../../viewers/office-shared.js";
import { bytesText } from "../../viewers/source.js";
import { Progress, useJob } from "../ui.js";
import { CopyBar } from "./CopyBar.js";
import { changeText, whoText } from "./DocEditor.js";
import { PagedView } from "./OpenCopy.js";

type Phase =
  | { at: "checking" }
  | { at: "fallback"; why: OfficeFallback; detail?: string }
  | { at: "server"; job: string }
  | { at: "browser"; done: number; total: number }
  | { at: "opening" }
  | { at: "elsewhere" }
  | { at: "ready" };

const nameOf = (p: string) => p.split("/").pop() ?? p;
/** The pause after the person's last edit before the frame's file is saved. */
const SAVE_PAUSE_MS = 1500;

/** The full editor and its fallback for one ODT or ODP. */
export function OfficeEditor({ file }: { file: DocFile }) {
  const [phase, setPhase] = useState<Phase>({ at: "checking" });
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Takes the page's one engine for this tab (when the person comes back to it). */
  const want = useRef<() => void>(() => {});
  const original = originalOf(file.path);

  useEffect(() => {
    let alive = true;
    const shared = sharedOffice();
    const listeners: ((m: FrameMsg) => void)[] = [];
    const tenant: OfficeTenant = {
      slot: () => bodyRef.current,
      release: async () => {
        // The person's last edits go first, then the document leaves the engine.
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = undefined;
        if (dirty && engine === true) save();
        await chain;
        if (engine === false) return;
        engine = "away";
        if (alive) setPhase({ at: "elsewhere" });
      },
      message: (m) => {
        for (const l of listeners) l(m);
      },
    };
    shared.join(tenant);
    const ask = (m: FrameMsg, timeoutMs?: number) => shared.ask(tenant, m, timeoutMs);
    const fallback = (why: OfficeFallback, detail?: string) => {
      if (alive) setPhase({ at: "fallback", why, ...(detail && { detail }) });
      engine = false;
      // The fallback has no place for the frame: it waits out of sight for another tab.
      if (shared.owner === tenant) void shared.leave(tenant);
    };

    // ---- the document, the same for the full editor and the fallback ----
    /** true: open in the engine; "away": another tab has the engine; false: the fallback. */
    let engine: boolean | "away" | undefined;
    let revision = 0;
    let snapshot:
      | { snap: Extract<DocSnapshot, { family: "document" }>; revision: number }
      | undefined;
    let chain: Promise<unknown> = Promise.resolve();
    const run = (task: () => Promise<unknown>) => {
      chain = chain.then(task).catch((err: unknown) => {
        if (alive && !(err instanceof NotHolderError))
          setNote(t("docRefused", { reason: (err as Error).message }));
      });
    };
    let dirty = false;
    let uploading: string | undefined;
    /** Ctrl+S came while edits were on their way: the host writes the file once they are in. */
    let saveAfter = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let editingUntil = 0;
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    const resync = () => sendDoc({ type: "doc.open", file });
    const saveFile = () => {
      saveAfter = false;
      sendDoc({ type: "doc.save", file });
    };
    const pictures = async (hashes: string[]) => {
      const out: Record<string, ArrayBuffer> = {};
      for (const h of hashes) out[h] = (await getApi().officeBlob(h)).slice().buffer;
      return out;
    };
    const openInFrame = () =>
      run(async () => {
        const s = snapshot;
        if (!s || engine !== true) return;
        const bytes = await getApi().officeFile(file.scope, file.path, s.snap.base);
        const actions = plainActions(s.snap.pending) ?? [];
        await ask({
          t: "open",
          app: s.snap.app,
          bytes: bytes.slice().buffer,
          pending: actions,
          pictures: await pictures(picturesOf(actions)),
        });
        revision = s.revision;
        dirty = false;
        if (alive) setPhase({ at: "ready" });
      });
    const save = () =>
      run(async () => {
        if (!dirty || uploading || engine !== true) return;
        dirty = false;
        if (alive) setSaving(true);
        try {
          const base = revision;
          const r = await ask({ t: "export" });
          const bytes = new Uint8Array(r.bytes as ArrayBuffer);
          const up = await getApi().officeUpload(file.scope, file.path, base, bytes);
          if (!up.hunks.length) {
            if (saveAfter) saveFile();
            return;
          }
          uploading = `s${Date.now().toString(36)}`;
          sendDoc({
            type: "doc.ops",
            file,
            clientId: uploading,
            baseRevision: base,
            groupId: group,
            ops: [
              {
                family: "document",
                engine: "libreoffice-uno",
                engineVersion: "1",
                op: { t: "file", blob: up.blob, size: up.size, hunks: up.hunks },
              },
            ],
          });
        } finally {
          if (alive) setSaving(false);
        }
      });
    /** Ctrl+S (or Cmd+S) in the document: the person's edits sent now, then the file written. */
    const saveNow = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      if ((dirty || uploading) && engine === true) {
        saveAfter = true;
        saveDoc(file, false);
        save();
      } else saveDoc(file);
    };
    const edited = () => {
      dirty = true;
      const now = Date.now();
      if (now > editingUntil) {
        // A pause longer than this starts another gesture (another line of the panel).
        if (now - editingUntil > 4000) group = `g-${Math.random().toString(36).slice(2, 10)}`;
        sendDoc({ type: "doc.presence", file, editing: true, from: 0, to: 0, revision });
      }
      editingUntil = now + 2500;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        save();
        setTimeout(() => {
          if (Date.now() >= editingUntil) sendDoc({ type: "doc.presence", file, editing: false });
        }, 2600);
      }, SAVE_PAUSE_MS);
    };
    listeners.push((m) => {
      if (engine !== true) return;
      if (m.t === "modified" || m.t === "typing") edited();
      else if (m.t === "save-key") saveNow();
    });

    const close = openDoc(file, {
      opened(snap: DocSnapshot, rev: number) {
        if (snap.family !== "document") return;
        snapshot = { snap, revision: rev };
        revision = rev;
        uploading = undefined;
        openInFrame();
      },
      replaced(m) {
        if (m.snapshot.family !== "document") return;
        snapshot = { snap: m.snapshot, revision: m.revision };
        revision = m.revision;
        openInFrame();
      },
      changed(m) {
        if (engine !== true) {
          revision = m.revision;
          return;
        }
        run(async () => {
          if (m.revision !== revision + 1) return resync();
          const actions = plainActions(m.ops as DocOp[]);
          // Another page's saved file: opened again from what the host has.
          if (!actions) return resync();
          const who = whoText(m.change);
          const r = await ask({
            t: "apply",
            actions,
            revision: m.revision,
            title: `${who}: ${m.change.summary.text}`.slice(0, 120),
            pictures: await pictures(picturesOf(actions)),
          });
          revision = m.revision;
          if (m.change.author !== PERSON) showNote(m.change);
          const skipped = r.skipped as { index: number; error: string }[] | undefined;
          if (skipped?.length) {
            console.warn("LibreOffice skipped actions", JSON.stringify(skipped));
            resync();
          }
        });
      },
      ack(m) {
        if (m.clientId !== uploading) return;
        uploading = undefined;
        revision = m.revision;
        if (dirty) save();
        else if (saveAfter) saveFile();
      },
      rejected(m) {
        if (m.clientId === uploading) {
          uploading = undefined;
          if (saveAfter) saveFile();
          resync();
        }
      },
    });
    const showNote = (c: DocChange) => {
      if (!alive) return;
      setNote(`${whoText(c)}: ${changeText(c.summary)}`);
      setTimeout(() => alive && setNote(undefined), 7000);
    };

    // ---- the engine for this tab: checked, downloaded once, started once for the page ----
    const early = fallbackOf({
      secure: window.isSecureContext,
      memory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    });
    let taking = false;
    let opens = 0;
    const take = async () => {
      if (taking || !alive || engine === false || engine === true) return;
      taking = true;
      try {
        if (early) return fallback(early);
        const how = await shared.acquire(tenant);
        if (!alive) return;
        // What the frame showed for another tab stays hidden until this document is open.
        if (how !== "same") shared.element?.classList.add("waiting");
        if (!shared.started) {
          if (alive) setPhase({ at: "checking" });
          const check = await shared.check(tenant);
          if (!alive) return;
          const why = check
            ? fallbackOf({
                secure: check.secure === true,
                isolated: check.isolated === true,
                webgl: check.webgl === true,
              })
            : "browser";
          if (why) return fallback(why);
          // The engine's files on the server first (downloaded once, with the bar).
          const st = await getApi()
            .officeState()
            .catch(() => undefined);
          if (!st) return fallback("failed", t("uiFailedGeneric"));
          if (!st.ready) {
            const p = await getApi()
              .officePrepare()
              .catch((e: unknown) => ({
                ready: false,
                job: undefined,
                error: (e as Error).message,
              }));
            if (p.job) {
              if (alive) setPhase({ at: "server", job: p.job });
              let j: Job | undefined;
              for (;;) {
                await new Promise((r) => setTimeout(r, 1000));
                if (!alive) return;
                j = await getApi()
                  .job(p.job)
                  .catch(() => undefined);
                if (j && j.state !== "running") break;
              }
              if (j?.state !== "done") return fallback("failed", j?.error?.message);
            } else if (!p.ready) return fallback("failed", (p as { error?: string }).error);
          }
          // Then into this browser (its storage keeps them), and LibreOffice starts.
          if (alive) setPhase({ at: "browser", done: 0, total: 1 });
          const err = await shared.start(tenant).then(
            () => undefined,
            (e: unknown) => e as Error,
          );
          if (err instanceof NotHolderError) return;
          if (err) return fallback("failed", err.message);
        }
        if (!alive || shared.owner !== tenant) return;
        engine = true;
        setPhase({ at: "opening" });
        // The first time with the snapshot just received; back from another tab, fresh from the
        // host (the agents may have changed it meanwhile).
        if (opens++ === 0) openInFrame();
        else resync();
      } catch {
        // The tab closed while waiting for the engine.
      } finally {
        taking = false;
      }
    };
    listeners.push((m) => {
      if (m.t === "progress" && alive)
        setPhase((ph) =>
          ph.at === "browser"
            ? { at: "browser", done: Number(m.done), total: Number(m.total) }
            : ph,
        );
    });
    want.current = () => void take();

    // The tab the person looks at takes the engine (a hidden tab measures nothing).
    const body = bodyRef.current;
    let seen: ResizeObserver | undefined;
    if (body && typeof ResizeObserver === "function") {
      seen = new ResizeObserver(() => {
        if (body.offsetWidth > 0 && body.offsetHeight > 0) void take();
      });
      seen.observe(body);
    } else void take();

    return () => {
      alive = false;
      want.current = () => {};
      seen?.disconnect();
      void shared.leave(tenant).finally(() => close());
    };
  }, [file.scope, file.path]);

  // The engine's frame shows only once the document is open in it.
  useEffect(() => {
    const el = sharedOffice().element;
    if (el && el.parentElement === bodyRef.current)
      el.classList.toggle("waiting", phase.at !== "ready");
  });

  const fb = phase.at === "fallback" ? phase : undefined;
  const loading = phase.at !== "ready" && !fb;
  return (
    <div class="doc-office">
      <OfficeStrip file={file} original={original} saving={saving} />
      {note && (
        <div class="canvas-agent doc-office-note" role="status">
          {note}
        </div>
      )}
      {fb ? (
        <OfficeFallbackView file={file} why={fb.why} detail={fb.detail} />
      ) : (
        // The page's one LibreOffice frame comes here (office-shared.ts) while this tab is shown.
        <div class="doc-office-body" ref={bodyRef}>
          {loading && <OfficeLoading phase={phase} onTake={() => want.current()} />}
        </div>
      )}
    </div>
  );
}

function OfficeLoading({ phase, onTake }: { phase: Phase; onTake: () => void }) {
  const job = useJob(phase.at === "server" ? phase.job : undefined);
  const step = job?.steps.find((s) => s.state === "running") ?? job?.steps.at(-1);
  return (
    <div class="vw-empty vw-open-card doc-office-wait" aria-live="polite">
      <strong>
        {phase.at === "server"
          ? t("officeDownloading", { size: bytesText(ZETA_BYTES) })
          : phase.at === "browser"
            ? t("officeBrowserCopy", { size: bytesText(ZETA_BYTES) })
            : phase.at === "opening"
              ? t("officeOpening")
              : phase.at === "elsewhere"
                ? t("officeElsewhere")
                : t("officeChecking")}
      </strong>
      {phase.at === "elsewhere" && (
        <button type="button" class="vw-btn small" onClick={onTake}>
          {t("officeShowHere")}
        </button>
      )}
      {phase.at === "server" &&
        (step?.progress ? (
          <Progress progress={step.progress} />
        ) : (
          <div class="ui-progress">
            <div class="ui-bar busy" role="progressbar" aria-label={t("loading")}>
              <span />
            </div>
          </div>
        ))}
      {phase.at === "browser" && (
        <Progress
          progress={{
            done: phase.done,
            total: phase.total > 1 ? phase.total : null,
            rate: null,
            secondsLeft: null,
          }}
        />
      )}
      {(phase.at === "checking" || phase.at === "opening") && <IconSpinner size={18} />}
      <p class="dim">{phase.at === "elsewhere" ? t("officeOneEngine") : t("officeFirstTime")}</p>
    </div>
  );
}

/** The document's own line: an open copy's original and its switch, «Esporta come…». */
function OfficeStrip({
  file,
  original,
  saving,
}: {
  file: DocFile;
  original: string | undefined;
  saving: boolean;
}) {
  const [back, setBack] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!original) return;
    void getApi()
      .editorSettings()
      .then(
        (r) => setBack(r.settings.reexport?.[docKey(file)] === true),
        () => {},
      );
  }, [file.scope, file.path]);
  const ext = original?.split(".").pop()?.toUpperCase() ?? "";
  const toggle = (on: boolean) =>
    void attempt(async () => {
      const a = getApi();
      const { settings } = await a.editorSettings();
      const reexport = { ...(settings.reexport ?? {}) };
      if (on) reexport[docKey(file)] = true;
      else delete reexport[docKey(file)];
      await a.setEditorSettings({ ...settings, reexport });
      setBack(on);
    });
  const exportAs = (to: string) =>
    void attempt(async () => {
      setBusy(true);
      try {
        const blob = await getApi().officeExport(file.scope, file.path, to);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${nameOf(file.path).replace(/\.[^.]+$/, "")}.${to}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } finally {
        setBusy(false);
      }
    });
  return (
    <>
      {original && (
        <CopyBar
          original={original}
          rewrite={
            back === undefined
              ? undefined
              : {
                  on: back,
                  onChange: toggle,
                  help: t("officeWriteBackHint", { name: nameOf(original) }),
                }
          }
        />
      )}
      <div class="vw-bar doc-office-strip">
        <div class="spacer" />
        {saving && (
          <span class="dim doc-office-saving">
            <IconSpinner size={12} /> {t("officeSaving")}
          </span>
        )}
        <label class="doc-office-export">
          <IconDownload size={13} />
          <select
            aria-label={t("officeExport")}
            value=""
            disabled={busy}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              (e.target as HTMLSelectElement).value = "";
              if (v) exportAs(v);
            }}
          >
            <option value="">{busy ? t("officeExporting") : t("officeExport")}</option>
            {exportsOf(file.path).map((x) => (
              <option key={x} value={x}>
                {x.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

const WHY: Record<
  OfficeFallback,
  | "officeWhyInsecure"
  | "officeWhyBrowser"
  | "officeWhyWebgl"
  | "officeWhyMemory"
  | "officeWhyFailed"
> = {
  insecure: "officeWhyInsecure",
  browser: "officeWhyBrowser",
  webgl: "officeWhyWebgl",
  memory: "officeWhyMemory",
  failed: "officeWhyFailed",
};

/** Without the full editor: the pages (refreshed as the server writes), find and replace. */
function OfficeFallbackView({
  file,
  why,
  detail,
}: {
  file: DocFile;
  why: OfficeFallback;
  detail?: string | undefined;
}) {
  const [url, setUrl] = useState<string>();
  const [version, setVersion] = useState(0);
  const [find, setFind] = useState("");
  const [text, setText] = useState("");
  const [done, setDone] = useState<string>();
  useEffect(() => {
    void getApi()
      .canvasLink({ kind: "file", scope: file.scope, path: file.path })
      .then(
        (r) => setUrl(r.url),
        () => {},
      );
    let stop = false;
    const look = () =>
      void getApi()
        .canvasVersion(file.scope, file.path, true)
        .then(
          (r) => !stop && setVersion((v) => (v === r.version ? v : r.version)),
          () => {},
        );
    look();
    const timer = setInterval(look, 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [file.scope, file.path]);
  const replace = (all: boolean) =>
    void attempt(async () => {
      if (!find) return;
      await getApi().officeReplace({ scope: file.scope, path: file.path, find, text, all });
      setDone(t("officeReplaced"));
      setTimeout(() => setDone(undefined), 5000);
    });
  return (
    <div class="doc-office-fallback">
      <div class="notice doc-office-why" role="note">
        <IconAlert size={14} />
        <span>
          {t(WHY[why], { reason: detail ?? "" })} {t("officeWhyTail")}
        </span>
      </div>
      <form
        class="doc-office-replace"
        onSubmit={(e) => {
          e.preventDefault();
          replace(false);
        }}
      >
        <input
          type="text"
          value={find}
          placeholder={t("officeFind")}
          aria-label={t("officeFind")}
          onInput={(e) => setFind((e.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          value={text}
          placeholder={t("officeReplaceWith")}
          aria-label={t("officeReplaceWith")}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="vw-btn small" disabled={!find}>
          {t("officeReplace")}
        </button>
        <button type="button" class="vw-btn small" disabled={!find} onClick={() => replace(true)}>
          {t("officeReplaceAll")}
        </button>
        {done && <span class="dim">{done}</span>}
      </form>
      <div class="doc-office-pages">
        {url && (
          <PagedView
            key={`${version}`}
            scope={file.scope}
            path={file.path}
            name={nameOf(file.path)}
            url={`${url}${url.includes("?") ? "&" : "?"}v=${version}`}
          />
        )}
      </div>
    </div>
  );
}

/** The full editor's files, brotli (zeta.ts): what the first «Modifica» brings down. */
export const ZETA_BYTES = 53_243_567;

/**
 * What «Modifica» will do in this browser, said before it is pressed (p3.5.3: the person saw no
 * word of the download nor of the fallback): the full editor and its size the first time, or why
 * it cannot start here and what is used instead. Empty when the editor is already in this browser.
 */
export async function editCopyNote(env: {
  secure: boolean;
  memory: number | null;
  chromium: boolean;
  cached: () => Promise<boolean>;
}): Promise<{ short: string; long: string } | undefined> {
  const why =
    fallbackOf({ secure: env.secure, memory: env.memory }) ??
    (env.chromium ? undefined : "browser");
  if (why)
    return {
      short: t("officeEditNoteFallbackShort"),
      long: `${t(WHY[why], { reason: "" })} ${t("officeEditNoteFallback")}`,
    };
  if (await env.cached().catch(() => false)) return undefined;
  const size = bytesText(ZETA_BYTES);
  return {
    short: t("officeEditNoteFirstShort", { size }),
    long: t("officeEditNoteFirst", { size }),
  };
}

const browserEnv = () => ({
  secure: window.isSecureContext,
  memory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
  // Document-Isolation-Policy, which the frame needs, is Chromium's only (G37.4).
  chromium:
    !!(
      navigator as { userAgentData?: { brands?: { brand: string }[] } }
    ).userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand)) ||
    /\b(Chrome|Chromium|Edg)\//.test(navigator.userAgent),
  cached: async () =>
    typeof caches !== "undefined" && (await caches.keys()).some((k) => k.startsWith("rg-zeta-")),
});

/** «Modifica» on a DOCX/PPTX in the canvas: its open copy, made if missing, opened in a tab. */
export function EditCopyButton({ scope, path }: { scope: string; path: string }) {
  const [job, setJob] = useState<{ id: string; copy: string }>();
  const [note, setNote] = useState<{ short: string; long: string }>();
  const j = useJob(job?.id);
  useEffect(() => {
    if (!job || !j || j.state === "running") return;
    if (j.state === "done") openCanvas(nameOf(job.copy), { kind: "file", scope, path: job.copy });
    setJob(undefined);
  }, [j?.state]);
  useEffect(() => {
    let live = true;
    void editCopyNote(browserEnv()).then(
      (n) => live && setNote(n),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      {note && (
        <span class="dim canvas-edit-note" title={note.long}>
          {note.short}
        </span>
      )}
      <button
        type="button"
        class="button tiny canvas-edit-copy"
        title={note ? `${t("officeEditCopyHint")}. ${note.long}` : t("officeEditCopyHint")}
        disabled={!!job}
        onClick={() =>
          void attempt(async () => {
            const r = await getApi().officeCopy(scope, path);
            if (r.job) setJob({ id: r.job, copy: r.path });
            else openCanvas(nameOf(r.path), { kind: "file", scope, path: r.path });
          })
        }
      >
        {job ? <IconSpinner size={13} /> : <IconPencil size={13} />}
        <span>{job ? t("officeMakingCopy") : t("officeEditCopy")}</span>
      </button>
    </>
  );
}
