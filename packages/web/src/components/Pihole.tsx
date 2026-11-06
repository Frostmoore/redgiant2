// Pi-hole, by choice (G24.14c): the home's own DNS. It makes the person's domain reach RedGiant
// at home when the router cannot (no NAT loopback), and blocks ads and trackers for every device
// that uses it. Everything it changes at home is explained before it starts.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced, Field, JobView, useJob } from "./ui.js";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

/** The domain of the own-domain way, if that is the way out. */
function ownDomain(s: SetupState): string {
  const r = s.config.remote;
  if (r?.way !== "caddy") return "";
  try {
    return new URL(r.url).hostname;
  } catch {
    return "";
  }
}

/** What Pi-hole is, when it is needed and what it changes: read before anything starts. */
function Explanation() {
  return (
    <>
      <p>{t("piholeWhat")}</p>
      <div class="pihole-when">
        <div>
          <h4>{t("piholeNeedTitle")}</h4>
          <p class="ui-help">{t("piholeNeed")}</p>
          <p class="ui-help">{t("piholeTest")}</p>
        </div>
        <div>
          <h4>{t("piholeNoNeedTitle")}</h4>
          <p class="ui-help">{t("piholeNoNeed")}</p>
        </div>
      </div>
      <Advanced label={t("piholeChanges")}>
        <ol class="brain-steps">
          <li>{t("piholeRouter")}</li>
          <li>{t("piholeDevice")}</li>
          <li>{t("piholeSecond")}</li>
          <li>{t("piholeOff")}</li>
        </ol>
      </Advanced>
      <Advanced label={t("piholeAds")}>
        <p class="ui-help">{t("piholeAdsText")}</p>
        <p class="ui-help">{t("piholeAllow")}</p>
      </Advanced>
      <Advanced label={t("piholePort")}>
        <p class="ui-help">{t("piholePortText")}</p>
      </Advanced>
    </>
  );
}

export function PiholePanel({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const active = s.config.pihole;
  const [lanIp, setLanIp] = useState("");
  const [domain, setDomain] = useState(ownDomain(s));
  const [jobId, setJobId] = useState<string>();
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const job = useJob(jobId);
  useEffect(() => {
    if (job?.state === "done") onChange();
  }, [job?.state]);
  const run = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
    } catch (err) {
      setError(explain(err));
    }
  };
  const ipOk = IPV4.test(lanIp.trim());
  const domainOk = domain.trim() === "" || DOMAIN.test(domain.trim());
  return (
    <div class="brain-panel pihole">
      <h3>{t("piholeTitle")}</h3>
      {active ? (
        <>
          <p class="notice ok">{t("piholeOn", { ip: active.lanIp })}</p>
          {active.domain && (
            <p class="ui-help">{t("piholeAnswers", { domain: active.domain, ip: active.lanIp })}</p>
          )}
          <ol class="brain-steps">
            <li>{t("piholeNowRouter", { ip: active.lanIp })}</li>
            <li>
              {t("piholeAdmin")}{" "}
              <a class="button" href={active.adminUrl} target="_blank" rel="noreferrer">
                {t("piholeOpenAdmin")}
              </a>{" "}
              {password ? (
                <code class="remote-secret">{password}</code>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => setPassword((await getApi().piholePassword()).password))
                  }
                >
                  {t("piholeShowPassword")}
                </button>
              )}
            </li>
          </ol>
          <Advanced label={t("piholeChanges")}>
            <ol class="brain-steps">
              <li>{t("piholeSecond")}</li>
              <li>{t("piholeAllow")}</li>
              <li>{t("piholeOff")}</li>
            </ol>
          </Advanced>
          <div>
            <button
              type="button"
              class="danger"
              onClick={() =>
                void run(async () => {
                  await getApi().stopPihole();
                  setPassword(null);
                  onChange();
                })
              }
            >
              {t("piholeStop")}
            </button>
          </div>
        </>
      ) : (
        <>
          <Explanation />
          {job?.state !== "running" && (
            <form
              class="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () =>
                  setJobId(
                    (await getApi().startPihole(lanIp.trim(), domain.trim() || undefined)).id,
                  ),
                );
              }}
            >
              <Field
                label={t("piholeIp")}
                help={t("piholeIpHelp")}
                error={lanIp && !ipOk ? t("piholeIpWrong") : undefined}
              >
                <input
                  inputMode="decimal"
                  placeholder="192.168.1.50"
                  value={lanIp}
                  onInput={(e) => setLanIp((e.target as HTMLInputElement).value)}
                />
              </Field>
              <Field
                label={t("piholeDomain")}
                help={t("piholeDomainHelp")}
                error={domainOk ? undefined : t("piholeDomainWrong")}
              >
                <input
                  placeholder="redgiant.example.com"
                  value={domain}
                  onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
                />
              </Field>
              <div class="wide">
                <button type="submit" class="primary" disabled={!ipOk || !domainOk}>
                  {t("piholeStart")}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {job && job.state !== "done" && <JobView job={job} />}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}
