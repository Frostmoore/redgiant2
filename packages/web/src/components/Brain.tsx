// "How should RedGiant think?" (G24.2): the subscriptions, linked from the browser; providers
// with a key of one's own; one's own server; a model on this computer. Any of them, or none.
// The same cards are in Settings, so everything is changed where it was chosen.
import { KEY_PROVIDERS, type KeyProvider, OWN_SERVER_ID } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type ClaudeAccount, type SetupState } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { IconCard, IconCheck, IconCpu, IconLayers, IconMonitor } from "../icons.js";
import { getApi, refreshLimits } from "../state.js";
import { Advanced, Choice, Field, Pick } from "./ui.js";

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
function Linked({ who, onOut }: { who: string; onOut: () => void }) {
  return (
    <div class="row brain-linked">
      <span class="notice ok">
        <IconCheck size={14} /> {who}
      </span>
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
  const [status, setStatus] = useState<{ on: boolean; account: ClaudeAccount | null }>();
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
  const [status, setStatus] = useState<{
    on: boolean;
    account: { email: string | null; plan: string | null } | null;
  }>();
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

/** One provider of the catalog: where the key is made, the key, a test at once. */
function KeyRow({
  p,
  connected,
  locked,
  onChange,
}: {
  p: KeyProvider;
  connected: boolean;
  locked: boolean;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const r = await getApi().setupKey(p.id, key.trim());
      setResult({ ok: true, text: t("brainKeyWorks", { n: String(r.models.length) }) });
      setKey("");
      setOpen(false);
      onChange();
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  return (
    <li class="brain-key">
      <div class="row">
        <strong>{p.name}</strong>
        {(connected || locked) && (
          <span class="chip ok">{locked ? t("wzLocked") : t("brainConnected")}</span>
        )}
        <div class="spacer" />
        {connected && !locked ? (
          <button
            type="button"
            class="link"
            onClick={() => void getApi().removeKey(p.id).then(onChange)}
          >
            {t("brainDisconnect")}
          </button>
        ) : (
          !locked && (
            <button type="button" class="tiny" onClick={() => setOpen(!open)}>
              {t("brainAddKey")}
            </button>
          )
        )}
      </div>
      {open && (
        <form class="brain-key-form" onSubmit={(e) => void save(e)}>
          <ol class="brain-steps">
            <li>
              <a href={p.keyUrl} target="_blank" rel="noreferrer">
                {t("brainKeyMake", { name: p.name })}
              </a>
            </li>
            <li>
              <Field
                label={t("brainKeyPaste")}
                help={t("brainKeyExample", { example: p.keyExample })}
              >
                <input
                  type="password"
                  autocomplete="off"
                  value={key}
                  onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                />
              </Field>
            </li>
          </ol>
          <button type="submit" class="primary" disabled={busy || key.trim().length < 8}>
            {busy ? t("wzTrying") : t("brainKeyTry")}
          </button>
        </form>
      )}
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
    </li>
  );
}

export function KeysPanel({ s, onChange }: { s: SetupState; onChange: () => void }) {
  return (
    <div class="brain-panel">
      <h3>{t("brainKeys")}</h3>
      <p class="ui-help">{t("brainKeysHint")}</p>
      <ul class="brain-key-list">
        {KEY_PROVIDERS.map((p) => (
          <KeyRow
            key={p.id}
            p={p}
            connected={s.secretsSet.keys.includes(p.id)}
            locked={p.id === "anthropic" && s.locked.anthropic === true}
            onChange={onChange}
          />
        ))}
      </ul>
    </div>
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

type Way = "claude" | "chatgpt" | "keys" | "local" | "server";

/** Which ways are in use already: their cards start open. */
function inUse(s: SetupState): Way[] {
  const ways: Way[] = [];
  if (s.config.subscriptions?.claude) ways.push("claude");
  if (s.config.subscriptions?.chatgpt) ways.push("chatgpt");
  if (s.secretsSet.keys.length > 0 || s.locked.anthropic) ways.push("keys");
  if (s.config.engine) ways.push("local");
  if (s.config.server || s.locked.server) ways.push("server");
  return ways;
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

/**
 * Every way of thinking, as cards to pick and the panel of each one picked. `wizard` adds the
 * hint that the local model is chosen in the next step.
 */
export function Brain({
  s,
  reload,
  wizard,
}: {
  s: SetupState;
  reload: () => void;
  wizard?: boolean;
}) {
  const [ways, setWays] = useState<Way[]>(() => inUse(s));
  const [ack, setAckState] = useState(s.config.subscriptionAck === true);
  const setAck = (v: boolean) => {
    setAckState(v);
    void getApi()
      .setupSubscriptions({ ack: v })
      .catch(() => {});
  };
  return (
    <div class="brain">
      <Choice<Way>
        multiple
        value={ways}
        onChange={setWays}
        options={[
          {
            id: "claude",
            title: t("brainClaude"),
            description: t("brainClaudeCard"),
            icon: <IconCard size={16} />,
          },
          {
            id: "chatgpt",
            title: t("brainChatgpt"),
            description: t("brainChatgptCard"),
            icon: <IconCard size={16} />,
          },
          {
            id: "keys",
            title: t("brainKeys"),
            description: t("brainKeysCard"),
            icon: <IconLayers size={16} />,
          },
          {
            id: "local",
            title: t("brainLocal"),
            description: t("brainLocalCard"),
            icon: <IconCpu size={16} />,
          },
          {
            id: "server",
            title: t("brainServer"),
            description: t("brainServerCard"),
            icon: <IconMonitor size={16} />,
          },
        ]}
      />
      {ways.includes("claude") && <ClaudeCard ack={ack} setAck={setAck} onChange={reload} />}
      {ways.includes("chatgpt") && <ChatgptCard ack={ack} setAck={setAck} onChange={reload} />}
      {ways.includes("keys") && <KeysPanel s={s} onChange={reload} />}
      {ways.includes("local") && (
        <div class="brain-panel">
          <h3>{t("brainLocal")}</h3>
          <p class="ui-help">{wizard ? t("brainLocalNext") : t("brainLocalSettings")}</p>
        </div>
      )}
      {ways.includes("server") && <ServerPanel s={s} onChange={reload} />}
      <Advanced label={t("brainWhy")}>
        <p class="ui-help">{t("brainWhyText")}</p>
      </Advanced>
    </div>
  );
}
