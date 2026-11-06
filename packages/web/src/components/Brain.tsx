// "How should RedGiant think?" (G24.2): the subscriptions, linked from the browser; providers
// with a key of one's own; one's own server; a model on this computer. Any of them, or none.
// The same squares and windows are in the wizard and in Settings (2026-11-06), so everything is
// changed where it was chosen.
import { KEY_PROVIDERS, OWN_SERVER_ID } from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type ClaudeAccount, type SetupState, type SubscriptionProgram } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { IconChat, IconKey, IconMonitor, IconServer, IconSpark } from "../icons.js";
import { getApi, refreshLimits } from "../state.js";
import type { Way } from "../wizard.js";
import { Acts } from "./SettingsKit.js";
import { Field, Pick } from "./ui.js";

/** An error in plain words: its code when the server gives one, otherwise its message. */
export function explain(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  return (code && tOptional(`err_${code}`)) || (err as Error).message;
}

const TERMS = [
  { name: "Anthropic", url: "https://www.anthropic.com/legal/consumer-terms" },
  { name: "OpenAI", url: "https://openai.com/policies/terms-of-use" },
];

/** The warning on the providers' terms, read once for every subscription (RD23). */
function Terms({ ack, setAck }: { ack: boolean; setAck: (v: boolean) => void }) {
  return (
    <div class="brain-terms">
      <Pick small on={ack} onChange={(v) => setAck(v)}>
        <span>{t("wzSubscription")}</span>
      </Pick>
      <span class="ui-help">
        {TERMS.map((x, i) => (
          <span key={x.name}>
            {i > 0 && " · "}
            <a href={x.url} target="_blank" rel="noreferrer">
              {t("termsOf", { name: x.name })}
            </a>
          </span>
        ))}
      </span>
    </div>
  );
}

/** A connected account: who, and a way out. */
/** Where a subscription's program comes from, said before it is switched on (2026-11-05). */
function ProgramNote({ name, s }: { name: string; s: SubscriptionProgram | undefined }) {
  if (!s) return null;
  if (s.sharedLogin) return <p class="notice ok">{t("subsSharedLogin", { name })}</p>;
  if (s.program === "system") return <p class="ui-help">{t("subsProgramSystem", { name })}</p>;
  if (s.program === null) return <p class="ui-help">{t("subsProgramDownload", { name })}</p>;
  return null;
}

function Linked({ who, onOut }: { who: string; onOut: () => void }) {
  return (
    <div class="row brain-linked">
      <span class="notice ok">{who}</span>
      <button type="button" class="link" onClick={onOut}>
        {t("brainDisconnect")}
      </button>
    </div>
  );
}

/** Claude Pro or Max: Anthropic's page in a new tab, then the code it shows pasted here. */
export function ClaudeCard({
  ack,
  setAck,
  onChange,
}: {
  ack: boolean;
  setAck: (v: boolean) => void;
  /** Signed in or out: the model to use may change. */
  onChange?: () => void;
}) {
  const [status, setStatus] = useState<
    { on: boolean; account: ClaudeAccount | null } & SubscriptionProgram
  >();
  const [page, setPage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    void getApi()
      .claudeStatus()
      .then(setStatus, (e: unknown) => setError(explain(e)));
  useEffect(load, []);
  const open = async () => {
    setError(undefined);
    // Opened at once, in the click: browsers block windows opened later.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await getApi().claudeLogin(ack);
      setPage(url);
      if (tab) tab.location.href = url;
    } catch (e) {
      tab?.close();
      setError(explain(e));
    }
  };
  const finish = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await getApi().claudeCode(code);
      setPage(null);
      setCode("");
      load();
      onChange?.();
      void refreshLimits();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  const account = status?.on && status.account?.loggedIn ? status.account : null;
  return (
    <div class="brain-panel">
      <h3>{t("brainClaude")}</h3>
      <p class="ui-help">{t("brainClaudeHint")}</p>
      {!account && <ProgramNote name="Claude Code" s={status} />}
      {account ? (
        <Linked
          who={t("subsLoggedAs", { who: account.email ?? "Claude", plan: account.plan ?? "" })}
          onOut={() =>
            void getApi()
              .claudeLogout()
              .then(
                () => {
                  load();
                  onChange?.();
                },
                (e) => setError(explain(e)),
              )
          }
        />
      ) : (
        <>
          <Terms ack={ack} setAck={setAck} />
          {status?.sharedLogin && (
            <p>
              <button
                type="button"
                class="primary"
                disabled={!ack || busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setError(undefined);
                    try {
                      await getApi().setupSubscriptions({ ack, claude: {} });
                      load();
                      onChange?.();
                      void refreshLimits();
                    } catch (e) {
                      setError(explain(e));
                    }
                    setBusy(false);
                  })()
                }
              >
                {t("subsUseShared")}
              </button>
            </p>
          )}
          <ol class="brain-steps">
            <li>
              <button type="button" class="primary" disabled={!ack} onClick={() => void open()}>
                {t("brainClaudeOpen")}
              </button>
              {page && (
                <span class="ui-help">
                  {" "}
                  {t("brainNotOpened")}{" "}
                  <a href={page} target="_blank" rel="noreferrer">
                    {t("brainOpenHere")}
                  </a>
                </span>
              )}
            </li>
            <li>{t("brainClaudeStep2")}</li>
            <li>
              <form class="row brain-code" onSubmit={(e) => void finish(e)}>
                <input
                  aria-label={t("brainClaudeCode")}
                  placeholder={t("brainClaudeCode")}
                  disabled={!page}
                  value={code}
                  onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                />
                <button type="submit" class="primary" disabled={!page || busy || !code.trim()}>
                  {busy ? t("wzTrying") : t("brainConnect")}
                </button>
              </form>
            </li>
          </ol>
        </>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** ChatGPT Plus or Pro: a code to type on OpenAI's page; the card notices when it is done. */
export function ChatgptCard({
  ack,
  setAck,
  onChange,
}: {
  ack: boolean;
  setAck: (v: boolean) => void;
  onChange?: () => void;
}) {
  const [status, setStatus] = useState<
    {
      on: boolean;
      account: { email: string | null; plan: string | null } | null;
    } & SubscriptionProgram
  >();
  const [login, setLogin] = useState<{ url: string; code: string } | null>(null);
  const [error, setError] = useState<string>();
  const load = () =>
    void getApi()
      .chatgptStatus()
      .then(setStatus, (e: unknown) => setError(explain(e)));
  useEffect(load, []);
  // While the code waits, the account appears as soon as OpenAI confirms it.
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(
      () =>
        void getApi()
          .chatgptStatus()
          .then((x) => {
            setStatus(x);
            if (x.account) {
              setLogin(null);
              onChange?.();
              void refreshLimits();
            }
          })
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  }, [login]);
  const start = async () => {
    setError(undefined);
    try {
      if (!status?.on) await getApi().setupSubscriptions({ ack, chatgpt: true });
      // Already signed in with the person's own Codex (2026-11-05): nothing more to do.
      const now = await getApi().chatgptStatus();
      setStatus(now);
      if (now.account) {
        onChange?.();
        void refreshLimits();
        return;
      }
      setLogin(await getApi().chatgptLogin());
      load();
    } catch (e) {
      setError(explain(e));
    }
  };
  const out = async () => {
    try {
      await getApi().chatgptLogout();
      await getApi().setupSubscriptions({ chatgpt: false });
      load();
      onChange?.();
    } catch (e) {
      setError(explain(e));
    }
  };
  const account = status?.on ? status.account : null;
  return (
    <div class="brain-panel">
      <h3>{t("brainChatgpt")}</h3>
      <p class="ui-help">{t("brainChatgptHint")}</p>
      {!account && <ProgramNote name="Codex" s={status} />}
      {account ? (
        <Linked
          who={t("subsLoggedAs", { who: account.email ?? "ChatGPT", plan: account.plan ?? "" })}
          onOut={() => void out()}
        />
      ) : login ? (
        <ol class="brain-steps">
          <li>
            {t("brainChatgptStep1")}{" "}
            <a href={login.url} target="_blank" rel="noreferrer">
              {login.url}
            </a>
          </li>
          <li>
            {t("brainChatgptStep2")} <code class="pairing-code">{login.code}</code>
          </li>
          <li class="dim">{t("subsDeviceWait")}</li>
          <li class="ui-help">{t("brainChatgptDevice")}</li>
        </ol>
      ) : (
        <>
          <Terms ack={ack} setAck={setAck} />
          <div>
            <button type="button" class="primary" disabled={!ack} onClick={() => void start()}>
              {t("brainChatgptStart")}
            </button>
          </div>
        </>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** The API keys, as the prototype has them: the providers as chips, one key at a time. */
export function KeysForm({
  s,
  onChange,
  onClose,
}: {
  s: SetupState;
  onChange: () => void;
  onClose: () => void;
}) {
  const [prov, setProv] = useState(KEY_PROVIDERS[0]?.id ?? "anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const p = KEY_PROVIDERS.find((x) => x.id === prov) ?? KEY_PROVIDERS[0];
  if (!p) return null;
  const connected = s.secretsSet.keys;
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const r = await getApi().setupKey(p.id, key.trim());
      setResult({ ok: true, text: t("brainKeyWorks", { n: String(r.models.length) }) });
      setKey("");
      onChange();
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  return (
    <form class="wz-keys" onSubmit={(e) => void save(e)}>
      <p class="wz-lead2">{t("wzKeysLead")}</p>
      {(connected.length > 0 || s.locked.anthropic) && (
        <ul class="wz-keylist">
          {s.locked.anthropic && !connected.includes("anthropic") && (
            <li>
              <b>{providerName("anthropic")}</b>
              <span class="dim">{t("wzLocked")}</span>
            </li>
          )}
          {connected.map((k) => (
            <li key={k}>
              <b>{providerName(k)}</b>
              <button
                type="button"
                class="wz-link inl"
                onClick={() =>
                  void getApi()
                    .removeKey(k)
                    .then(onChange, () => {})
                }
              >
                {t("wzRemove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <span class="wz-lb">{t("wzProvider")}</span>
      <div class="wz-provs">
        {KEY_PROVIDERS.map((x) => (
          <button
            type="button"
            key={x.id}
            class={`wz-chip${x.id === prov ? " on" : ""}`}
            aria-pressed={x.id === prov}
            onClick={() => {
              setProv(x.id);
              setResult(undefined);
            }}
          >
            {x.name}
          </button>
        ))}
      </div>
      <Field
        label={t("wzKeyOf", { name: p.name })}
        help={t("brainKeyExample", { example: p.keyExample })}
      >
        <input
          class="wz-field mono"
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={key}
          onInput={(e) => setKey((e.target as HTMLInputElement).value)}
        />
      </Field>
      <a class="wz-link inl" href={p.keyUrl} target="_blank" rel="noreferrer">
        {t("brainKeyMake", { name: p.name })}
      </a>
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onClose}>
          {t("close")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={busy || key.trim().length < 8}>
          {busy ? t("wzTrying") : t("brainKeyTry")}
        </button>
      </Acts>
    </form>
  );
}

/** The user's own OpenAI-compatible server: Ollama, LM Studio, vLLM… */
export function ServerPanel({ s, onChange }: { s: SetupState; onChange: () => void }) {
  const [url, setUrl] = useState(s.config.server?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const r = await getApi().setupServer({ baseUrl: url.trim(), ...(key && { key }) });
      setResult({ ok: true, text: t("brainKeyWorks", { n: String(r.models.length) }) });
      onChange();
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  return (
    <form class="brain-panel" onSubmit={(e) => void save(e)}>
      <h3>{t("brainServer")}</h3>
      <p class="ui-help">{t("brainServerHint")}</p>
      {s.locked.server ? (
        <span class="chip ok">{t("wzLocked")}</span>
      ) : (
        <>
          <div class="form">
            <Field label={t("brainServerUrl")} help={t("brainServerUrlHelp")}>
              <input
                placeholder="http://localhost:11434/v1"
                value={url}
                onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field
              label={t("brainServerKey")}
              help={s.secretsSet.server ? t("wzAlreadySet") : t("brainServerKeyHelp")}
            >
              <input
                type="password"
                autocomplete="off"
                value={key}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <div class="row">
            <button type="submit" class="primary" disabled={busy || !url.trim()}>
              {busy ? t("wzTrying") : t("brainKeyTry")}
            </button>
            {s.config.server && (
              <button
                type="button"
                class="link"
                onClick={() => void getApi().removeServer().then(onChange)}
              >
                {t("brainDisconnect")}
              </button>
            )}
          </div>
        </>
      )}
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
    </form>
  );
}

const EFFORTS = ["low", "medium", "high", "max"] as const;

/** The model agents use when nobody chose another, among those connected, and its effort. */
export function DefaultModel({ s, onSaved }: { s: SetupState; onSaved: () => void }) {
  const [models, setModels] = useState<{ provider: string; model: string; effort: boolean }[]>();
  const current = s.config.defaultModel;
  const [model, setModel] = useState(current ? `${current.provider}/${current.model}` : "");
  const [effort, setEffort] = useState(current?.effort ?? "medium");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    // Chosen meanwhile (RedGiant picks one when the first way is connected): show it.
    if (current) setModel(`${current.provider}/${current.model}`);
    if (current?.effort) setEffort(current.effort);
    void getApi()
      .models()
      .then((m) => {
        setModels(m);
        if (!current && m[0]) setModel((x) => x || `${m[0]?.provider}/${m[0]?.model}`);
      })
      .catch(() => setModels([]));
  }, [s]);
  if (s.locked.defaultModel) return null;
  if (!models) return null;
  if (models.length === 0) return <p class="notice warn">{t("brainNoModel")}</p>;
  const save = async () => {
    const [provider = "", ...rest] = model.split("/");
    setBusy(true);
    setResult(undefined);
    try {
      await getApi().setupModels({ defaultModel: { provider, model: rest.join("/"), effort } });
      setResult({ ok: true, text: t("brainDefaultSaved") });
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  const providers = [...new Set(models.map((m) => m.provider))];
  return (
    <div class="brain-panel">
      <h3>{t("brainDefault")}</h3>
      <p class="ui-help">{t("brainDefaultHint")}</p>
      <div class="form">
        <Field label={t("wzDefaultModel")}>
          <select value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
            {providers.map((p) => (
              <optgroup key={p} label={providerName(p)}>
                {models
                  .filter((m) => m.provider === p)
                  .map((m) => (
                    <option key={m.model} value={`${m.provider}/${m.model}`}>
                      {m.model}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label={t("effort")} help={t("brainEffortHelp")}>
          <select value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {t(`effort_${x}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div class="row">
        <button type="button" class="primary" disabled={busy || !model} onClick={() => void save()}>
          {busy ? t("wzTrying") : t("brainDefaultTry")}
        </button>
      </div>
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
    </div>
  );
}

/** A provider id in words. */
export function providerName(id: string): string {
  if (id === "claude-subscription") return t("brainClaude");
  if (id === "chatgpt-subscription") return t("brainChatgpt");
  if (id === "local") return t("brainLocal");
  if (id === OWN_SERVER_ID) return t("brainServer");
  return KEY_PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

/** The ways of thinking as the wizard's squares (2026-11-06): the wizard and Settings show them. */
export function wayTiles(): [Way, JSX.Element, string, string][] {
  return [
    ["claude", <IconSpark key="c" />, t("brainClaude"), t("wzBrainClaude")],
    ["chatgpt", <IconChat key="g" size={22} />, t("brainChatgpt"), t("wzBrainChatgpt")],
    ["keys", <IconKey key="k" />, t("wzBrainKeysTitle"), t("wzBrainKeys")],
    ["server", <IconServer key="s" />, t("brainServer"), t("wzBrainServer")],
    ["local", <IconMonitor key="l" size={22} />, t("brainLocal"), t("wzBrainLocal")],
  ];
}

/** What a lit square says under its text: which key, which server, which local model. */
export function wayState(s: SetupState, w: Way): string {
  const keys = s.secretsSet.keys;
  if (w === "keys")
    return keys.length === 1
      ? t("wzStateKey", { name: providerName(keys[0] ?? "") })
      : t("wzStateKeys", { n: String(Math.max(keys.length, 1)) });
  if (w === "server")
    return s.config.server
      ? t("wzStateServer", { url: s.config.server.baseUrl })
      : t("wzStateLinked");
  if (w === "local")
    return s.config.engine
      ? t("wzStateLocal", { model: s.config.engine.model.replace(/\.gguf$/i, "") })
      : t("wzStateLocalNext");
  return t("wzStateLinked");
}
