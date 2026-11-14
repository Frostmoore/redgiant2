// Where the code lives (G24.5): GitHub with a fine-grained token made by the user (a guide says
// which boxes to tick), and/or a Gitea server RedGiant starts on this computer. Every project
// then gets a private repository. Used by the advanced wizard and by Settings: both show the
// two squares (`GitTiles`); Settings adds the projects' repositories (`GitSync`). Gitea is either
// started here or one the person already has (p3.7.2: its address, user and token).
import type { Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCloud, IconServer } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { HomeServicesLink } from "./OwnInfra.js";
import { Acts, Seg, Tile } from "./SettingsKit.js";
import { Field, JobView, Modal, useJob } from "./ui.js";

/** The name in what the person typed as Gitea's address (with or without https://). */
const hostOf = (text: string) => {
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`,
    ).hostname;
  } catch {
    return text.trim();
  }
};

const GITHUB_NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";

export function Github({ s, onChange }: { s: SetupState; onChange: () => void }) {
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
          <span class="notice ok">{t("gitGithubLinked", { login })}</span>
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

export function Gitea({ s, onChange }: { s: SetupState; onChange: () => void }) {
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
  const [kind, setKind] = useState<"own" | "existing">("own");
  return (
    <div class="brain-panel">
      <h3>Gitea</h3>
      <p class="ui-help">{t("gitGiteaHint")}</p>
      {running?.external ? (
        <div class="row brain-linked">
          <span class="notice ok">
            {t("gitGiteaLinked", { url: running.publicUrl, user: running.user })}
          </span>
          <a class="button" href={running.publicUrl} target="_blank" rel="noreferrer">
            {t("gitGiteaOpen")}
          </a>
          <button
            type="button"
            class="link"
            onClick={() => void getApi().stopGitea().then(onChange)}
          >
            {t("brainDisconnect")}
          </button>
        </div>
      ) : running ? (
        <div class="row brain-linked">
          <span class="notice ok">{t("gitGiteaReady", { user: running.user })}</span>
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
        <>
          <Seg
            label={t("gitGiteaKind")}
            value={kind}
            options={[
              ["own", t("gitGiteaKindOwn")],
              ["existing", t("gitGiteaKindExisting")],
            ]}
            onChange={setKind}
          />
          {kind === "existing" ? (
            <ExistingGitea onChange={onChange} />
          ) : (
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
        </>
      )}
      {job && <JobView job={job} />}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** A Gitea the person already has: address, user, token; checked by the server, then kept. */
function ExistingGitea({ onChange }: { onChange: () => void }) {
  const [url, setUrl] = useState("");
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The name unknown to RedGiant's DNS, or its address out of reach (p3.7.3): words and the guide.
  const [home, setHome] = useState<"name" | "address">();
  const connect = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setHome(undefined);
    try {
      await getApi().connectGitea(url.trim(), user.trim(), token.trim());
      setToken("");
      onChange();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const host = hostOf(url);
      if (code === "name_not_found" || code === "host_unreachable") {
        setHome(code === "name_not_found" ? "name" : "address");
        setError(
          t(code === "name_not_found" ? "gitGiteaNameNotFound" : "gitGiteaHostUnreachable", {
            host,
          }),
        );
      } else setError(explain(err));
    }
    setBusy(false);
  };
  const valid =
    url.trim().length >= 3 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/.test(user.trim()) &&
    token.trim().length >= 8;
  return (
    <form class="form" onSubmit={(e) => void connect(e)}>
      <Field label={t("gitGiteaUrl")} help={t("gitGiteaUrlHelp")}>
        <input
          type="url"
          autocomplete="url"
          placeholder="https://git.example.org"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("gitGiteaExtUser")}>
        <input
          autocomplete="username"
          value={user}
          onInput={(e) => setUser((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("gitGiteaToken")} help={t("gitGiteaTokenHelp")}>
        <input
          type="password"
          autocomplete="off"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
      </Field>
      <div class="wide">
        <button type="submit" class="primary" disabled={busy || !valid}>
          {busy ? t("wzTrying") : t("gitGiteaConnect")}
        </button>
      </div>
      {error && <p class="notice error wide">{error}</p>}
      {home && (
        <div class="wide">
          <HomeServicesLink />
        </div>
      )}
    </form>
  );
}

/**
 * GitHub and Gitea as the wizard's two squares (2026-11-06), lit when linked, each opening its
 * window: shared by the advanced wizard's step and by Settings.
 */
export function GitTiles({ s, reload }: { s: SetupState; reload: () => void }) {
  const [open, setOpen] = useState<"github" | "gitea" | null>(null);
  const github = !!s.config.git?.github;
  const gitea = !!s.config.git?.gitea;
  const close = () => {
    setOpen(null);
    reload();
  };
  return (
    <>
      <div class="wz-two">
        <Tile
          wide
          on={github}
          icon={<IconCloud />}
          title="GitHub"
          text={t("wzCodeGithub")}
          state={github ? t("wzStateLinked") : undefined}
          onClick={() => setOpen("github")}
        />
        <Tile
          wide
          on={gitea}
          icon={<IconServer />}
          title={t("wzCodeGiteaTitle")}
          text={t("wzCodeGitea")}
          state={gitea ? t("wzStateLinked") : undefined}
          onClick={() => setOpen("gitea")}
        />
      </div>
      {github && gitea && <p class="wz-more dim">{t("gitBoth")}</p>}
      {open && (
        <Modal title={open === "github" ? "GitHub" : t("wzCodeGiteaTitle")} onClose={close}>
          <div class="wz-panel-in">
            {open === "github" ? (
              <Github s={s} onChange={reload} />
            ) : (
              <Gitea s={s} onChange={reload} />
            )}
          </div>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={close}>
              {t("wzDoneBtn")}
            </button>
          </Acts>
        </Modal>
      )}
    </>
  );
}

/** Every project's private repository, made again where it is missing (Settings). */
export function GitSync() {
  const [sync, setSync] = useState<{ project: string; ok: boolean; error?: string }[]>();
  const [busy, setBusy] = useState(false);
  return (
    <div class="git-sync">
      <button
        type="button"
        class="wz-btn primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void getApi()
            .gitSync()
            .then(setSync, () => {})
            .finally(() => setBusy(false));
        }}
      >
        {t("gitSync")}
      </button>
      {sync && (
        <ul class="git-sync-list">
          {sync.length === 0 && <li class="ui-help">{t("gitNoProjects")}</li>}
          {sync.map((r) => (
            <li key={r.project} class={r.ok ? "ok" : "error"}>
              <b>{r.project}</b>
              <span>{r.ok ? t("gitSynced") : r.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
