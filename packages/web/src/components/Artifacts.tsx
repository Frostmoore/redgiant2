// Settings › Artifacts (3.5.9, study_artifacts.md §5.1, §5.4): every artifact of the person, in
// every place they see (God's folder, the assistants' desk, every project), with «Open» (the
// Canvas, the usual way), «Export» (a `.rgartifact`, or the bare HTML with its warning),
// «Delete» (our window, then the file explorer's own deletion: same trash, same permissions)
// and «Import» (a `.rgartifact` into the place the person picks). An archived project's
// artifacts are read only. The same import runs when a `.rgartifact` is dropped on the explorer.
import { ARTIFACT_DIR } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { ArtifactInfo } from "../api.js";
import { bytes } from "../format.js";
import { t } from "../i18n.js";
import {
  IconCode,
  IconDownload,
  IconExternal,
  IconFileZip,
  IconTrash,
  IconUpload,
} from "../icons.js";
import { getApi, openCanvas, projects } from "../state.js";
import { explain } from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import { Acts, Box, BoxButton, Head, Row, Sub, WzPage } from "./SettingsKit.js";
import { Modal } from "./ui.js";

/** A place's name as the page says it: God's folder and the desk in the person's language. */
export function placeName(scope: string, fallback: string): string {
  if (scope === "platform") return t("arPlacePlatform");
  if (scope === "assistants") return t("arPlaceAssistants");
  const id = scope.replace(/^project:/, "");
  return projects.value.find((p) => p.id === id)?.name ?? fallback;
}

/** The places an artifact may be imported into: every project in use, God's, the desk. */
export function importPlaces(): { scope: string; name: string }[] {
  return [
    ...projects.value
      .filter((p) => !p.archivedAt)
      .map((p) => ({ scope: `project:${p.id}`, name: p.name })),
    { scope: "platform", name: t("arPlacePlatform") },
    { scope: "assistants", name: t("arPlaceAssistants") },
  ];
}

/** A `.rgartifact` by its name. */
export const isRgArtifact = (name: string) => /\.rgartifact$/i.test(name);

/** Imports a `.rgartifact` into a place; the server checks it whole and runs nothing. */
export async function importArtifact(
  scope: string,
  file: Blob,
): Promise<{ path: string; name: string; dataIgnored: boolean }> {
  return getApi().artifactImport(scope, file);
}

const save = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

/** «Export»: the `.rgartifact` for another RedGiant, or the bare HTML with its warning. */
function ExportDialog({ a, onClose }: { a: ArtifactInfo; onClose: () => void }) {
  const [error, setError] = useState<string>();
  const go = async (as: "zip" | "html") => {
    try {
      const blob = await getApi().artifactExport(a.scope, a.path, as);
      save(blob, as === "zip" ? a.file.replace(/\.html?$/i, ".rgartifact") : a.file);
      onClose();
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <Modal
      title={t("arExportTitle", { name: a.name })}
      onClose={onClose}
      foot={
        <Acts>
          <button type="button" class="wz-btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in ar-export">
        <BoxButton title={t("arExportZip")} pill=".rgartifact" onClick={() => void go("zip")}>
          <span class="sb-box-p">{t("arExportZipText")}</span>
        </BoxButton>
        <BoxButton warn title={t("arExportHtml")} pill=".html" onClick={() => void go("html")}>
          <span class="sb-box-p">{t("arExportHtmlText")}</span>
        </BoxButton>
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

/** «Import»: the place the picked `.rgartifact` goes into. */
function ImportDialog({
  file,
  onClose,
}: {
  file: File;
  onClose: (done?: { name: string; place: string; dataIgnored: boolean }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const into = async (scope: string, place: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await importArtifact(scope, file);
      onClose({ name: r.name, place, dataIgnored: r.dataIgnored });
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("arWhereQ")}
      sub={file.name}
      onClose={() => onClose()}
      foot={
        <Acts>
          <button type="button" class="wz-btn" disabled={busy} onClick={() => onClose()}>
            {t("cancel")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in ar-where">
        <p class="wz-lead2">{t("arWhereLead")}</p>
        {importPlaces().map((p) => (
          <BoxButton
            key={p.scope}
            title={p.name}
            onClick={() => !busy && void into(p.scope, p.name)}
          >
            <span class="sb-box-p">
              <code>{`${ARTIFACT_DIR}/`}</code>
            </span>
          </BoxButton>
        ))}
        {error && (
          <p class="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** One artifact: its name and facts, then Open, Export, Delete. */
function ArtifactRow({
  a,
  onExport,
  onDeleted,
  onError,
}: {
  a: ArtifactInfo;
  onExport: () => void;
  onDeleted: () => void;
  onError: (e: string) => void;
}) {
  const facts = [
    a.file,
    a.version !== null ? t("arVersion", { n: String(a.version) }) : t("arNoHeader"),
    a.libs.length > 0 ? t("arLibs", { libs: a.libs.join(", ") }) : "",
    a.from ? t("arFrom", { who: a.from }) : "",
    bytes(a.size),
    day(a.modifiedAt),
  ].filter(Boolean);
  const remove = async () => {
    const yes = await askConfirm(t("arDeleteQ", { name: a.name }), {
      text: t("arDeleteText"),
      yes: t("arDelete"),
      danger: true,
    });
    if (!yes) return;
    try {
      await getApi().fileOp({ op: "delete", scope: a.scope, path: a.path });
      onDeleted();
    } catch (err) {
      onError(explain(err));
    }
  };
  return (
    <Row
      title={
        <span class="ar-title">
          <IconCode size={15} /> {a.name}
          {a.pendingRun && <span class="ar-pill">{t("arPending")}</span>}
        </span>
      }
      help={
        <>
          {facts.join(" · ")}
          {a.readOnly && <span class="ar-ro"> · {t("arReadOnly")}</span>}
        </>
      }
    >
      <span class="ar-acts">
        <button
          type="button"
          class="wz-btn small"
          onClick={() => openCanvas(a.file, { kind: "file", scope: a.scope, path: a.path })}
        >
          <IconExternal size={14} /> {t("arOpen")}
        </button>
        <button type="button" class="wz-btn small" onClick={onExport}>
          <IconDownload size={14} /> {t("arExport")}
        </button>
        {!a.readOnly && (
          <button type="button" class="wz-btn small st-danger" onClick={() => void remove()}>
            <IconTrash size={14} /> {t("arDelete")}
          </button>
        )}
      </span>
    </Row>
  );
}

/** Settings › Artifacts. */
export function Artifacts() {
  const [list, setList] = useState<ArtifactInfo[]>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [exporting, setExporting] = useState<ArtifactInfo>();
  const [picked, setPicked] = useState<File>();
  const load = () =>
    void getApi()
      .artifacts()
      .then(setList, (err) => {
        setError(explain(err));
        setList([]);
      });
  useEffect(load, []);
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rgartifact";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) setPicked(f);
    };
    input.click();
  };
  // Grouped by place, the places in the order of the newest artifact in each.
  const groups = new Map<string, ArtifactInfo[]>();
  for (const a of list ?? []) groups.set(a.scope, [...(groups.get(a.scope) ?? []), a]);
  return (
    <WzPage
      class="ar-page"
      after={
        <>
          {exporting && <ExportDialog a={exporting} onClose={() => setExporting(undefined)} />}
          {picked && (
            <ImportDialog
              file={picked}
              onClose={(done) => {
                setPicked(undefined);
                if (!done) return;
                setNote(
                  `${t("arImported", { name: done.name, place: done.place })}${done.dataIgnored ? ` ${t("arDataIgnored")}` : ""}`,
                );
                load();
              }}
            />
          )}
        </>
      }
    >
      <Head q={t("arSection")} lead={t("arLead")} />
      <div class="ar-top">
        <button type="button" class="wz-btn primary" onClick={pick}>
          <IconUpload size={16} /> {t("arImport")}
        </button>
      </div>
      {note && (
        <p class="notice" role="status">
          {note}
        </p>
      )}
      {error && <p class="notice error">{error}</p>}
      {!list && <p class="dim">{t("loading")}</p>}
      {list?.length === 0 && (
        <Box class="ar-empty">
          <span class="ar-empty-ico">
            <IconFileZip size={28} />
          </span>
          <b>{t("arEmptyTitle")}</b>
          <p>{t("arEmpty1")}</p>
          <p>{t("arEmpty2")}</p>
        </Box>
      )}
      {[...groups].map(([scope, items]) => (
        <div key={scope} class="ar-group">
          <Sub title={placeName(scope, items[0]?.place ?? scope)} />
          <Box>
            {items.map((a) => (
              <ArtifactRow
                key={`${a.scope}:${a.path}`}
                a={a}
                onExport={() => setExporting(a)}
                onDeleted={load}
                onError={setError}
              />
            ))}
          </Box>
        </div>
      ))}
    </WzPage>
  );
}
