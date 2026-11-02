// Where the code lives (G24.5): GitHub with a fine-grained token made by the user (a guide says
// which boxes to tick), and/or a Gitea server RedGiant starts on this computer. Every project
// then gets a private repository. Used by the advanced wizard and by Settings.
import type { Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Field, JobView, useJob } from "./ui.js";

const GITHUB_NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";

function Github({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const login = s.config.git?.github?.login;
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setupGithub(token.trim());
      setToken("");
      onChange();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  return (
    <div class="brain-panel">
      <h3>GitHub</h3>
      <p class="ui-help">{t("gitGithubHint")}</p>
      {login ? (
        <div class="row brain-linked">
          <span class="notice ok">
            <IconCheck size={14} /> {t("gitGithubLinked", { login })}
          </span>
          <button
            type="button"
            class="link"
            onClick={() => void getApi().removeGithub().then(onChange)}
          >
            {t("brainDisconnect")}
          </button>
        </div>
      ) : (
        <ol class="brain-steps">
          <li>
            {t("gitGithubStep1")}{" "}
            <a class="button" href={GITHUB_NEW_TOKEN} target="_blank" rel="noreferrer">
              {t("gitGithubOpen")}
            </a>
          </li>
          <li>
            {t("gitGithubStep2")}
            <ul class="git-perms">
              <li>{t("gitPermName")}</li>
              <li>{t("gitPermExpiry")}</li>
              <li>{t("gitPermRepos")}</li>
              <li>{t("gitPermList")}</li>
            </ul>
          </li>
          <li>
            <form class="tg-token" onSubmit={(e) => void save(e)}>
              <Field label={t("gitGithubStep3")} help={t("gitGithubTokenHelp")}>
                <input
                  type="password"
                  autocomplete="off"
                  placeholder="github_pat_…"
                  value={token}
                  onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                />
              </Field>
              <button type="submit" class="primary" disabled={busy || token.trim().length < 20}>
                {busy ? t("wzTrying") : t("brainKeyTry")}
              </button>
            </form>
          </li>
        </ol>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

function Gitea({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const job: Job | undefined = useJob(jobId);
  const running = s.config.git?.gitea;
  // Ready: the settings now hold Gitea; the job stays shown below.
  useEffect(() => {
    if (job?.state === "done") onChange();
  }, [job?.state]);
  const start = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      setJobId((await getApi().startGitea(user.trim(), password)).id);
    } catch (err) {
      setError(explain(err));
    }
  };
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,38}$/.test(user.trim()) && password.length >= 10;
  return (
    <div class="brain-panel">
      <h3>Gitea</h3>
      <p class="ui-help">{t("gitGiteaHint")}</p>
      {running ? (
        <div class="row brain-linked">
          <span class="notice ok">
            <IconCheck size={14} /> {t("gitGiteaReady", { user: running.user })}
          </span>
          <a class="button" href={running.publicUrl} target="_blank" rel="noreferrer">
            {t("gitGiteaOpen")}
          </a>
          <button
            type="button"
            class="link"
            onClick={() => void getApi().stopGitea().then(onChange)}
          >
            {t("gitGiteaStop")}
          </button>
        </div>
      ) : job?.state === "running" ? null : (
        <form class="form" onSubmit={(e) => void start(e)}>
          <Field label={t("gitGiteaUser")} help={t("gitGiteaUserHelp")}>
            <input
              autocomplete="username"
              value={user}
              onInput={(e) => setUser((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("gitGiteaPassword")} help={t("gitGiteaPasswordHelp")}>
            <input
              type="password"
              autocomplete="new-password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={t("gitGiteaAgain")}
            error={again && again !== password ? t("gitGiteaMismatch") : undefined}
          >
            <input
              type="password"
              autocomplete="new-password"
              value={again}
              onInput={(e) => setAgain((e.target as HTMLInputElement).value)}
            />
          </Field>
          <div class="wide">
            <button type="submit" class="primary" disabled={!valid || again !== password}>
              {t("gitGiteaCreate")}
            </button>
          </div>
        </form>
      )}
      {job && <JobView job={job} />}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

export function GitCode({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const [sync, setSync] = useState<{ project: string; ok: boolean; error?: string }[]>();
  const both = s.config.git?.github && s.config.git?.gitea;
  const any = s.config.git?.github || s.config.git?.gitea;
  return (
    <div class="brain">
      <Github s={s} onChange={onChange} />
      <Gitea s={s} onChange={onChange} />
      {both && <p class="notice ok">{t("gitBoth")}</p>}
      {any && (
        <div class="brain-panel">
          <h3>{t("gitProjects")}</h3>
          <p class="ui-help">{t("gitProjectsHint")}</p>
          <div>
            <button
              type="button"
              onClick={() =>
                void getApi()
                  .gitSync()
                  .then(setSync, () => {})
              }
            >
              {t("gitSync")}
            </button>
          </div>
          {sync && (
            <ul class="lm-files">
              {sync.length === 0 && <li class="ui-help">{t("gitNoProjects")}</li>}
              {sync.map((r) => (
                <li key={r.project}>
                  <span class={`notice ${r.ok ? "ok" : "error"}`}>
                    {r.project}: {r.ok ? t("gitSynced") : r.error}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
