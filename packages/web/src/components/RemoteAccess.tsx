// Reaching RedGiant from outside home (G24.6): first a password (and, better, a second check
// with an authenticator app), then one of three ways out, each with its guide. Used by the
// advanced wizard and by Settings.
import { useEffect, useState } from "preact/hooks";
import { loginMethods, type SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced, Choice, Field, JobView, Qr, useJob } from "./ui.js";

/** The password that signs in from anywhere, and the authenticator app's code. */
function PasswordPanel({ onChange }: { onChange: () => void }) {
  const [methods, setMethods] = useState<{ password: boolean; code: boolean }>();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [changing, setChanging] = useState(false);
  const load = () => void loginMethods().then(setMethods, () => {});
  useEffect(load, []);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setMsg(undefined);
    try {
      await f();
      setMsg({ ok: true, text: ok });
      load();
      onChange();
    } catch (err) {
      setMsg({ ok: false, text: explain(err) });
    }
  };
  if (!methods) return null;
  return (
    <div class="brain-panel">
      <h3>{t("remotePassword")}</h3>
      <p class="ui-help">{t("remotePasswordHint")}</p>
      {methods.password && !changing ? (
        <div class="row brain-linked">
          <span class="notice ok">
            <IconCheck size={14} /> {t("remotePasswordSet")}
          </span>
          <button type="button" class="link" onClick={() => setChanging(true)}>
            {t("remotePasswordChange")}
          </button>
        </div>
      ) : (
        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => getApi().setPassword(pw), t("remotePasswordSaved")).then(() => {
              setPw("");
              setAgain("");
              setChanging(false);
            });
          }}
        >
          <Field label={t("remoteNewPassword")} help={t("remotePasswordRule")}>
            <input
              type="password"
              autocomplete="new-password"
              value={pw}
              onInput={(e) => setPw((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={t("gitGiteaAgain")}
            error={again && again !== pw ? t("gitGiteaMismatch") : undefined}
          >
            <input
              type="password"
              autocomplete="new-password"
              value={again}
              onInput={(e) => setAgain((e.target as HTMLInputElement).value)}
            />
          </Field>
          <div class="wide">
            <button type="submit" class="primary" disabled={pw.length < 10 || pw !== again}>
              {t("save")}
            </button>
          </div>
        </form>
      )}
      {methods.password && (
        <div class="remote-code">
          <h4>{t("remoteCode")}</h4>
          <p class="ui-help">{t("remoteCodeHint")}</p>
          {methods.code ? (
            <div class="row brain-linked">
              <span class="notice ok">
                <IconCheck size={14} /> {t("remoteCodeOn")}
              </span>
              <button
                type="button"
                class="link"
                onClick={() => void run(() => getApi().disableCode(), t("remoteCodeOff"))}
              >
                {t("brainDisconnect")}
              </button>
            </div>
          ) : secret ? (
            <div class="tg-pair">
              <div>
                <p>{t("remoteCodeScan")}</p>
                <code class="remote-secret">{secret.secret}</code>
                <form
                  class="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(
                      () => getApi().enableCode(secret.secret, code),
                      t("remoteCodeOn"),
                    ).then(() => setSecret(null));
                  }}
                >
                  <input
                    inputMode="numeric"
                    aria-label={t("loginCode")}
                    placeholder="123456"
                    value={code}
                    onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                  />
                  <button type="submit" class="primary" disabled={code.trim().length < 6}>
                    {t("remoteCodeConfirm")}
                  </button>
                </form>
              </div>
              <div class="tg-qr">
                <Qr text={secret.url} label={t("remoteCodeQr")} />
                <span class="ui-help">{t("remoteCodeQr")}</span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() =>
                void getApi()
                  .newCodeSecret()
                  .then(setSecret, (e: unknown) => setMsg({ ok: false, text: explain(e) }))
              }
            >
              {t("remoteCodeStart")}
            </button>
          )}
        </div>
      )}
      {methods.password && (
        <Advanced label={t("remoteSessions")}>
          <p class="ui-help">{t("remoteSessionsHint")}</p>
          <div>
            <button
              type="button"
              class="danger"
              onClick={() => void run(() => getApi().revokeSessions(), t("remoteSignedOut"))}
            >
              {t("remoteSignOutAll")}
            </button>
          </div>
        </Advanced>
      )}
      {msg && <p class={`notice ${msg.ok ? "ok" : "error"}`}>{msg.text}</p>}
    </div>
  );
}

type Way = "tailscale" | "cloudflare" | "caddy";

function WayGuide({ way, onStart }: { way: Way; onStart: (req: object) => void }) {
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  if (way === "tailscale")
    return (
      <ol class="brain-steps">
        <li>
          {t("tsStep1")}{" "}
          <a
            class="button"
            href="https://login.tailscale.com/start"
            target="_blank"
            rel="noreferrer"
          >
            {t("tsSignUp")}
          </a>
        </li>
        <li>
          {t("tsStep2")}{" "}
          <a
            class="button"
            href="https://login.tailscale.com/admin/dns"
            target="_blank"
            rel="noreferrer"
          >
            {t("tsDns")}
          </a>
        </li>
        <li>
          {t("tsStep3")}{" "}
          <button type="button" class="primary" onClick={() => onStart({ way: "tailscale" })}>
            {t("remoteConnect")}
          </button>
        </li>
        <li>
          {t("tsStep4")}{" "}
          <a class="button" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
            {t("tsApps")}
          </a>
        </li>
      </ol>
    );
  if (way === "cloudflare")
    return (
      <ol class="brain-steps">
        <li>
          {t("cfStep1")}{" "}
          <a
            class="button"
            href="https://dash.cloudflare.com/?to=/:account/domains/register"
            target="_blank"
            rel="noreferrer"
          >
            {t("cfBuy")}
          </a>
        </li>
        <li>
          {t("cfStep2")}{" "}
          <a
            class="button"
            href="https://one.dash.cloudflare.com/?to=/:account/networks/tunnels"
            target="_blank"
            rel="noreferrer"
          >
            {t("cfTunnels")}
          </a>
        </li>
        <li>{t("cfStep3")}</li>
        <li>
          {t("cfStep4")}
          <form
            class="form"
            onSubmit={(e) => {
              e.preventDefault();
              onStart({ way: "cloudflare", token: token.trim(), hostname: host.trim() });
            }}
          >
            <Field label={t("cfToken")} help={t("cfTokenHelp")}>
              <input
                type="password"
                autocomplete="off"
                value={token}
                onInput={(e) => setToken((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label={t("cfHost")} help={t("cfHostHelp")}>
              <input
                placeholder="redgiant.example.com"
                value={host}
                onInput={(e) => setHost((e.target as HTMLInputElement).value)}
              />
            </Field>
            <div class="wide">
              <button
                type="submit"
                class="primary"
                disabled={token.trim().length < 40 || !host.includes(".")}
              >
                {t("remoteConnect")}
              </button>
            </div>
          </form>
        </li>
        <li class="ui-help">{t("cfAccess")}</li>
      </ol>
    );
  return (
    <ol class="brain-steps">
      <li class="notice warn">{t("caddyWarning")}</li>
      <li>{t("caddyStep1")}</li>
      <li>{t("caddyStep2")}</li>
      <li>
        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault();
            onStart({ way: "caddy", domain: host.trim() });
          }}
        >
          <Field label={t("caddyDomain")} help={t("caddyDomainHelp")}>
            <input
              placeholder="redgiant.example.com"
              value={host}
              onInput={(e) => setHost((e.target as HTMLInputElement).value)}
            />
          </Field>
          <div class="wide">
            <button type="submit" class="primary" disabled={!host.includes(".")}>
              {t("remoteConnect")}
            </button>
          </div>
        </form>
      </li>
      <li class="ui-help">{t("caddyPihole")}</li>
    </ol>
  );
}

export function RemoteAccess({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const [way, setWay] = useState<Way>(s.config.remote?.way ?? "tailscale");
  const [jobId, setJobId] = useState<string>();
  const [hasPassword, setHasPassword] = useState(false);
  const [error, setError] = useState<string>();
  const job = useJob(jobId);
  useEffect(() => {
    void loginMethods().then(
      (m) => setHasPassword(m.password),
      () => {},
    );
  }, []);
  useEffect(() => {
    if (job?.state === "done") onChange();
  }, [job?.state]);
  const start = async (req: object) => {
    setError(undefined);
    try {
      setJobId((await getApi().startRemote(req as never)).id);
    } catch (err) {
      setError(explain(err));
    }
  };
  const active = s.config.remote;
  return (
    <div class="brain">
      <PasswordPanel
        onChange={() =>
          void loginMethods().then(
            (m) => setHasPassword(m.password),
            () => {},
          )
        }
      />
      <div class={`brain-panel${hasPassword ? "" : " locked"}`}>
        <h3>{t("remoteHow")}</h3>
        {!hasPassword && <p class="notice warn">{t("remoteNeedsPassword")}</p>}
        {active ? (
          <div class="tg-pair">
            <div>
              <span class="notice ok">
                <IconCheck size={14} /> {t("remoteOn")}
              </span>
              <a class="button primary" href={active.url} target="_blank" rel="noreferrer">
                {active.url}
              </a>
              <button
                type="button"
                class="link"
                onClick={() => void getApi().stopRemote().then(onChange)}
              >
                {t("remoteOff")}
              </button>
            </div>
            <div class="tg-qr">
              <Qr text={active.url} label={t("tgQr")} />
              <span class="ui-help">{t("tgQr")}</span>
            </div>
          </div>
        ) : (
          hasPassword && (
            <>
              <Choice<Way>
                value={[way]}
                onChange={([w]) => w && setWay(w)}
                options={[
                  {
                    id: "tailscale",
                    title: "Tailscale",
                    description: t("remoteTailscale"),
                    badge: t("lmRecommended"),
                  },
                  {
                    id: "cloudflare",
                    title: "Cloudflare Tunnel",
                    description: t("remoteCloudflare"),
                  },
                  { id: "caddy", title: t("remoteOwnDomain"), description: t("remoteCaddy") },
                ]}
              />
              {job?.state !== "running" && <WayGuide way={way} onStart={(r) => void start(r)} />}
            </>
          )
        )}
        {job?.state === "running" && job.vars.url && (
          <p class="notice warn">
            {t("tsSignIn")}{" "}
            <a class="button primary" href={job.vars.url} target="_blank" rel="noreferrer">
              {t("tsOpenSignIn")}
            </a>
          </p>
        )}
        {job && <JobView job={job} cancellable />}
        {error && <p class="notice error">{error}</p>}
      </div>
    </div>
  );
}
