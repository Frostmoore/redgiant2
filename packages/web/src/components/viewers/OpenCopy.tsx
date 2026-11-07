// The canvas and the converter together (G34.4).
// - Office files (docx, pptx, xlsx, their open twins, iWork, Visio, Publisher) are shown laid out
//   as on paper: LibreOffice makes a PDF on the server (`/api/files/preview`, downloaded the first
//   time with its bar), then the PDF viewer shows it. Nothing approximate stands in for it (the
//   person's decision, 2026-11-07); only where LibreOffice cannot come at all (Linux on ARM) the
//   simple reading is shown, and it says so. A sheet can also be seen as the interactive table.
// - Closed design files (PSD, AI, EPS, INDD, Sketch, Affinity, Figma…) are shown through their
//   open copy (`<file>.open/`), with a box saying what was converted and what was lost, and the
//   button that makes the copy when there is none yet. The losses come as stable codes and are
//   shown in the person's language (`loss_<code>`), the English only for a loss with no code.
// - Files no free program can read (INDD, Affinity, XD, a .fig copy) say they show only the
//   stored preview, which app is needed and what to export, with «Open in…» when it is here.
// - An IDML offers its two ways: Scribus (.sla, the default when it can come) or a drawing (ODG).
// - A video or a sound the browser cannot play gets "Convert to see it" (WebM or Opus beside it).
import type { Job } from "@redgiant/protocol";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FileNeeds, FileReport, LossCode } from "../../api.js";
import { t, tOptional } from "../../i18n.js";
import {
  IconAlert,
  IconDownload,
  IconExternal,
  IconKey,
  IconRefresh,
  IconSpinner,
} from "../../icons.js";
import { getApi, openVaultDraft } from "../../state.js";
import { pagedKind, viewerFor } from "../../viewers/kind.js";
import { download, type ViewerSource } from "../../viewers/source.js";
import { Choice, Progress, useJob } from "../ui.js";
import { FileViewer, VIEWERS } from "./FileViewer.js";

interface FileProps {
  scope: string;
  path: string;
  name: string;
  url: string;
  onKind?: (src: ViewerSource) => void;
  /** Where to open it (a citation: page or line). */
  at?: ViewerSource["at"];
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The file in the canvas: laid out, through its open copy, or in its own viewer. */
export function CanvasFile(p: FileProps) {
  // A file outside every project has no folder the converter knows: it is shown as it is.
  if (p.scope === "outside")
    return <FileViewer name={p.name} url={p.url} onKind={p.onKind} at={p.at} />;
  if (pagedKind(p.name)) return <PagedView {...p} />;
  return <MaybeConverted {...p} />;
}

/** A job's running step in words, with its bar (or a moving bar when it cannot be measured). */
function JobLine({ job }: { job?: Job | undefined }) {
  const step = job?.steps.find((s) => s.state === "running") ?? job?.steps.at(-1);
  return (
    <div class="vw-job">
      {step && (
        <span class="vw-job-step">
          <IconSpinner size={14} />
          {tOptional(`job_step_${step.id}`, job?.vars) ?? step.id}
          {step.id === "tool_download" && ` · ${t("vwLibreOfficeFirst")}`}
        </span>
      )}
      {step?.progress && step.progress.total !== null ? (
        <Progress progress={step.progress} />
      ) : (
        <div class="ui-progress">
          <div class="ui-bar busy" role="progressbar" aria-label={t("loading")}>
            <span />
          </div>
        </div>
      )}
    </div>
  );
}

/** A failed job in plain words, with the details for whoever helps. */
function Failed({ text, detail, retry }: { text: string; detail?: string; retry: () => void }) {
  return (
    <div class="vw-empty vw-open-card">
      <IconAlert size={26} />
      <strong>{text}</strong>
      {detail && <p class="dim vw-open-detail">{detail}</p>}
      <button type="button" class="vw-btn" onClick={retry}>
        <IconRefresh size={16} />
        {t("vwTryAgain")}
      </button>
    </div>
  );
}

type Paged =
  | { at: "asking" }
  | { at: "waiting"; job: string }
  | { at: "ready"; url: string; size: number }
  | { at: "failed"; message: string }
  /** LibreOffice cannot come to this computer: the simple reading, said plainly. */
  | { at: "simple" };

/** An office file laid out as on paper (LibreOffice's PDF), or the table of a sheet. */
export function PagedView({ scope, path, name, url, onKind, at }: FileProps) {
  const kind = pagedKind(name);
  const [state, setState] = useState<Paged>({ at: "asking" });
  const [mode, setMode] = useState<"page" | "table">("page");
  const [attempt, setAttempt] = useState(0);
  const job = useJob(state.at === "waiting" ? state.job : undefined);
  const fetchPdf = async () => {
    const blob = await getApi().filePreview(scope, path);
    setState({ at: "ready", url: URL.createObjectURL(blob), size: blob.size });
  };
  const fail = async (message: string) => {
    // Not here and not downloadable here: the only case for the simple reading.
    const formats = await getApi()
      .fileFormats()
      .catch(() => undefined);
    const lo = formats?.programs.find((x) => x.id === "libreoffice");
    if (lo && !lo.here && !lo.canDownload) setState({ at: "simple" });
    else setState({ at: "failed", message });
  };
  useEffect(() => {
    let live = true;
    setState({ at: "asking" });
    void getApi()
      .startFilePreview(scope, path)
      .then(
        async (r) => {
          if (!live) return;
          if (r.ready) await fetchPdf();
          else if (r.job) setState({ at: "waiting", job: r.job.id });
        },
        (e: unknown) => live && void fail((e as Error).message),
      )
      .catch((e: unknown) => live && void fail((e as Error).message));
    return () => {
      live = false;
    };
  }, [scope, path, url, attempt]);
  useEffect(() => {
    if (state.at !== "waiting" || !job || job.state === "running") return;
    if (job.state === "done")
      void fetchPdf().catch((e: unknown) => setState({ at: "failed", message: String(e) }));
    else void fail(job.error?.message ?? t("uiFailedGeneric"));
  }, [job?.state]);
  useEffect(
    () => () => (state.at === "ready" ? URL.revokeObjectURL(state.url) : undefined),
    [state],
  );
  useEffect(() => {
    onKind?.({ ...viewerFor(name), name, url });
  }, [name, url]);

  const sheet = kind === "sheet";
  let body: ComponentChildren;
  if (sheet && mode === "table") body = <FileViewer name={name} url={url} />;
  else if (state.at === "ready")
    body = (
      <PdfOf
        src={{
          kind: "pdf",
          format: "pdf",
          name: `${name}.pdf`,
          url: state.url,
          size: state.size,
          ...(at && { at }),
        }}
      />
    );
  else if (state.at === "simple")
    body = (
      <div class="vw-paged-simple">
        <p class="notice">{t("vwPagedSimple")}</p>
        <FileViewer name={name} url={url} />
      </div>
    );
  else if (state.at === "failed")
    body = (
      <Failed
        text={t("vwPagedFailed")}
        detail={state.message}
        retry={() => setAttempt((n) => n + 1)}
      />
    );
  else
    body = (
      <div class="vw-empty vw-open-card vw-paged-wait" aria-live="polite">
        <strong>{t("vwPagedPreparing")}</strong>
        <p class="dim">{t("vwPagedWhy")}</p>
        <JobLine job={job} />
        <button type="button" class="vw-btn" onClick={() => download(url, name)}>
          <IconDownload size={16} />
          {t("vwDownload")}
        </button>
      </div>
    );
  return (
    <div class="vw-paged">
      {sheet && (
        <div class="vw-bar">
          <div class="vw-seg">
            <button
              type="button"
              class={mode === "page" ? "on" : ""}
              aria-pressed={mode === "page"}
              onClick={() => setMode("page")}
            >
              {t("vwPagedPages")}
            </button>
            <button
              type="button"
              class={mode === "table" ? "on" : ""}
              aria-pressed={mode === "table"}
              onClick={() => setMode("table")}
            >
              {t("vwPagedTable")}
            </button>
          </div>
          <span class="dim vw-paged-hint">
            {mode === "page" ? t("vwPagedPagesHint") : t("vwPagedTableHint")}
          </span>
        </div>
      )}
      <div class="vw-paged-body">{body}</div>
    </div>
  );
}

/** The PDF viewer on a blob of the laid-out pages. */
function PdfOf({ src }: { src: ViewerSource }) {
  const [View, setView] = useState<{ v: (p: { src: ViewerSource }) => JSX.Element }>();
  useEffect(() => {
    void VIEWERS.pdf().then((v) => setView({ v: v as never }));
  }, []);
  if (!View) return <div class="vw-empty dim">{t("loading")}</div>;
  const V = View.v;
  return <V src={src} />;
}

/** The output the canvas shows first: layers, a picture, a drawing, pages, then the rest. */
export function bestOutput(outputs: { path: string; ext: string }[]) {
  const order = [
    "ora",
    "webm",
    "opus",
    "flac",
    "png",
    "jpg",
    "svg",
    "pdf",
    "odt",
    "odg",
    "odp",
    "ods",
  ];
  const rank = (e: string) => {
    const i = order.indexOf(e);
    return i < 0 ? order.length : i;
  };
  return [...outputs].filter((o) => o.ext !== "json").sort((a, b) => rank(a.ext) - rank(b.ext))[0];
}

/** Asks the converter what the file is, then shows it as it is or through its open copy. */
function MaybeConverted(p: FileProps) {
  const [report, setReport] = useState<FileReport | null>();
  useEffect(() => {
    let live = true;
    setReport(undefined);
    void getApi()
      .fileReport(p.scope, p.path)
      .then(
        (r) => live && setReport(r),
        () => live && setReport(null),
      );
    return () => {
      live = false;
    };
  }, [p.scope, p.path, p.url]);
  if (report === undefined) return <div class="vw-empty dim">{t("loading")}</div>;
  const media = report?.format?.kind === "video" || report?.format?.kind === "audio";
  const wanted =
    report &&
    report.targets.length > 0 &&
    (report.needsConversion || (report.suggested && (media || report.format?.kind === "image")));
  if (!report || !wanted)
    return <FileViewer name={p.name} url={p.url} onKind={p.onKind} at={p.at} />;
  return <ConvertView {...p} report={report} media={media} refresh={setReport} />;
}

/** A loss in the person's language from its stable code; the converter's English otherwise. */
export function lossLabel(text: string, code?: LossCode): string {
  return (code?.code ? tOptional(`loss_${code.code}`, code.vars ?? {}) : undefined) ?? text;
}

/** What a copy loses (or will lose), translated; `hide` leaves out what the box already says. */
function LossList({
  title,
  losses,
  codes,
  hide = [],
}: {
  title: string;
  losses: string[];
  codes?: LossCode[] | undefined;
  hide?: string[];
}) {
  const items = losses
    .map((l, i) => ({ text: l, code: codes?.[i] }))
    .filter((x) => !(x.code?.code && hide.includes(x.code.code)));
  if (items.length === 0) return null;
  return (
    <div class="vw-open-losses">
      <span>{title}</span>
      <ul>
        {items.map((x) => (
          <li key={x.text}>{lossLabel(x.text, x.code)}</li>
        ))}
      </ul>
    </div>
  );
}

/** The server's size in English ("about 125-185 MB (downloaded once, …)"): only the figures. */
export const sizeOnly = (size: string) =>
  size
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/^about\s+/i, "")
    .trim();

const upper = (exts: string[]) => exts.map((e) => e.toUpperCase()).join(", ");

/**
 * A file no free program can read (INDD, Affinity, XD, a .fig copy): what is shown is only its
 * preview, the app it needs and what to export from it, and «Open in…» when the app is here.
 */
function NeedsPanel({ needs, scope, path }: { needs: FileNeeds; scope: string; path: string }) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string>();
  const [figmaToken, setFigmaToken] = useState<boolean>();
  useEffect(() => {
    if (needs.app !== "figma") return;
    void getApi()
      .vault()
      .then(
        (v) =>
          setFigmaToken(v.entries.some((e) => e.hosts.some((h) => /(^|\.)figma\.com$/i.test(h)))),
        () => setFigmaToken(false),
      );
  }, [needs.app]);
  const open = () => {
    setError(undefined);
    void getApi()
      .openWith(scope, path)
      .then(
        () => setOpened(true),
        (e: unknown) => setError((e as Error).message),
      );
  };
  const app = needs.app;
  const name = needs.name;
  return (
    <div class="vw-needs">
      <p>
        {app === "affinity"
          ? t("vwNeedsAffinity")
          : app === "indesign"
            ? t("vwNeedsIndesign")
            : app === "figma"
              ? t("vwNeedsFigma")
              : t("vwNeedsXd")}
      </p>
      {app !== "figma" && (
        <p class="vw-needs-export">
          <span class="dim">{t("vwNeedsExportLabel")}</span>{" "}
          <strong>
            {app === "indesign"
              ? t("vwNeedsExportIndd")
              : t("vwNeedsExportFormats", { formats: upper(needs.export) })}
          </strong>
        </p>
      )}
      {app === "figma" && figmaToken !== undefined && (
        <p class={figmaToken ? "dim" : "notice"}>
          {figmaToken ? t("vwNeedsFigmaReady") : t("vwNeedsFigmaToken")}
        </p>
      )}
      {opened && <p class="notice">{t("vwNeedsOpened", { app: name })}</p>}
      {error && <p class="notice error vw-open-error">{error}</p>}
      <div class="vw-row">
        {needs.installed && (app === "affinity" || app === "indesign") && (
          <button type="button" class="vw-btn primary" onClick={open}>
            <IconExternal size={16} />
            {t("vwNeedsOpenIn", { app: name })}
          </button>
        )}
        {!needs.installed && needs.url && app === "affinity" && (
          <a class="vw-btn primary" href={needs.url} target="_blank" rel="noreferrer">
            <IconExternal size={16} />
            {t("vwNeedsGetAffinity")}
          </a>
        )}
        {app === "figma" && figmaToken === false && (
          <button
            type="button"
            class="vw-btn primary"
            onClick={() =>
              openVaultDraft({ service: "Figma", name: "figma", hosts: ["api.figma.com"] })
            }
          >
            <IconKey size={16} />
            {t("vwNeedsFigmaAdd")}
          </button>
        )}
      </div>
    </div>
  );
}

type IdmlWay = "sla" | "odg";

/**
 * The original under the box when a viewer shows it as it is (an AI file is a PDF inside); never
 * the inside of a zip-based closed file (IDML, Sketch, .fig), which means nothing to the person.
 */
const originalShown = (kind: string | undefined) =>
  kind !== undefined && kind !== "unknown" && kind !== "archive";

/** A file through its open copy, with what the conversion did. */
function ConvertView({
  scope,
  path,
  name,
  url,
  onKind,
  report,
  media,
  refresh,
}: FileProps & { report: FileReport; media: boolean; refresh: (r: FileReport) => void }) {
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const job = useJob(jobId);
  const done = report.converted;
  const copy = done ? bestOutput(done.outputs) : undefined;
  const [copyUrl, setCopyUrl] = useState<string>();
  const [details, setDetails] = useState(false);
  // The original, when a viewer can show it as it is (an AI file is a PDF inside): under the box.
  const [original, setOriginal] = useState<string>();
  // IDML: Scribus (the layout, editable in a free layout program) or our own drawing (ODG).
  const idml = report.format?.id === "idml";
  const scribus = report.targets.find((x) => x.ext === "sla");
  const scribusCan = !!scribus?.program && (scribus.program.here || scribus.program.canDownload);
  const [way, setWay] = useState<IdmlWay>(scribusCan ? "sla" : "odg");
  useEffect(() => {
    setCopyUrl(undefined);
    if (!copy) return;
    void getApi()
      .canvasLink({ kind: "file", scope, path: copy.path })
      .then(
        (r) => setCopyUrl(r.url),
        (e: unknown) => setError((e as Error).message),
      );
  }, [copy?.path, done?.convertedAt]);
  useEffect(() => {
    if (!job || job.state === "running") return;
    setJobId(undefined);
    if (job.state === "done") {
      void getApi()
        .fileReport(scope, path)
        .then(refresh, (e: unknown) => setError((e as Error).message));
    } else setError(job.error?.message ?? t("uiFailedGeneric"));
  }, [job?.state]);
  const start = () => {
    setError(undefined);
    // A video or a sound: just the copy the browser plays (the first target, WebM or Opus).
    // An IDML: the way chosen in the box.
    const to = media ? [report.targets[0]?.ext ?? "webm"] : idml ? [way] : undefined;
    void getApi()
      .convertFile(scope, path, to)
      .then(
        (j) => setJobId(j.id),
        (e: unknown) => setError((e as Error).message),
      );
  };
  const target = idml
    ? (report.targets.find((x) => x.ext === way) ?? report.targets[0])
    : report.targets[0];
  const needsDownload = idml
    ? target?.program && !target.program.here
      ? target.program
      : undefined
    : report.targets.find((x) => x.program && !x.program.here)?.program;
  // Format names are names; the few with words in them are translated (`fmtName_<id>`).
  const formatName =
    (report.format && tOptional(`fmtName_${report.format.id}`)) ??
    report.format?.name ??
    baseName(path);
  const running = job?.state === "running" || (jobId !== undefined && !job);
  // Only the picture stored inside: said as such, never as a conversion.
  const needs = report.needs;
  const previewOnly =
    done?.previewOnly ?? (report.targets.length > 0 && report.targets.every((x) => x.preview));
  const hide = needs ? ["preview_only"] : [];

  // What is underneath: the copy, or (for media) the original with the button inside the player.
  let body: ComponentChildren = null;
  if (copy && copyUrl)
    body = (
      <CanvasFile
        key={copyUrl}
        scope={scope}
        path={copy.path}
        name={baseName(copy.path)}
        url={copyUrl}
      />
    );
  else if (copy) body = <div class="vw-empty dim">{t("loading")}</div>;
  else if (!media)
    body = (
      <div class="vw-open-original" hidden={!originalShown(original)}>
        <FileViewer name={name} url={url} onKind={(s) => setOriginal(s.kind)} />
      </div>
    );
  else if (!running)
    return (
      <div class="vw-open">
        {error && <p class="notice error vw-open-error">{error}</p>}
        <FileViewer name={name} url={url} onKind={onKind} convert={start} />
      </div>
    );

  const lost = done
    ? done.losses.filter((_, i) => !hide.includes(done.lossCodes?.[i]?.code ?? ""))
    : [];
  const title = previewOnly
    ? copy
      ? t("vwNeedsPreviewMade", { format: formatName })
      : t("vwNeedsTitle", { format: formatName })
    : copy
      ? t("vwOpenMade", { from: formatName, to: copy.ext.toUpperCase() })
      : media
        ? t("vwOpenMediaTitle", { format: formatName })
        : t("vwOpenClosed", { format: formatName });
  const lead = previewOnly
    ? t("vwNeedsWhy", { format: formatName })
    : copy
      ? t("vwOpenKept", { name: baseName(path) })
      : media
        ? t("vwOpenMediaText")
        : idml
          ? t("vwIdmlWhy")
          : t("vwOpenWhy", {
              to: report.targets
                .filter((x) => !x.asked)
                .map((x) => x.ext.toUpperCase())
                .join(", "),
            });

  const box = (
    <div class={`vw-open-box ${copy && !previewOnly ? "done" : "todo"}`} aria-live="polite">
      <div class="vw-open-line">
        <strong>{title}</strong>
        <div class="spacer" />
        {copy && lost.length > 0 && (
          <button type="button" class="vw-toggle" onClick={() => setDetails((d) => !d)}>
            {details ? t("vwOpenLessDetail") : t("vwOpenLost", { n: String(lost.length) })}
          </button>
        )}
      </div>
      <p class="dim">{lead}</p>
      {copy && done?.stale && <p class="notice">{t("vwOpenStale")}</p>}
      {needs && <NeedsPanel needs={needs} scope={scope} path={path} />}
      {idml && !copy && !running && (
        <div class="vw-idml">
          {scribusCan ? (
            <Choice<IdmlWay>
              options={[
                {
                  id: "sla",
                  title: t("vwIdmlSla"),
                  description: t("vwIdmlSlaText"),
                  badge: t("vwIdmlRecommended"),
                },
                { id: "odg", title: t("vwIdmlOdg"), description: t("vwIdmlOdgText") },
              ]}
              value={[way]}
              onChange={(v) => setWay(v[0] ?? "sla")}
            />
          ) : (
            <p class="dim">{t("vwIdmlOnlyOdg")}</p>
          )}
        </div>
      )}
      {copy && details && (
        <LossList
          title={t("vwOpenLostTitle")}
          losses={done?.losses ?? []}
          codes={done?.lossCodes}
          hide={hide}
        />
      )}
      {!copy && target && (
        <LossList
          title={
            previewOnly
              ? t("vwNeedsPreviewNote")
              : idml
                ? t("vwOpenKeepsChanges")
                : t("vwOpenWillLose")
          }
          losses={target.losses}
          codes={target.lossCodes}
          hide={hide}
        />
      )}
      {!copy && needsDownload && !running && (
        <p class="dim">
          {needsDownload.canDownload
            ? t("vwOpenFirstDownload", {
                name: needsDownload.name,
                size: sizeOnly(needsDownload.size),
              })
            : t("vwOpenNeedsProgram", { name: needsDownload.name })}
        </p>
      )}
      {running && <JobLine job={job} />}
      {error && <p class="notice error vw-open-error">{error}</p>}
      {!running && (!copy || done?.stale) && (
        <div class="vw-row">
          <button type="button" class={`vw-btn${needs ? "" : " primary"}`} onClick={start}>
            <IconRefresh size={16} />
            {copy
              ? t("vwOpenAgain")
              : media
                ? t("vwConvertToSee")
                : previewOnly
                  ? t("vwNeedsShowPreview")
                  : t("vwOpenConvert")}
          </button>
          {!copy && (
            <button type="button" class="vw-btn" onClick={() => download(url, name)}>
              <IconDownload size={16} />
              {t("vwDownload")}
            </button>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div class={`vw-open ${copy || originalShown(original) ? "with-copy" : "no-copy"}`}>
      {box}
      {body && <div class="vw-open-body">{body}</div>}
    </div>
  );
}
