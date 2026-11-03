// Backup (2026-11-03): every project with its files, the agents and the conversations in one
// file, and that file imported here, into a new RedGiant or one already in use (what is there
// stays; God's and Demi-God's names are confirmed by the person). Every transfer has its bar.
import type { BackupPreview, JobProgress } from "@redgiant/protocol";
import { useRef, useState } from "preact/hooks";
import { bytes } from "../format.js";
import { lang, t } from "../i18n.js";
import { IconDownload, IconUpload } from "../icons.js";
import { attempt, getApi, refresh } from "../state.js";
import { JobView, Progress, useJob } from "./ui.js";

/** A transfer the page does itself, with the rate of the last seconds and the time left. */
function useTransfer() {
  const [p, setP] = useState<JobProgress | null>(null);
  const samples = useRef<[number, number][]>([]);
  const start = () => {
    samples.current = [];
    setP({ done: 0, total: null, rate: null, secondsLeft: null });
  };
  const update = (done: number, total: number) => {
    const now = Date.now();
    const s = samples.current;
    s.push([now, done]);
    while (s.length > 1 && now - (s[0] as [number, number])[0] > 8000) s.shift();
    const [t0, d0] = s[0] as [number, number];
    const rate = now - t0 >= 1500 ? ((done - d0) * 1000) / (now - t0) : null;
    setP({
      done,
      total: total || null,
      rate,
      secondsLeft: rate && total ? Math.max(0, (total - done) / rate) : null,
    });
  };
  return { progress: p, start, update, stop: () => setP(null) };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function Export() {
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const down = useTransfer();
  const [saved, setSaved] = useState(false);
  const make = async () => {
    setSaved(false);
    const j = await attempt(() => getApi().exportBackup());
    if (j) setJobId(j.id);
  };
  const save = async (name: string) => {
    down.start();
    const blob = await attempt(() => getApi().downloadBackup(name, down.update));
    down.stop();
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    setSaved(true);
  };
  const file = job?.state === "done" ? job.vars.file : undefined;
  return (
    <section class="backup-part">
      <h3>{t("backupExport")}</h3>
      <p class="ui-purpose">{t("backupExportHint")}</p>
      {job?.state !== "running" && !down.progress && (
        <button type="button" class="primary row" onClick={() => void make()}>
          <IconDownload size={14} /> {file ? t("backupMakeAgain") : t("backupMake")}
        </button>
      )}
      {job && <JobView job={job} cancellable countSteps={["conversations"]} />}
      {file && !down.progress && (
        <button type="button" class="primary row" onClick={() => void save(file)}>
          <IconDownload size={14} /> {t("backupDownload", { file })}
        </button>
      )}
      {down.progress && <Progress progress={down.progress} />}
      {saved && <p class="notice ok">{t("backupSaved")}</p>}
    </section>
  );
}

function Import() {
  const up = useTransfer();
  const picker = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<{ id: string; preview: BackupPreview }>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const [refreshed, setRefreshed] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFound(undefined);
    setJobId(undefined);
    setRefreshed(false);
    up.start();
    const r = await attempt(() => getApi().uploadBackup(file, up.update));
    up.stop();
    if (!r) return;
    setFound(r);
    // This installation's names stay unless the person says otherwise.
    setNames(Object.fromEntries(r.preview.names.map((n) => [n.kind, n.here ?? n.backup])));
  };
  const go = async () => {
    if (!found) return;
    const j = await attempt(() =>
      getApi().importBackup({
        id: found.id,
        ...(names.god && { godName: names.god }),
        ...(names.demigod && { demigodName: names.demigod }),
      }),
    );
    if (j) setJobId(j.id);
  };
  if (job && job.state !== "running" && !refreshed) {
    setRefreshed(true);
    void refresh();
  }
  const p = found?.preview;
  const fresh = p?.projects.filter((x) => !x.exists) ?? [];
  return (
    <section class="backup-part">
      <h3>{t("backupImport")}</h3>
      <p class="ui-purpose">{t("backupImportHint")}</p>
      {!up.progress && !jobId && (
        <>
          <button type="button" class="primary row" onClick={() => picker.current?.click()}>
            <IconUpload size={14} /> {t("backupChoose")}
          </button>
          <input
            ref={picker}
            type="file"
            accept=".rgbackup"
            hidden
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              void pick(input.files?.[0]);
              input.value = "";
            }}
          />
        </>
      )}
      {up.progress && (
        <div>
          <span class="dim">{t("backupSending")}</span>
          <Progress progress={up.progress} />
        </div>
      )}
      {p && !jobId && (
        <div class="backup-card">
          <strong>{t("backupFrom", { when: when(p.createdAt) })}</strong>
          <ul>
            {p.projects.map((x) => (
              <li key={x.id}>
                {x.name}
                {x.exists && <span class="dim"> · {t("backupAlreadyHere")}</span>}
              </li>
            ))}
          </ul>
          <p class="dim">
            {t("backupCounts", {
              agents: String(p.agents),
              conversations: String(p.conversations + p.chats),
              size: bytes(p.filesBytes),
            })}
          </p>
          {p.names.map((n) =>
            n.here && n.here !== n.backup ? (
              <fieldset key={n.kind} class="backup-name">
                <legend>
                  {t("backupNameQuestion", {
                    who: n.kind === "god" ? "God" : "Demi-God",
                    here: n.here,
                    backup: n.backup,
                  })}
                </legend>
                {[n.here, n.backup].map((v, i) => (
                  <label key={v} class="row">
                    <input
                      type="radio"
                      name={`name-${n.kind}`}
                      checked={names[n.kind] === v}
                      onChange={() => setNames((x) => ({ ...x, [n.kind]: v }))}
                    />
                    {i === 0 ? t("backupKeepName", { name: v }) : t("backupTakeName", { name: v })}
                  </label>
                ))}
              </fieldset>
            ) : null,
          )}
          <p class="ui-help">{fresh.length ? t("backupAddsHint") : t("backupNothingNew")}</p>
          <div class="row">
            <button type="button" class="primary" onClick={() => void go()}>
              {t("backupImportNow")}
            </button>
            <button type="button" onClick={() => setFound(undefined)}>
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      {job && <JobView job={job} countSteps={["conversations"]} />}
      {job?.state === "done" && (
        <p class="notice ok">
          {t("backupImported", {
            projects: job.vars.projects ?? "0",
            agents: job.vars.agents ?? "0",
            conversations: job.vars.conversations ?? "0",
          })}
        </p>
      )}
      {job && job.state !== "running" && (
        <button
          type="button"
          class="link"
          onClick={() => {
            setJobId(undefined);
            setFound(undefined);
          }}
        >
          {t("backupAnother")}
        </button>
      )}
    </section>
  );
}

/** Settings, Backup: export and import side by side. */
export function Backup() {
  return (
    <div class="settings-section">
      <h2>{t("backup")}</h2>
      <p class="ui-purpose">{t("backupPurpose")}</p>
      <Export />
      <Import />
    </div>
  );
}
