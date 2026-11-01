import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi, refreshLimits } from "../state.js";

const TERMS = [
  { name: "Anthropic", url: "https://www.anthropic.com/legal/consumer-terms" },
  { name: "OpenAI", url: "https://openai.com/policies/terms-of-use" },
];

/**
 * Flat subscriptions (G21): Claude through its Agent SDK (a token from `claude setup-token`) and
 * ChatGPT through Codex (a device-code login). Nothing switches on before the terms warning.
 */
export function Subscriptions() {
  const [s, setS] = useState<SetupState | null>(null);
  const [token, setToken] = useState("");
  const [chatgpt, setChatgpt] = useState<{
    on: boolean;
    account: { email: string | null; plan: string | null } | null;
  } | null>(null);
  const [login, setLogin] = useState<{ url: string; code: string } | null>(null);
  const load = () => {
    void attempt(() => getApi().setup()).then((x) => x && setS(x));
    void attempt(() => getApi().chatgptStatus()).then((x) => x && setChatgpt(x));
  };
  useEffect(load, []);
  // While a login waits, the account appears when OpenAI confirms it.
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(
      () =>
        void getApi()
          .chatgptStatus()
          .then((x) => {
            setChatgpt(x);
            if (x.account) {
              setLogin(null);
              void refreshLimits();
            }
          })
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  }, [login]);
  if (!s) return null;
  const ack = s.config.subscriptionAck === true;
  const on = s.config.subscriptions ?? {};
  const save = (b: Record<string, unknown>) =>
    void attempt(() => getApi().setupSubscriptions(b)).then((r) => {
      if (r === undefined) return;
      setToken("");
      load();
      void refreshLimits();
    });
  return (
    <div class="hierarchy">
      <p class="dim">{t("subsHint")}</p>
      <div class={`notice ${ack ? "ok" : "warn"}`}>
        <div>{t("wzSubscription")}</div>
        <div class="row">
          {TERMS.map((x) => (
            <a key={x.name} href={x.url} target="_blank" rel="noreferrer">
              {t("termsOf", { name: x.name })}
            </a>
          ))}
        </div>
        <label class="row">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) =>
              void attempt(() =>
                getApi().setupSafety({ subscriptionAck: (e.target as HTMLInputElement).checked }),
              ).then(load)
            }
          />
          {t("subsAck")}
        </label>
      </div>

      <h3>Claude</h3>
      <p class="dim">{t("subsClaudeHint")}</p>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          save({ claude: token ? { token } : {} });
        }}
      >
        <label>
          {t("subsClaudeToken")}
          {s.secretsSet.claudeSubscription ? ` (${t("wzAlreadySet")})` : ""}
          <input
            type="password"
            autocomplete="off"
            placeholder="sk-ant-oat01-…"
            disabled={!ack}
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="row wide">
          <button
            type="submit"
            class="primary"
            disabled={!ack || (!token && !s.secretsSet.claudeSubscription)}
          >
            {on.claude ? t("save") : t("switchOn")}
          </button>
          {on.claude && (
            <button type="button" onClick={() => save({ claude: null })}>
              {t("turnOff")}
            </button>
          )}
          {on.claude && <span class="chip ok">{t("subsActive")}</span>}
        </div>
      </form>

      <h3>ChatGPT</h3>
      <p class="dim">{t("subsChatgptHint")}</p>
      <div class="form">
        <div class="row wide">
          {on.chatgpt ? (
            <>
              {chatgpt?.account ? (
                <span class="chip ok">
                  {t("subsLoggedAs", {
                    who: chatgpt.account.email ?? "ChatGPT",
                    plan: chatgpt.account.plan ?? "",
                  })}
                </span>
              ) : (
                <button
                  type="button"
                  class="primary"
                  onClick={() =>
                    void attempt(() => getApi().chatgptLogin()).then((l) => l && setLogin(l))
                  }
                >
                  {t("subsLogin")}
                </button>
              )}
              {chatgpt?.account && (
                <button
                  type="button"
                  onClick={() => void attempt(() => getApi().chatgptLogout()).then(load)}
                >
                  {t("logout")}
                </button>
              )}
              <button type="button" onClick={() => save({ chatgpt: false })}>
                {t("turnOff")}
              </button>
            </>
          ) : (
            <button
              type="button"
              class="primary"
              disabled={!ack}
              onClick={() => save({ chatgpt: true })}
            >
              {t("switchOn")}
            </button>
          )}
        </div>
        {login && (
          <div class="pairing">
            <div>
              <p>{t("subsDeviceStep")}</p>
              <p>
                <a href={login.url} target="_blank" rel="noreferrer">
                  {login.url}
                </a>
              </p>
              <code class="pairing-code">{login.code}</code>
              <p class="dim">{t("subsDeviceWait")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
