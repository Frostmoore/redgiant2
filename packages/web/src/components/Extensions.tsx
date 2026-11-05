// Extensions in plain words (G24.9): ask God for a new ability, add a service from the catalog
// (its own sign-in page, or a key pasted once), see what is connected. Hand-made skills and
// servers stay under "Advanced".
import {
  catalogConfig,
  type Guide,
  MCP_CATALOG,
  type McpCatalogEntry,
  type McpCategory,
} from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Installed, type McpEntry, type McpStatus, type Proposal } from "../api.js";
import { lang, t } from "../i18n.js";
import {
  IconBoard,
  IconCheck,
  IconClose,
  IconCompass,
  IconCopy,
  IconCpu,
  IconDownload,
  IconFile,
  IconLayers,
  IconMonitor,
  IconPencil,
  IconSearch,
  IconSend,
  IconTerminal,
  IconUpload,
} from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, getApi, getLive, openTab, projects } from "../state.js";
import { explain } from "./Brain.js";
import { Chat } from "./Chat.js";
import { DefaultExtensions } from "./Media.js";
import { Advanced, Field, Pick } from "./ui.js";

const scopeLabel = (projectId: string | null) =>
  projectId
    ? (projects.value.find((p) => p.id === projectId)?.name ?? projectId)
    : t("scopePlatform");
const who = (id: string) =>
  id === "human" ? t("you") : (agents.value.find((a) => a.id === id)?.name ?? id);

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const decide = (d: "approve" | "reject") =>
    void attempt(() => getApi().decideExtension(p.id, d)).then(onDone);
  const description = p.input.spec?.description ?? p.input.description ?? "";
  return (
    <div class="approval">
      <div class="row">
        <span class={`kind-badge ${p.kind === "tool" ? "result" : "decision"}`}>
          {t(p.kind === "tool" ? "extKindTool" : "extKindSkill")}
        </span>
        <strong>{p.name}</strong>
        <span class="chip">{scopeLabel(p.projectId)}</span>
        <span class="dim">
          {t("by")} {who(p.author)}
        </span>
      </div>
      <div>{description}</div>
      {p.input.spec && <code>{p.input.spec.command}</code>}
      {p.input.body && (
        <div
          class="md board-summary"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(p.input.body) }}
        />
      )}
      {Object.entries(p.input.files ?? {}).map(([path, content]) => (
        <details key={path}>
          <summary>
            <code>{path}</code>
          </summary>
          <pre>{content}</pre>
        </details>
      ))}
      <div>
        {p.report.map((r) => (
          <div key={r.name} class={`notice ${r.passed ? "ok" : "error"}`}>
            {r.passed ? <IconCheck /> : <IconClose />} {r.name}: {r.detail.split("\n")[0]}
          </div>
        ))}
      </div>
      {p.status === "pending" && (
        <div class="row">
          <button type="button" class="primary" onClick={() => decide("approve")}>
            {t("approve")}
          </button>
          <button type="button" class="danger" onClick={() => decide("reject")}>
            {t("reject")}
          </button>
        </div>
      )}
    </div>
  );
}

/** "What should your agents be able to do?": a conversation with God, right here. */
function AskGod() {
  const god = agents.value.find((a) => a.kind === "god");
  const [text, setText] = useState("");
  const [session, setSession] = useState<string>();
  const [error, setError] = useState<string>();
  if (!god) return null;
  const ask = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      const { sessionId } = await getApi().startSession(god.id);
      getLive().send({
        type: "session.send",
        sessionId,
        text: t("extAskGodMessage", { text: text.trim() }),
      });
      setSession(sessionId);
      setText("");
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <div class="ext-ask">
      <h3>{t("extAskTitle")}</h3>
      <p class="ui-help">{t("extAskHelp")}</p>
      {session ? (
        <>
          <div class="ext-chat">
            <Chat sessionId={session} agentId={god.id} />
          </div>
          <div class="row">
            <button type="button" onClick={() => setSession(undefined)}>
              {t("extAskAgain")}
            </button>
          </div>
        </>
      ) : (
        <form class="row" onSubmit={(e) => void ask(e)}>
          <input
            aria-label={t("extAskTitle")}
            placeholder={t("extAskPlaceholder")}
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="primary" disabled={!text.trim()}>
            <IconSend size={14} /> {t("extAsk")}
          </button>
        </form>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/**
 * Opens the service's sign-in page in a new tab. The tab is opened before asking the server,
 * while the click still counts, or the browser would block it.
 */
async function signIn(name: string): Promise<boolean> {
  const tab = window.open("", "_blank");
  try {
    const r = await getApi().mcpLogin(name, location.origin);
    if ("authorizeUrl" in r) {
      if (tab) tab.location.href = r.authorizeUrl;
      else location.href = r.authorizeUrl;
      return false;
    }
    tab?.close();
    return true;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Adding one entry: where it works and, when it needs one, its key. */
/** What the card says about signing in. */
const authLabel = (type: McpCatalogEntry["auth"]["type"]) =>
  type === "app"
    ? "extAuth_app"
    : type === "oauth"
      ? "extAuth_oauth"
      : type === "none"
        ? "extAuth_none"
        : "extAuth_header";

/** A guide in steps, with RedGiant's return address ready to copy where it is needed. */
function GuideSteps({ guide }: { guide: Guide }) {
  const redirect = `${location.origin}/api/extensions/oauth/callback`;
  const [copied, setCopied] = useState(false);
  return (
    <ol class="ext-guide">
      {guide[lang.value].map((step) => {
        const [before, after] = step.split("{redirect}");
        return (
          <li key={step}>
            {before}
            {after !== undefined && (
              <>
                <code class="ext-redirect">{redirect}</code>{" "}
                <button
                  type="button"
                  class="tiny"
                  onClick={() =>
                    void navigator.clipboard?.writeText(redirect).then(() => setCopied(true))
                  }
                >
                  <IconCopy size={11} /> {copied ? t("copied") : t("copy")}
                </button>
                {after}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Adding one entry: where it works and what it needs from the person (a key, their app…). */
function AddForm({
  entry,
  onDone,
  onCancel,
}: {
  entry: McpCatalogEntry;
  onDone: (signingIn: boolean) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState("");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const a = entry.auth;
  const needsKey = a.type === "header" || a.type === "env";
  const signsIn = a.type === "oauth" || a.type === "app";
  const ready =
    (!needsKey || key.trim() !== "") &&
    (!entry.userUrl || url.trim() !== "") &&
    (a.type !== "app" || (clientId.trim() !== "" && (!a.secret || clientSecret.trim() !== ""))) &&
    (a.type !== "fields" || a.fields.every((f) => f.optional || (fields[f.env] ?? "").trim()));
  const add = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setMcp({
        name: entry.id,
        projectId: scope || null,
        ...catalogConfig(entry, {
          key,
          url,
          fields,
          app: { clientId, ...(clientSecret.trim() && { clientSecret }) },
        }),
      });
      onDone(signsIn && !(await signIn(entry.id)));
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const guide = "guide" in a ? a.guide : undefined;
  return (
    <form class="form ext-add" onSubmit={(e) => void add(e)}>
      {entry.note && <p class="notice warn">{entry.note[lang.value]}</p>}
      {entry.unverified && <p class="ui-help">{t("extUnverified")}</p>}
      {guide && (
        <details class="ext-guide-box" open={a.type === "app" || a.type === "fields"}>
          <summary>
            {t(a.type === "app" ? "extAppGuide" : "extGuide", { name: entry.name })}
          </summary>
          <GuideSteps guide={guide} />
          {a.type === "app" && (
            <a href={a.consoleUrl} target="_blank" rel="noreferrer">
              {t("extAppConsole", { name: entry.name })}
            </a>
          )}
        </details>
      )}
      <Field label={t("extWhere")} help={t("extWhereHelp")}>
        <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="">{t("extEverywhere")}</option>
          {projects.value.map((p) => (
            <option key={p.id} value={p.id}>
              {t("extOnlyProject", { name: p.name })}
            </option>
          ))}
        </select>
      </Field>
      {entry.userUrl && (
        <Field label={t("extServerUrl", { name: entry.name })} help={t("extServerUrlHelp")}>
          <input
            type="url"
            placeholder={entry.userUrl.example}
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </Field>
      )}
      {a.type === "app" && (
        <>
          <Field label={t("extClientId")}>
            <input
              autocomplete="off"
              value={clientId}
              onInput={(e) => setClientId((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={a.secret ? t("extClientSecret") : t("extClientSecretOptional")}
            help={t("extKeyHelp")}
          >
            <input
              type="password"
              autocomplete="off"
              value={clientSecret}
              onInput={(e) => setClientSecret((e.target as HTMLInputElement).value)}
            />
          </Field>
        </>
      )}
      {a.type === "fields" &&
        a.fields.map((f) => (
          <Field key={f.env} label={f.label[lang.value]}>
            <input
              type={(f.secret ? "password" : "text") as "text"}
              autocomplete="off"
              placeholder={f.example ?? ""}
              value={fields[f.env] ?? ""}
              onInput={(e) =>
                setFields({ ...fields, [f.env]: (e.target as HTMLInputElement).value })
              }
            />
          </Field>
        ))}
      {needsKey && (
        <Field label={t("extKey", { name: entry.name })} help={t("extKeyHelp")}>
          <input
            type="password"
            autocomplete="off"
            placeholder={a.keyExample ?? ""}
            value={key}
            onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          />
          <a href={a.keyUrl} target="_blank" rel="noreferrer">
            {t("extKeyWhere", { name: entry.name })}
          </a>
        </Field>
      )}
      {signsIn && <p class="ui-help">{t("extOauthHelp", { name: entry.name })}</p>}
      {error && <p class="notice error">{error}</p>}
      <div class="row">
        <button type="submit" class="primary" disabled={busy || !ready}>
          {signsIn ? t("extAddAndConnect") : t("extAdd")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

const CATEGORIES = (
  ["code", "docs", "web", "data", "work", "design", "cloud", "home"] as McpCategory[]
).filter((c) => MCP_CATALOG.some((e) => e.category === c));
/** Drawn icons by kind of service: never the services' own logos. */
const CATEGORY_ICON = {
  code: IconTerminal,
  docs: IconFile,
  web: IconCompass,
  data: IconLayers,
  work: IconBoard,
  design: IconPencil,
  cloud: IconCpu,
  home: IconMonitor,
} as const;

function Catalog({
  added,
  onAdded,
}: {
  added: Set<string>;
  onAdded: (signingIn: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<McpCategory | "">("");
  const [open, setOpen] = useState<string>();
  const words = q.trim().toLowerCase();
  const shown = MCP_CATALOG.filter(
    (e) =>
      (!category || e.category === category) &&
      (!words || `${e.name} ${e.description[lang.value]} ${e.id}`.toLowerCase().includes(words)),
  ).sort((x, y) => Number(y.official) - Number(x.official));
  return (
    <div class="ext-catalog">
      <h3>{t("extCatalog")}</h3>
      <p class="ui-help">{t("extCatalogHelp")}</p>
      <div class="row wrap">
        <label class="ext-search">
          <IconSearch size={14} />
          <input
            aria-label={t("extSearch")}
            placeholder={t("extSearch")}
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </label>
        {(["", ...CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            class={`chip-button${category === c ? " on" : ""}`}
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {t(c ? `extCat_${c}` : "extCatAll")}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p class="dim">{t("extNothingFound")}</p>}
      <div class="lm-cards">
        {shown.map((e) => (
          <div key={e.id} class="lm-card">
            <div class="row">
              {(() => {
                const Icon = CATEGORY_ICON[e.category];
                return <Icon size={16} />;
              })()}
              <strong>{e.name}</strong>
              <span class={`chip${e.official ? " ok" : ""}`}>
                {t(e.official ? "extOfficial" : "extCommunity")}
              </span>
            </div>
            <p class="ui-help">{e.description[lang.value]}</p>
            <p class="lm-meta">
              {t(authLabel(e.auth.type))}
              {e.unverified && ` · ${t("extUnverifiedShort")}`}
            </p>
            {added.has(e.id) ? (
              <span class="chip ok">
                <IconCheck size={12} /> {t("extAdded")}
              </span>
            ) : open === e.id ? (
              <AddForm
                entry={e}
                onCancel={() => setOpen(undefined)}
                onDone={(signingIn) => {
                  setOpen(undefined);
                  onAdded(signingIn);
                }}
              />
            ) : (
              <div class="row">
                <button type="button" class="primary" onClick={() => setOpen(e.id)}>
                  {t("extAdd")}
                </button>
                <a href={e.homepage} target="_blank" rel="noreferrer">
                  {t("extMore")}
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The servers added, whether each works, and the button that signs in. */
function Connected({
  mcp,
  status,
  onChange,
}: {
  mcp: McpEntry[];
  status: McpStatus[] | undefined;
  onChange: (signingIn?: boolean) => void;
}) {
  const [error, setError] = useState<string>();
  if (mcp.length === 0) return null;
  const connect = async (name: string) => {
    setError(undefined);
    try {
      onChange(!(await signIn(name)));
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <div class="ext-connected">
      <h3>{t("extConnected")}</h3>
      {mcp.map((m) => {
        const s = status?.find((x) => x.name === m.name);
        const entry = MCP_CATALOG.find((e) => e.id === m.name);
        return (
          <div class="node-row" key={m.name}>
            <strong>{entry?.name ?? m.name}</strong>
            <span class="chip">{scopeLabel(m.project_id)}</span>
            {!s ? (
              <span class="dim">{t("extChecking")}</span>
            ) : s.state === "connected" ? (
              <span class="chip ok">{t("extWorks", { n: String(s.tools) })}</span>
            ) : s.state === "login" ? (
              <>
                <span class="chip warn">{t("extNeedsLogin")}</span>
                <button type="button" class="primary" onClick={() => void connect(m.name)}>
                  {t("extConnect")}
                </button>
              </>
            ) : (
              <span class="chip danger" title={s.error}>
                {t("extBroken")}
              </span>
            )}
            <button
              type="button"
              class="danger"
              onClick={() => void attempt(() => getApi().removeMcp(m.name)).then(() => onChange())}
            >
              {t("remove")}
            </button>
          </div>
        );
      })}
      {status?.some((s) => s.state === "error") && <p class="ui-help">{t("extBrokenHelp")}</p>}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

function NewSkill({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    const p = await attempt(() =>
      getApi().createExtension(scope || null, {
        kind: "skill",
        name,
        description,
        body,
        untestableReason: "Written by the user, who is also its reviewer.",
      }),
    );
    if (p) {
      setName("");
      setDescription("");
      setBody("");
      onDone();
    }
  };
  return (
    <form class="form" onSubmit={(e) => void submit(e)}>
      <label>
        {t("name")}
        <input
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("description")}
        <input
          required
          minLength={10}
          value={description}
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("scope")}
        <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="">{t("scopePlatform")}</option>
          {projects.value.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label class="wide">
        {t("instructions")}
        <textarea
          required
          minLength={20}
          rows={6}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="row">
        <button type="submit" class="primary">
          {t("create")}
        </button>
      </div>
    </form>
  );
}

/** A server not in the catalog: its address (or command), and how it signs in. */
function McpForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("http");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [oauth, setOauth] = useState(false);
  const [token, setToken] = useState("");
  const [scope, setScope] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    const transport =
      type === "http"
        ? { type, url, ...(oauth && { oauth }) }
        : { type, command, args: args.split(" ").filter(Boolean) };
    const secrets =
      type === "http" && !oauth && token.trim()
        ? { headers: { Authorization: `Bearer ${token.trim()}` } }
        : undefined;
    if (
      await attempt(() =>
        getApi().setMcp({ name, projectId: scope || null, transport, ...(secrets && { secrets }) }),
      )
    )
      onDone();
  };
  return (
    <form class="form" onSubmit={(e) => void submit(e)}>
      <label>
        {t("name")}
        <input
          required
          pattern="[a-z0-9][a-z0-9-]{0,30}"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("scope")}
        <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="">{t("scopePlatform")}</option>
          {projects.value.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("extTransport")}
        <select
          value={type}
          onChange={(e) => setType((e.target as HTMLSelectElement).value as "stdio" | "http")}
        >
          <option value="http">{t("extTransportHttp")}</option>
          <option value="stdio">{t("extTransportStdio")}</option>
        </select>
      </label>
      {type === "http" ? (
        <>
          <label class="wide">
            {t("url")}
            <input
              required
              type="url"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
          </label>
          <Pick small on={oauth} onChange={(v) => setOauth(v)}>
            {t("extManualOauth")}
          </Pick>
          {!oauth && (
            <label>
              {t("extManualToken")}
              <input
                type="password"
                autocomplete="off"
                value={token}
                onInput={(e) => setToken((e.target as HTMLInputElement).value)}
              />
            </label>
          )}
        </>
      ) : (
        <>
          <label>
            {t("command")}
            <input
              required
              value={command}
              onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            {t("args")}
            <input value={args} onInput={(e) => setArgs((e.target as HTMLInputElement).value)} />
          </label>
        </>
      )}
      <div class="row">
        <button type="submit" class="primary">
          {t("addServer")}
        </button>
      </div>
    </form>
  );
}

async function downloadSkill(x: Installed) {
  const r = await attempt(() => getApi().exportSkill(x.name, x.scope));
  if (!r) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(r.blob);
  a.download = r.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** A shared skill (.zip) into the platform or a project; asks before replacing one. */
function ImportSkill({ onDone }: { onDone: () => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState("platform");
  const [done, setDone] = useState<string>();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setDone(undefined);
    const api = getApi();
    const r = await attempt(async () => {
      try {
        return await api.importSkill(file, scope);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        if (!confirm(t("skillReplaceConfirm"))) return undefined;
        return api.importSkill(file, scope, true);
      }
    });
    if (!r) return;
    setDone(r.name);
    onDone();
  };
  return (
    <>
      <h3>{t("skillImport")}</h3>
      <p class="ui-help">{t("skillImportHelp")}</p>
      <div class="row">
        <Field label={t("skillImportWhere")}>
          <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
            <option value="platform">{t("scopePlatform")}</option>
            {projects.value.map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" class="primary row" onClick={() => picker.current?.click()}>
          <IconUpload size={14} /> {t("skillImportFile")}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void pick(input.files?.[0]);
            input.value = "";
          }}
        />
      </div>
      {done && <p class="notice ok">{t("skillImported", { name: done })}</p>}
    </>
  );
}

/** Abilities for the agents: ask God, the catalog, what is connected, the hand-made ones. */
export function Extensions() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [mcp, setMcp] = useState<McpEntry[]>([]);
  const [status, setStatus] = useState<McpStatus[]>();
  const [version, setVersion] = useState(0);
  /** Until when to look again for a sign-in finished in the other tab. */
  const [watchUntil, setWatchUntil] = useState(0);
  const reload = (signingIn?: boolean) => {
    if (signingIn) setWatchUntil(Date.now() + 5 * 60_000);
    setVersion((v) => v + 1);
  };
  useEffect(() => {
    const api = getApi();
    void attempt(() => Promise.all([api.proposals(), api.installed(), api.mcpServers()])).then(
      (r) => {
        if (!r) return;
        setProposals(r[0]);
        setInstalled(r[1]);
        setMcp(r[2]);
      },
    );
    void api.mcpStatus().then(setStatus, () => setStatus([]));
  }, [version]);
  useEffect(() => {
    if (Date.now() > watchUntil) return;
    if (status && !status.some((s) => s.state === "login")) return;
    const timer = setTimeout(
      () =>
        void getApi()
          .mcpStatus()
          .then(setStatus, () => {}),
      3000,
    );
    return () => clearTimeout(timer);
  }, [status, watchUntil]);
  const pending = proposals.filter((p) => p.status === "pending");
  const failed = proposals.filter((p) => p.status === "failed").slice(0, 5);
  return (
    <div class="hierarchy extensions">
      <DefaultExtensions />
      <AskGod />
      {pending.length > 0 && (
        <>
          <h3>{t("extProposals")}</h3>
          <p class="ui-help">{t("extProposalsHelp")}</p>
          {pending.map((p) => (
            <ProposalCard key={p.id} p={p} onDone={reload} />
          ))}
        </>
      )}
      <Connected mcp={mcp} status={status} onChange={reload} />
      <Catalog added={new Set(mcp.map((m) => m.name))} onAdded={reload} />

      {installed.length > 0 && (
        <>
          <h3>{t("extSkills")}</h3>
          <p class="ui-help">{t("extSkillsHelp")}</p>
          {installed.map((x) => (
            <div class="node-row" key={`${x.scope}:${x.kind}:${x.name}`}>
              <span class={`kind-badge ${x.kind === "tool" ? "result" : "decision"}`}>
                {t(x.kind === "tool" ? "extKindTool" : "extKindSkill")}
              </span>
              <button
                type="button"
                class="link"
                onClick={() =>
                  openTab({
                    id: `edit:${x.scope}:${x.path}`,
                    type: "editor",
                    title: x.name,
                    scope: x.scope,
                    path: x.path,
                  })
                }
              >
                {x.name}
              </button>
              <span class="dim">{x.description}</span>
              <span class="chip">
                {x.scope === "platform" ? t("scopePlatform") : x.scope.slice(8)}
              </span>
              {x.kind === "skill" && (
                <button
                  type="button"
                  class="row"
                  title={t("skillDownloadHelp")}
                  onClick={() => void downloadSkill(x)}
                >
                  <IconDownload size={13} /> {t("skillDownload")}
                </button>
              )}
            </div>
          ))}
        </>
      )}
      <ImportSkill onDone={reload} />

      <Advanced>
        {failed.length > 0 && (
          <details>
            <summary class="dim">
              {t("failedTests")} ({failed.length})
            </summary>
            {failed.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={reload} />
            ))}
          </details>
        )}
        <h3>{t("newSkill")}</h3>
        <NewSkill onDone={reload} />
        <h3>{t("addServer")}</h3>
        <McpForm onDone={reload} />
      </Advanced>
    </div>
  );
}
