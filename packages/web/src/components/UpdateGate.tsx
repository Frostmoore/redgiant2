// Mandatory and breaking updates (G36.19). The server looks for updates at start and every few
// hours and says what the latest release means here (signed metadata only). Mandatory: a window
// that does not close, «Update now» or «Close RedGiant»; until then agents and automations wait
// (nothing is lost). Breaking: a window that explains in plain words, makes a full backup by
// itself into a folder the person can see, reads it back, shows where it is, then walks through
// uninstalling, installing the new version and restoring (the new wizard finds the backup).
import { signal } from "@preact/signals";
import type { FoundBackup, UpdateStatus } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { bytes } from "../format.js";
import { lang, t } from "../i18n.js";
import {
  IconAlert,
  IconCopy,
  IconDownload,
  IconExternal,
  IconLock,
  IconRefresh,
  IconUpload,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { Field, JobView, Modal, useJob } from "./ui.js";

/** The last look, for every part of the page. */
export const updateStatus = signal<UpdateStatus | null>(null);

/** Looks again now (Settings › Look for updates, or the window's «Try again»). */
export async function lookForUpdates(): Promise<UpdateStatus | undefined> {
  const s = await attempt(() => getApi().updateLook());
  if (s) updateStatus.value = s;
  return s;
}

/** What the server already knows (it looked a moment ago, from Settings). */
export async function refreshUpdateStatus(): Promise<void> {
  const s = await getApi()
    .updateStatus()
    .catch(() => undefined);
  if (s) updateStatus.value = s;
}

const LATER = "rg.breakingLater";
/** «Later» for a breaking update lasts until the next day, then the window comes back. */
const later = (version: string | null) => {
  try {
    const v = JSON.parse(localStorage.getItem(LATER) ?? "null") as {
      v: string;
      until: number;
    } | null;
    return !!v && v.v === version && Date.now() < v.until;
  } catch {
    return false;
  }
};

export function UpdateGate() {
  const s = updateStatus.value;
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const load = () =>
      void getApi()
        .updateStatus()
        .then(
          (x) => (updateStatus.value = x),
          () => {},
        );
    load();
    // The server looks at GitHub every few hours; the page asks it often (cheap, local).
    const timer = setInterval(load, 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!s) return null;
  if (s.gate === "mandatory") return <Mandatory s={s} />;
  if (s.gate === "breaking" && !hidden && !later(s.latest))
    return (
      <Breaking
        s={s}
        onLater={() => {
          localStorage.setItem(
            LATER,
            JSON.stringify({ v: s.latest, until: Date.now() + 86_400_000 }),
          );
          setHidden(true);
        }}
      />
    );
  return null;
}

const noteOf = (s: UpdateStatus) => (s.note ? (lang.value === "it" ? s.note.it : s.note.en) : null);

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="upd-cmd">
      <code>{text}</code>
      <button
        type="button"
        class="wz-btn small"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        <IconCopy size={16} /> {copied ? t("updCopied") : t("updCopy")}
      </button>
    </div>
  );
}

/** A mandatory update: no way around it but updating or closing RedGiant. */
function Mandatory({ s }: { s: UpdateStatus }) {
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (action: "update" | "quit") => {
    setBusy(true);
    const r = await attempt(() => getApi().updateAct(action));
    setBusy(false);
    if (r) setSaid(t(action === "update" ? "updReqUpdating" : "updReqClosing"));
  };
  const note = noteOf(s);
  const v = { version: s.latest ?? "", installed: s.installed ?? "" };
  return (
    <Modal
      title={t("updReqTitle")}
      icon={<IconLock size={20} />}
      sub={t("updReqSub", v)}
      onClose={() => {}}
      locked
      class="upd-modal wz-look"
      foot={
        s.install === "windows" && s.canUpdateHere ? (
          <>
            <button type="button" class="wz-btn" disabled={busy} onClick={() => void act("quit")}>
              {t("updReqClose")}
            </button>
            <button
              type="button"
              class="wz-btn primary"
              disabled={busy}
              onClick={() => void act("update")}
            >
              <IconDownload size={18} /> {t("updReqNow")}
            </button>
          </>
        ) : s.install === "mac" ? (
          <>
            <button type="button" class="wz-btn" disabled={busy} onClick={() => void act("quit")}>
              {t("updReqClose")}
            </button>
            {s.downloadUrl && (
              <a class="wz-btn primary" href={s.downloadUrl} target="_blank" rel="noreferrer">
                <IconDownload size={18} /> {t("updDownloadNew")}
              </a>
            )}
          </>
        ) : (
          <button type="button" class="wz-btn primary" onClick={() => void lookForUpdates()}>
            <IconRefresh size={18} /> {t("updReqAgain")}
          </button>
        )
      }
    >
      <div class="upd-body">
        <p class="upd-lead">{t("updReqLead", v)}</p>
        {note && <p class="upd-note">{note}</p>}
        <p class="upd-safe">{t("updReqSafe")}</p>
        {s.install === "mac" && <p>{t("updReqMac")}</p>}
        {s.install === "docker" && s.command && (
          <>
            <p>{t("updReqDocker")}</p>
            <Command text={s.command} />
          </>
        )}
        {s.install === "source" && <p>{t("updReqSource")}</p>}
        {s.install === "windows" && s.downloadUrl && (
          <p class="upd-alt">
            {t("updReqInstaller")}{" "}
            <a href={s.downloadUrl} target="_blank" rel="noreferrer">
              {t("updReqInstallerLink")} <IconExternal size={14} />
            </a>
          </p>
        )}
        {said && <p class="notice ok">{said}</p>}
      </div>
    </Modal>
  );
}

type Step = "backup" | "guide";

/** A breaking update: a clean install, guided, with the backup made first and checked. */
function Breaking({ s, onLater }: { s: UpdateStatus; onLater: () => void }) {
  const [step, setStep] = useState<Step>("backup");
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const [keys, setKeys] = useState(0);
  const [pass, setPass] = useState("");
  const [asked, setAsked] = useState(false);
  const [said, setSaid] = useState<string>();
  const [sure, setSure] = useState(false);
  const start = async (passphrase?: string) => {
    const j = await attempt(() => getApi().safetyBackup(passphrase));
    if (j) setJobId(j.id);
  };
  useEffect(() => {
    // The backup starts by itself: nobody has to remember it.
    void start();
    void attempt(() => getApi().vault()).then((v) => v && setKeys(v.entries.length));
  }, []);
  const done = job?.state === "done";
  const withKeys = job?.vars.keychain === "true";
  const note = noteOf(s);
  const v = { version: s.latest ?? "", installed: s.installed ?? "" };
  const uninstall = async () => {
    const r = await attempt(() => getApi().updateAct("uninstall"));
    if (r) setSaid(t("updBrkUninstalling"));
  };
  return (
    <Modal
      title={t("updBrkTitle")}
      icon={<IconAlert size={20} />}
      sub={t("updBrkSub", v)}
      onClose={onLater}
      wide
      class="upd-modal wz-look"
      foot={
        step === "backup" ? (
          <>
            <button type="button" class="wz-btn" onClick={onLater}>
              {t("updLater")}
            </button>
            <button
              type="button"
              class="wz-btn primary"
              disabled={!done}
              onClick={() => setStep("guide")}
            >
              {t("updBrkNext")}
            </button>
          </>
        ) : (
          <>
            <button type="button" class="wz-btn" onClick={() => setStep("backup")}>
              {t("wzBack")}
            </button>
            <button type="button" class="wz-btn primary" onClick={onLater}>
              {t("updBrkDone")}
            </button>
          </>
        )
      }
    >
      <div class="upd-body">
        {step === "backup" ? (
          <>
            <p class="upd-lead">{t("updBrkLead", v)}</p>
            {note && <p class="upd-note">{note}</p>}
            <p>{t("updBrkWhy")}</p>
            {/* The steps while it works; once read back, only where it is. */}
            {job && !done && <JobView job={job} countSteps={["conversations"]} />}
            {job?.state === "failed" && (
              <button type="button" class="wz-btn small" onClick={() => void start()}>
                <IconRefresh size={16} /> {t("updBrkRetry")}
              </button>
            )}
            {done && (
              <div class="upd-where">
                <p class="upd-where-title">{t("updBrkSaved")}</p>
                <code class="upd-path">{job.vars.folder}</code>
                <p class="upd-where-sub">
                  {t("updBrkChecked", {
                    file: job.vars.file ?? "",
                    size: bytes(Number(job.vars.bytes ?? 0)),
                    projects: job.vars.projects ?? "0",
                    conversations: job.vars.conversations ?? "0",
                  })}
                </p>
                {s.install === "docker" && (
                  <>
                    <p>{t("updBrkDockerCopy")}</p>
                    <Command text={`docker compose cp redgiant:${job.vars.path ?? ""} .`} />
                  </>
                )}
              </div>
            )}
            {done && keys > 0 && !withKeys && (
              <div class="upd-keys">
                <p>{t("updBrkKeys", { n: String(keys) })}</p>
                {asked ? (
                  <>
                    <Field label={t("kcPassphrase")} help={t("kcPassphraseHelp")}>
                      <input
                        class="wz-field"
                        type="password"
                        autocomplete="new-password"
                        value={pass}
                        onInput={(e) => setPass((e.target as HTMLInputElement).value)}
                      />
                    </Field>
                    <button
                      type="button"
                      class="wz-btn small primary"
                      disabled={pass.length < 8}
                      onClick={() => void start(pass)}
                    >
                      {t("updBrkKeysAgain")}
                    </button>
                  </>
                ) : (
                  <button type="button" class="wz-btn small" onClick={() => setAsked(true)}>
                    <IconLock size={16} /> {t("updBrkKeysAdd")}
                  </button>
                )}
              </div>
            )}
            {done && withKeys && <p class="notice ok">{t("updBrkKeysIn")}</p>}
          </>
        ) : (
          <ol class="upd-steps">
            <li>
              <strong>{t("updBrkStep1")}</strong>
              <p>
                {t(
                  s.install === "windows"
                    ? "updBrkStep1Win"
                    : s.install === "mac"
                      ? "updBrkStep1Mac"
                      : s.install === "docker"
                        ? "updBrkStep1Docker"
                        : "updBrkStep1Source",
                )}
              </p>
              {s.install === "docker" && <Command text="docker compose down -v" />}
              {s.canUninstall &&
                (sure ? (
                  <div class="upd-sure">
                    <p>{t("updBrkSure", { folder: job?.vars.folder ?? "" })}</p>
                    <button type="button" class="wz-btn small" onClick={() => setSure(false)}>
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      class="wz-btn small primary"
                      onClick={() => void uninstall()}
                    >
                      {t("updBrkUninstallYes")}
                    </button>
                  </div>
                ) : (
                  <button type="button" class="wz-btn small" onClick={() => setSure(true)}>
                    {t("updBrkUninstall")}
                  </button>
                ))}
              {said && <p class="notice ok">{said}</p>}
            </li>
            <li>
              <strong>{t("updBrkStep2", v)}</strong>
              {s.downloadUrl ? (
                <p>
                  <a
                    class="wz-btn small primary"
                    href={s.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <IconDownload size={16} /> {t("updDownloadNew")}
                  </a>
                </p>
              ) : (
                s.command && <Command text={s.command} />
              )}
            </li>
            <li>
              <strong>{t("updBrkStep3")}</strong>
              <p>{t(s.install === "docker" ? "updBrkStep3Docker" : "updBrkStep3Text")}</p>
            </li>
          </ol>
        )}
      </div>
    </Modal>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The wizard's first step (G36.19): a backup a breaking update left in Documents (or the data
 * volume) is found by itself and offered, newest first; one button puts everything back.
 */
export function FoundBackups({ onRestored }: { onRestored?: () => void }) {
  const [found, setFound] = useState<FoundBackup[]>([]);
  const [pick, setPick] = useState(0);
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const [pass, setPass] = useState("");
  useEffect(() => {
    void attempt(() => getApi().foundBackups()).then((x) => x && setFound(x));
  }, []);
  useEffect(() => {
    if (job?.state === "done") onRestored?.();
  }, [job?.state]);
  const b = found[pick];
  if (!b) return null;
  const restore = async () => {
    const j = await attempt(() => getApi().restoreFound(b.id, b.keychain ? pass : undefined));
    if (j) setJobId(j.id);
  };
  return (
    <div class="upd-found">
      <div class="upd-found-head">
        <IconUpload size={22} />
        <div>
          <h2 class="wz-sub">{t("updFoundTitle")}</h2>
          <p class="wz-subl">
            {t("updFoundLead", {
              date: shortDate(b.createdAt),
              version: b.version ?? "?",
              projects: String(b.projects),
              conversations: String(b.conversations),
            })}
          </p>
        </div>
      </div>
      <code class="upd-path">{b.path}</code>
      {found.length > 1 && !job && (
        <div class="upd-found-list">
          {found.map((x, i) => (
            <button
              type="button"
              key={x.id}
              class={`wz-btn small${i === pick ? " primary" : ""}`}
              onClick={() => setPick(i)}
            >
              {shortDate(x.createdAt)}
            </button>
          ))}
        </div>
      )}
      {job && <JobView job={job} countSteps={["conversations"]} />}
      {job?.state === "done" && job.vars.keychain === "wrong" && (
        <p class="notice error">{t("backupKeysWrong")}</p>
      )}
      {(!job || job.state === "failed") && (
        <>
          {b.keychain && (
            <Field label={t("kcPassphrase")} help={t("updFoundKeys")}>
              <input
                class="wz-field"
                type="password"
                autocomplete="current-password"
                value={pass}
                onInput={(e) => setPass((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          <button type="button" class="wz-btn primary" onClick={() => void restore()}>
            <IconUpload size={18} /> {t("updFoundRestore")}
          </button>
        </>
      )}
      {job?.state === "done" && <p class="notice ok">{t("updFoundDone")}</p>}
    </div>
  );
}
