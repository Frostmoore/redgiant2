// «Modifica (copia ODS)» for a closed sheet (G37.3): an XLSX, XLS or Numbers file is never edited
// itself (the rule of open formats); its ODS copy beside it (`<file>.open/`, made by LibreOffice
// the first time) opens in the sheet editor. A copy already made is opened as it is: making it
// again would throw away what was edited in it.
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconSpinner } from "../../icons.js";
import { attempt, getApi, openCanvas } from "../../state.js";
import { useJob } from "../ui.js";

export function EditCopyButton({
  scope,
  path,
  name,
}: {
  scope: string;
  path: string;
  name: string;
}) {
  const [job, setJob] = useState<string>();
  const j = useJob(job);
  const open = (copy: string) =>
    openCanvas(copy.split(/[\\/]/).pop() ?? copy, { kind: "file", scope, path: copy });
  const odsOf = async () =>
    (await getApi().fileReport(scope, path)).converted?.outputs.find((o) => o.ext === "ods")?.path;
  useEffect(() => {
    if (!j || j.state === "running") return;
    setJob(undefined);
    if (j.state === "done")
      void attempt(async () => {
        const copy = await odsOf();
        if (copy) open(copy);
      });
  }, [j?.state]);
  if (scope === "outside" || /\.(ods|fods|ots)$/i.test(name)) return null;
  return (
    <button
      type="button"
      class="vw-btn small"
      title={t("sheetEditCopyHint")}
      disabled={!!job}
      onClick={() =>
        void attempt(async () => {
          const copy = await odsOf();
          if (copy) return void open(copy);
          const started = await getApi().convertFile(scope, path, ["ods"]);
          setJob(started.id);
        })
      }
    >
      {job ? <IconSpinner size={14} /> : null}
      {job ? t("sheetEditCopyMaking") : t("sheetEditCopy")}
    </button>
  );
}
