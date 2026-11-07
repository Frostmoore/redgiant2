// Backup (2026-11-03): every project with its files, the agents and the conversations in one
// file, and that file imported here, into a new RedGiant or one already in use (what is there
// stays; God's and Demi-God's names are confirmed by the person). Every transfer has its bar.
// Drawn as the wizard (2026-11-06): a big heading, the two halves as the wizard's cards side by
// side (one under the other on phones), the names to keep as a choice in segments.
import type { BackupPreview, JobProgress } from "@redgiant/protocol";
import { useRef, useState } from "preact/hooks";
import { bytes } from "../format.js";
import { lang, t } from "../i18n.js";
import { IconDownload, IconUpload } from "../icons.js";
import { attempt, getApi, refresh } from "../state.js";
import { Acts, Head, SCard, Seg, SwitchRow, WzPage } from "./SettingsKit.js";
import { Field, JobView, Progress, useJob } from "./ui.js";

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
  // The keychain goes in only sealed with a passphrase of the person's (G33.4).
  const [withKeys, setWithKeys] = useState(false);
  const [pass, setPass] = useState("");
  const make = async () => {
    setSaved(false);
    const j = await attempt(() => getApi().exportBackup(withKeys ? pass : undefined));
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
    <SCard
      class="sb-backup"
      icon={<IconDownload size={22} />}
      title={t("backupExport")}
      q={t("backupExportHint")}
    >
      <div class="sb-backup-body">
        {job && <JobView job={job} cancellable countSteps={["conversations"]} />}
        {down.progress && <Progress progress={down.progress} />}
        {saved && <p class="notice ok">{t("backupSaved")}</p>}
        {job?.state !== "running" && (
          <div class="sb-keys">
            <SwitchRow
              title={t("backupKeys")}
              help={t("backupKeysHelp")}
              on={withKeys}
              onChange={setWithKeys}
            />
            {withKeys && (
              <Field label={t("kcPassphrase")} help={t("kcPassphraseHelp")}>
                <input
                  class="wz-field"
                  type="password"
                  autocomplete="new-password"
                  value={pass}
                  onInput={(e) => setPass((e.target as HTMLInputElement).value)}
                />
              </Field>
            )}
          </div>
        )}
        <div class="sb-backup-acts">
          {file && !down.progress && (
            <button type="button" class="wz-btn small primary" onClick={() => void save(file)}>
              <IconDownload size={18} /> {t("backupDownload", { file })}
            </button>
          )}
          {job?.state !== "running" && !down.progress && (
            <button
              type="button"
              class={`wz-btn small${file ? "" : " primary"}`}
              disabled={withKeys && pass.length < 8}
              onClick={() => void make()}
            >
              {!file && <IconDownload size={18} />}
              {file ? t("backupMakeAgain") : t("backupMake")}
            </button>
          )}
        </div>
      </div>
    </SCard>
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
  const [pass, setPass] = useState("");
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
        ...(pass && { keychainPassphrase: pass }),
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
    <SCard
      class="sb-backup"
      icon={<IconUpload size={22} />}
      title={t("backupImport")}
      q={t("backupImportHint")}
    >
      <div class="sb-backup-body">
        {!up.progress && !jobId && (
          <div class="sb-backup-acts">
            <button
              type="button"
              class={`wz-btn small${p ? "" : " primary"}`}
              onClick={() => picker.current?.click()}
            >
              <IconUpload size={18} /> {t("backupChoose")}
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
          </div>
        )}
        {up.progress && (
          <div class="sb-backup-send">
            <span class="dim">{t("backupSending")}</span>
            <Progress progress={up.progress} />
          </div>
        )}
        {p && !jobId && (
          <div class="sb-preview">
            <strong class="sb-preview-title">{t("backupFrom", { when: when(p.createdAt) })}</strong>
            <ul class="sb-projects">
              {p.projects.map((x) => (
                <li key={x.id} class={x.exists ? "here" : ""}>
                  <span>{x.name}</span>
                  {x.exists && <span class="dim">{t("backupAlreadyHere")}</span>}
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
                <div key={n.kind} class="sb-name">
                  <p>
                    {t("backupNameQuestion", {
                      who: n.kind === "god" ? "God" : "Demi-God",
                      here: n.here,
                      backup: n.backup,
                    })}
                  </p>
                  <Seg
                    options={[
                      [n.here, t("backupKeepName", { name: n.here })],
                      [n.backup, t("backupTakeName", { name: n.backup })],
                    ]}
                    value={names[n.kind]}
                    onChange={(v) => setNames((x) => ({ ...x, [n.kind]: v }))}
                  />
                </div>
              ) : null,
            )}
            {p.keychain && (
              <Field label={t("backupKeysIn")} help={t("backupKeysInHelp")}>
                <input
                  class="wz-field"
                  type="password"
                  value={pass}
                  onInput={(e) => setPass((e.target as HTMLInputElement).value)}
                />
              </Field>
            )}
            <p class="ui-help">{fresh.length ? t("backupAddsHint") : t("backupNothingNew")}</p>
            <Acts>
              <button type="button" class="wz-btn quiet" onClick={() => setFound(undefined)}>
                {t("cancel")}
              </button>
              <button type="button" class="wz-btn primary" onClick={() => void go()}>
                {t("backupImportNow")}
              </button>
            </Acts>
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
        {job?.state === "done" && job.vars.keychain && (
          <p class={`notice ${job.vars.keychain === "wrong" ? "error" : "ok"}`}>
            {job.vars.keychain === "wrong"
              ? t("backupKeysWrong")
              : t("kcImported", { n: job.vars.keychain })}
          </p>
        )}
        {job && job.state !== "running" && (
          <div class="sb-backup-acts">
            <button
              type="button"
              class="wz-btn small"
              onClick={() => {
                setJobId(undefined);
                setFound(undefined);
              }}
            >
              {t("backupAnother")}
            </button>
          </div>
        )}
      </div>
    </SCard>
  );
}

/** Settings, Backup: export and import side by side. */
export function Backup() {
  return (
    <WzPage class="sb-backups">
      <Head eyebrow={t("backup")} q={t("sbBackupQ")} lead={t("backupPurpose")} />
      <div class="wz-safe sb-two">
        <Export />
        <Import />
      </div>
    </WzPage>
  );
}
