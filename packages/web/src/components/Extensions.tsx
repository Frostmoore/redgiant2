// Extensions in plain words (G24.9), drawn as the wizard (2026-11-06): ask God for a new ability
// right under the question; what waits for the person (the agents' proposals, tested in a
// throwaway sandbox), the services connected, the generation of pictures, video and sound, the
// catalog, the skills and tools installed and the hand-made ones, all as the wizard's squares
// that open a window (a sheet from below on phones).
import {
  catalogConfig,
  type Guide,
  MCP_CATALOG,
  type McpCatalogEntry,
  type McpCategory,
  MEDIA_KINDS,
  MEDIA_PROVIDERS,
  type MediaKind,
  mediaProvider,
} from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type Installed,
  type McpEntry,
  type McpStatus,
  type Proposal,
  type SetupState,
} from "../api.js";
import { brandOr } from "../brands.js";
import { lang, t } from "../i18n.js";
import {
  IconBell,
  IconBoard,
  IconBook,
  IconCanvas,
  IconClose,
  IconCompass,
  IconCopy,
  IconCpu,
  IconDownload,
  IconFile,
  IconLayers,
  IconMic,
  IconMonitor,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconSend,
  IconServer,
  IconShield,
  IconSpark,
  IconTerminal,
  IconTool,
  IconUpload,
} from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, getApi, getLive, openTab, projects } from "../state.js";
import { explain } from "./Brain.js";
import { Chat } from "./Chat.js";
import { KindRow } from "./Media.js";
import { Acts, Facts, Head, Seg, Sub, SwitchRow, Tile, WzPage } from "./SettingsKit.js";
import { PHONE, useMedia } from "./SetupKit.js";
import { Field, Modal } from "./ui.js";

const scopeLabel = (projectId: string | null) =>
  projectId
    ? (projects.value.find((p) => p.id === projectId)?.name ?? projectId)
    : t("scopePlatform");
const who = (id: string) =>
  id === "human" ? t("you") : (agents.value.find((a) => a.id === id)?.name ?? id);
const value = (e: Event) => (e.target as HTMLInputElement).value;

/** The projects as options of a select, after the first one (everywhere). */
const projectOptions = (val: (id: string) => string, label: (name: string) => string) =>
  projects.value.map((p) => (
    <option key={p.id} value={val(p.id)}>
      {label(p.name)}
    </option>
  ));

/** An agent's proposal, read in full: what it does, its files, how its tests went. */
function ProposalView({
  p,
  onDone,
  onClose,
}: {
  p: Proposal;
  onDone: () => void;
  onClose: () => void;
}) {
  const decide = (d: "approve" | "reject") =>
    void attempt(() => getApi().decideExtension(p.id, d)).then(() => {
      onDone();
      onClose();
    });
  const description = p.input.spec?.description ?? p.input.description ?? "";
  // G36.8: an agent's skill that changes an installed one, its scripts, why it came.
  const update = p.kind === "skill" && Boolean(p.previous);
  const scripts =
    p.kind === "skill"
      ? Object.entries(p.input.files ?? {})
          .filter(
            ([f, c]) =>
              /\.(sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i.test(f) ||
              c.startsWith("#!"),
          )
          .map(([f]) => f)
      : [];
  const kept = (p.previous?.files ?? []).filter((f) => !(f in (p.input.files ?? {})));
  return (
    <Modal wide title={p.name} onClose={onClose}>
      <div class="wz-panel-in xw-prop">
        <Facts
          rows={[
            [
              t("xwKind"),
              update ? t("xwUpdates") : t(p.kind === "tool" ? "extKindTool" : "extKindSkill"),
            ],
            [t("scope"), scopeLabel(p.projectId)],
            [t("xwAuthor"), who(p.author)],
          ]}
        />
        {description && <p class="wz-lead2">{description}</p>}
        {p.input.summary && (
          <div class="wz-card wz-left xw-summary">
            <b>{t("xwSummary")}</b>
            <p>{p.input.summary}</p>
          </div>
        )}
        {scripts.length > 0 && p.status === "pending" && p.author !== "human" && (
          <p class="notice warn">{t("xwScripts", { files: scripts.join(", ") })}</p>
        )}
        {update && p.previous && (
          <div class="xw-compare">
            <details class="xw-file">
              <summary>{t("xwPrevious")}</summary>
              <pre>{p.previous.skillMd}</pre>
            </details>
            {kept.length > 0 && (
              <p class="ui-help">{t("xwKeptFiles", { files: kept.join(", ") })}</p>
            )}
          </div>
        )}
        {p.input.spec && <code class="xw-cmd">{p.input.spec.command}</code>}
        {p.input.body && (
          <div
            class="md xw-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(p.input.body) }}
          />
        )}
        {Object.entries(p.input.files ?? {}).map(([path, content]) => (
          <details key={path} class="xw-file">
            <summary>
              <code>{path}</code>
            </summary>
            <pre>{content}</pre>
          </details>
        ))}
        {p.report.length > 0 && <h4>{t("xwTests")}</h4>}
        <div class="xw-report">
          {p.report.map((r) => (
            <p key={r.name} class={`notice ${r.passed ? "ok" : "error"}`}>
              {!r.passed && <IconClose size={14} />} {r.name}: {r.detail.split("\n")[0]}
            </p>
          ))}
        </div>
      </div>
      <Acts>
        {p.status === "pending" ? (
          <>
            <button type="button" class="wz-btn quiet xw-danger" onClick={() => decide("reject")}>
              {t("reject")}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => decide("approve")}>
              {t("approve")}
            </button>
          </>
        ) : (
          <button type="button" class="wz-btn primary" onClick={onClose}>
            {t("wzDoneBtn")}
          </button>
        )}
      </Acts>
    </Modal>
  );
}

/** "What should your agents be able to do?": a conversation with God, right under the question. */
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
    <div class="wz-card xw-ask">
      {session ? (
        <>
          <div class="ext-chat">
            <Chat sessionId={session} agentId={god.id} />
          </div>
          <div class="xw-ask-again">
            <button type="button" class="wz-btn small" onClick={() => setSession(undefined)}>
              {t("extAskAgain")}
            </button>
          </div>
        </>
      ) : (
        <form class="xw-ask-form" onSubmit={(e) => void ask(e)}>
          <input
            class="wz-field"
            aria-label={t("extAskTitle")}
            placeholder={t("extAskPlaceholder")}
            value={text}
            onInput={(e) => setText(value(e))}
          />
          <button type="submit" class="wz-btn primary small" disabled={!text.trim()}>
            <IconSend size={18} /> {t("extAsk")}
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

/** What the window says about signing in. */
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
                  class="wz-link inl"
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
    <form class="xw-form" onSubmit={(e) => void add(e)}>
      {entry.note && <p class="notice warn">{entry.note[lang.value]}</p>}
      {entry.unverified && <p class="ui-help">{t("extUnverified")}</p>}
      {guide && (
        <details class="ext-guide-box" open={a.type === "app" || a.type === "fields"}>
          <summary>
            {t(a.type === "app" ? "extAppGuide" : "extGuide", { name: entry.name })}
          </summary>
          <GuideSteps guide={guide} />
          {a.type === "app" && (
            <a class="wz-link inl" href={a.consoleUrl} target="_blank" rel="noreferrer">
              {t("extAppConsole", { name: entry.name })}
            </a>
          )}
        </details>
      )}
      <Field label={t("extWhere")} help={t("extWhereHelp")}>
        <select class="wz-field" value={scope} onChange={(e) => setScope(value(e))}>
          <option value="">{t("extEverywhere")}</option>
          {projectOptions(
            (id) => id,
            (name) => t("extOnlyProject", { name }),
          )}
        </select>
      </Field>
      {entry.userUrl && (
        <Field label={t("extServerUrl", { name: entry.name })} help={t("extServerUrlHelp")}>
          <input
            class="wz-field"
            type="url"
            placeholder={entry.userUrl.example}
            value={url}
            onInput={(e) => setUrl(value(e))}
          />
        </Field>
      )}
      {a.type === "app" && (
        <>
          <Field label={t("extClientId")}>
            <input
              class="wz-field"
              autocomplete="off"
              value={clientId}
              onInput={(e) => setClientId(value(e))}
            />
          </Field>
          <Field
            label={a.secret ? t("extClientSecret") : t("extClientSecretOptional")}
            help={t("extKeyHelp")}
          >
            <input
              class="wz-field mono"
              type="password"
              autocomplete="off"
              value={clientSecret}
              onInput={(e) => setClientSecret(value(e))}
            />
          </Field>
        </>
      )}
      {a.type === "fields" &&
        a.fields.map((f) => (
          <Field key={f.env} label={f.label[lang.value]}>
            <input
              class="wz-field"
              type={(f.secret ? "password" : "text") as "text"}
              autocomplete="off"
              placeholder={f.example ?? ""}
              value={fields[f.env] ?? ""}
              onInput={(e) => setFields({ ...fields, [f.env]: value(e) })}
            />
          </Field>
        ))}
      {needsKey && (
        <>
          <Field label={t("extKey", { name: entry.name })} help={t("extKeyHelp")}>
            <input
              class="wz-field mono"
              type="password"
              autocomplete="off"
              placeholder={a.keyExample ?? ""}
              value={key}
              onInput={(e) => setKey(value(e))}
            />
          </Field>
          <a class="wz-link inl" href={a.keyUrl} target="_blank" rel="noreferrer">
            {t("extKeyWhere", { name: entry.name })}
          </a>
        </>
      )}
      {signsIn && <p class="ui-help">{t("extOauthHelp", { name: entry.name })}</p>}
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={busy || !ready}>
          {signsIn ? t("extAddAndConnect") : t("extAdd")}
        </button>
      </Acts>
    </form>
  );
}

const CATEGORIES = (
  ["code", "docs", "web", "data", "work", "design", "cloud", "home"] as McpCategory[]
).filter((c) => MCP_CATALOG.some((e) => e.category === c));
/** Drawn icons by kind of service, for services without a logo of their own (brands.tsx). */
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
const catIcon = (c: McpCategory) => {
  const Icon = CATEGORY_ICON[c];
  return <Icon />;
};
/** A catalog service's own logo (2026-11-07), or its kind's drawn icon. */
const serviceIcon = (e: { id: string; category: McpCategory }) =>
  brandOr(e.id, catIcon(e.category), 26);

/**
 * The catalog: a search, the kinds as chips, one square per service; each opens its window. On a
 * phone one kind at a time (the first at the start), or what the search finds among all of them.
 */
function Catalog({
  added,
  onAdded,
}: {
  added: Set<string>;
  onAdded: (signingIn: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<McpCategory | "">("");
  const [open, setOpen] = useState<McpCatalogEntry>();
  const phone = useMedia(PHONE);
  const words = q.trim().toLowerCase();
  const kind = phone ? (words ? "" : category || CATEGORIES[0]) : category;
  const shown = MCP_CATALOG.filter(
    (e) =>
      (!kind || e.category === kind) &&
      (!words || `${e.name} ${e.description[lang.value]} ${e.id}`.toLowerCase().includes(words)),
  ).sort((x, y) => Number(y.official) - Number(x.official));
  return (
    <>
      <Sub title={t("extCatalog")} lead={t("extCatalogHelp")} />
      <div class="xw-filter">
        <label class="xw-search">
          <IconSearch size={18} />
          <input
            class="wz-field"
            aria-label={t("extSearch")}
            placeholder={t("extSearch")}
            value={q}
            onInput={(e) => setQ(value(e))}
          />
        </label>
        <div class="wz-chips xw-kinds">
          {(phone ? CATEGORIES : (["", ...CATEGORIES] as const)).map((c) => (
            <button
              key={c}
              type="button"
              class={`wz-chip${kind === c ? " on" : ""}`}
              aria-pressed={kind === c}
              onClick={() => {
                setCategory(c);
                if (phone) setQ("");
              }}
            >
              {t(c ? `extCat_${c}` : "extCatAll")}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && <p class="wz-subl">{t("extNothingFound")}</p>}
      <div class="wz-brain xw-grid xw-cat">
        {shown.map((e) => (
          <Tile
            key={e.id}
            on={added.has(e.id)}
            icon={serviceIcon(e)}
            title={e.name}
            badge={e.official ? t("extOfficial") : undefined}
            text={e.description[lang.value]}
            state={added.has(e.id) ? t("extAdded") : undefined}
            onClick={() => setOpen(e)}
          />
        ))}
      </div>
      {open && (
        <Modal title={open.name} onClose={() => setOpen(undefined)}>
          <div class="wz-panel-in">
            <p class="wz-lead2">{open.description[lang.value]}</p>
            <Facts
              rows={[
                [t("xwSource"), t(open.official ? "extOfficial" : "extCommunity")],
                [
                  t("xwSignIn"),
                  `${t(authLabel(open.auth.type))}${open.unverified ? ` · ${t("extUnverifiedShort")}` : ""}`,
                ],
              ]}
            />
            <a class="wz-link inl" href={open.homepage} target="_blank" rel="noreferrer">
              {t("extMore")}
            </a>
            {added.has(open.id) ? (
              <>
                <p class="notice ok">{t("extAdded")}</p>
                <Acts>
                  <button type="button" class="wz-btn primary" onClick={() => setOpen(undefined)}>
                    {t("wzDoneBtn")}
                  </button>
                </Acts>
              </>
            ) : (
              <AddForm
                entry={open}
                onCancel={() => setOpen(undefined)}
                onDone={(signingIn) => {
                  setOpen(undefined);
                  onAdded(signingIn);
                }}
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** A service's state in words, for its square and its window. */
function serviceState(s: McpStatus | undefined): string {
  if (!s) return t("extChecking");
  if (s.state === "connected") return t("extWorks", { n: String(s.tools) });
  if (s.state === "login") return t("extNeedsLogin");
  return t("extBroken");
}

/** The servers added: lit when they work; each window signs in or removes it. */
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
  const [open, setOpen] = useState<string>();
  if (mcp.length === 0) return null;
  const connect = async (name: string) => {
    setError(undefined);
    try {
      onChange(!(await signIn(name)));
    } catch (err) {
      setError(explain(err));
    }
  };
  const m = mcp.find((x) => x.name === open);
  const s = status?.find((x) => x.name === open);
  const entry = MCP_CATALOG.find((e) => e.id === open);
  const close = () => {
    setOpen(undefined);
    setError(undefined);
  };
  return (
    <>
      <Sub title={t("extConnected")} lead={t("xwConnectedLead")} />
      <div class="wz-brain xw-grid">
        {mcp.map((x) => {
          const st = status?.find((y) => y.name === x.name);
          const e = MCP_CATALOG.find((y) => y.id === x.name);
          return (
            <Tile
              key={x.name}
              on={st?.state === "connected"}
              icon={e ? serviceIcon(e) : <IconServer />}
              title={e?.name ?? x.name}
              badge={st?.state === "error" ? t("extBroken") : undefined}
              text={scopeLabel(x.project_id)}
              state={serviceState(st)}
              onClick={() => setOpen(x.name)}
            />
          );
        })}
      </div>
      {status?.some((x) => x.state === "error") && <p class="wz-subl">{t("extBrokenHelp")}</p>}
      {m && (
        <Modal title={entry?.name ?? m.name} onClose={close}>
          <div class="wz-panel-in">
            <Facts
              rows={[
                [t("scope"), scopeLabel(m.project_id)],
                [t("xwState"), serviceState(s)],
                [
                  t("xwAddress"),
                  <code key="a">
                    {m.transport.type === "http"
                      ? m.transport.url
                      : [m.transport.command, ...(m.transport.args ?? [])].join(" ")}
                  </code>,
                ],
              ]}
            />
            {s?.state === "error" && s.error && <p class="notice error">{s.error}</p>}
            {s?.state === "error" && <p class="ui-help">{t("extBrokenHelp")}</p>}
            {error && <p class="notice error">{error}</p>}
          </div>
          <Acts>
            <button
              type="button"
              class="wz-btn quiet xw-danger"
              onClick={() =>
                void attempt(() => getApi().removeMcp(m.name)).then(() => {
                  close();
                  onChange();
                })
              }
            >
              {t("remove")}
            </button>
            {s?.state === "login" ? (
              <button type="button" class="wz-btn primary" onClick={() => void connect(m.name)}>
                {t("extConnect")}
              </button>
            ) : (
              <button type="button" class="wz-btn primary" onClick={close}>
                {t("wzDoneBtn")}
              </button>
            )}
          </Acts>
        </Modal>
      )}
    </>
  );
}

const MEDIA_ICON: Record<MediaKind, () => JSX.Element> = {
  image: () => <IconCanvas />,
  video: () => <IconPlay />,
  speech: () => <IconMic />,
  music: () => <IconSpark />,
  sound: () => <IconBell />,
};

/** The agents' tools that make pictures, video and sound (G25.3): one square per kind. */
function MediaTiles() {
  const [s, setS] = useState<SetupState | null>(null);
  const [open, setOpen] = useState<MediaKind>();
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  const stateOf = (kind: MediaKind) => {
    const saved = s.config.media?.[kind];
    if (!saved) return undefined;
    const p = mediaProvider(saved.provider);
    if (!(s.secretsSet.media?.includes(saved.provider) ?? false)) return t("mediaNeedsKey");
    const model = p?.models[kind]?.find((m) => m.id === saved.model)?.label ?? saved.model;
    return `${p?.name ?? saved.provider} · ${model}`;
  };
  const ready = (kind: MediaKind) => {
    const saved = s.config.media?.[kind];
    return !!saved && (s.secretsSet.media?.includes(saved.provider) ?? false);
  };
  return (
    <>
      <Sub title={t("mediaTitle")} lead={t("mediaPurpose")} />
      <div class="wz-brain xw-grid">
        {MEDIA_KINDS.filter((k) => MEDIA_PROVIDERS.some((p) => p.models[k]?.length)).map((k) => (
          <Tile
            key={k}
            on={ready(k)}
            icon={MEDIA_ICON[k]()}
            title={t(`media_${k}`)}
            text={t(`media_${k}_help`)}
            state={stateOf(k)}
            onClick={() => setOpen(k)}
          />
        ))}
      </div>
      {open && (
        <Modal title={t(`media_${open}`)} onClose={() => setOpen(undefined)}>
          <div class="wz-panel-in xw-media">
            <KindRow kind={open} s={s} onChange={load} />
          </div>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setOpen(undefined)}>
              {t("wzDoneBtn")}
            </button>
          </Acts>
        </Modal>
      )}
    </>
  );
}

/** A skill written by hand: its name, what it is for, where it works, its instructions. */
function NewSkill({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
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
    <form class="xw-form" onSubmit={(e) => void submit(e)}>
      <Field label={t("name")} help={t("xwSkillNameHelp")}>
        <input
          class="wz-field mono"
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}"
          value={name}
          onInput={(e) => setName(value(e))}
        />
      </Field>
      <Field label={t("description")}>
        <input
          class="wz-field"
          required
          minLength={10}
          value={description}
          onInput={(e) => setDescription(value(e))}
        />
      </Field>
      <Field label={t("scope")}>
        <select class="wz-field" value={scope} onChange={(e) => setScope(value(e))}>
          <option value="">{t("scopePlatform")}</option>
          {projectOptions(
            (id) => id,
            (n) => n,
          )}
        </select>
      </Field>
      <Field label={t("instructions")}>
        <textarea
          class="wz-field"
          required
          minLength={20}
          rows={7}
          value={body}
          onInput={(e) => setBody(value(e))}
        />
      </Field>
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary">
          {t("create")}
        </button>
      </Acts>
    </form>
  );
}

/** A server not in the catalog: its address (or command), and how it signs in. */
function McpForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
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
    <form class="xw-form" onSubmit={(e) => void submit(e)}>
      <Field label={t("name")}>
        <input
          class="wz-field mono"
          required
          pattern="[a-z0-9][a-z0-9-]{0,30}"
          value={name}
          onInput={(e) => setName(value(e))}
        />
      </Field>
      <Field label={t("scope")}>
        <select class="wz-field" value={scope} onChange={(e) => setScope(value(e))}>
          <option value="">{t("scopePlatform")}</option>
          {projectOptions(
            (id) => id,
            (n) => n,
          )}
        </select>
      </Field>
      <span class="wz-lb">{t("extTransport")}</span>
      <Seg
        label={t("extTransport")}
        value={type}
        onChange={setType}
        options={[
          ["http", t("extTransportHttp")],
          ["stdio", t("extTransportStdio")],
        ]}
      />
      {type === "http" ? (
        <>
          <Field label={t("url")}>
            <input
              class="wz-field"
              required
              type="url"
              value={url}
              onInput={(e) => setUrl(value(e))}
            />
          </Field>
          <SwitchRow title={t("extManualOauth")} on={oauth} onChange={setOauth} />
          {!oauth && (
            <Field label={t("extManualToken")}>
              <input
                class="wz-field mono"
                type="password"
                autocomplete="off"
                value={token}
                onInput={(e) => setToken(value(e))}
              />
            </Field>
          )}
        </>
      ) : (
        <>
          <Field label={t("command")}>
            <input
              class="wz-field mono"
              required
              value={command}
              onInput={(e) => setCommand(value(e))}
            />
          </Field>
          <Field label={t("args")}>
            <input class="wz-field mono" value={args} onInput={(e) => setArgs(value(e))} />
          </Field>
        </>
      )}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary">
          {t("addServer")}
        </button>
      </Acts>
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
function ImportSkill({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
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
    <div class="xw-form">
      <p class="wz-lead2">{t("skillImportHelp")}</p>
      <Field label={t("skillImportWhere")}>
        <select class="wz-field" value={scope} onChange={(e) => setScope(value(e))}>
          <option value="platform">{t("scopePlatform")}</option>
          {projectOptions(
            (id) => `project:${id}`,
            (n) => n,
          )}
        </select>
      </Field>
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
      {done && <p class="notice ok">{t("skillImported", { name: done })}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onClose}>
          {done ? t("wzDoneBtn") : t("cancel")}
        </button>
        <button type="button" class="wz-btn primary" onClick={() => picker.current?.click()}>
          <IconUpload size={18} /> {t("skillImportFile")}
        </button>
      </Acts>
    </div>
  );
}

/** A skill or tool installed: what it is, where it works; open its file or download it. */
function InstalledView({ x, onClose }: { x: Installed; onClose: () => void }) {
  return (
    <Modal title={x.name} onClose={onClose}>
      <div class="wz-panel-in">
        <p class="wz-lead2">{x.description}</p>
        <Facts
          rows={[
            [t("xwKind"), t(x.kind === "tool" ? "extKindTool" : "extKindSkill")],
            [t("scope"), x.scope === "platform" ? t("scopePlatform") : x.scope.slice(8)],
            [t("xwFile"), <code key="p">{x.path}</code>],
          ]}
        />
        {x.kind === "skill" && <p class="ui-help">{t("skillDownloadHelp")}</p>}
      </div>
      <Acts>
        {x.kind === "skill" && (
          <button type="button" class="wz-btn" onClick={() => void downloadSkill(x)}>
            <IconDownload size={18} /> {t("skillDownload")}
          </button>
        )}
        <button
          type="button"
          class="wz-btn primary"
          onClick={() => {
            openTab({
              id: `edit:${x.scope}:${x.path}`,
              type: "editor",
              title: x.name,
              scope: x.scope,
              path: x.path,
            });
            onClose();
          }}
        >
          <IconPencil size={18} /> {t("xwOpenFile")}
        </button>
      </Acts>
    </Modal>
  );
}

/** What is open on the page: a proposal, a skill installed, or one of the hand-made forms. */
type Open =
  | { proposal: Proposal }
  | { installed: Installed }
  | "import"
  | "skill"
  | "server"
  | "failed";

/** Abilities for the agents: ask God, what waits, what is connected, the catalog, the rest. */
export function Extensions() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [mcp, setMcp] = useState<McpEntry[]>([]);
  const [status, setStatus] = useState<McpStatus[]>();
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Open | null>(null);
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
  const close = () => setOpen(null);
  const doneAndClose = () => {
    close();
    reload();
  };
  const proposalTile = (p: Proposal, waiting: boolean) => (
    <Tile
      key={p.id}
      on={false}
      icon={p.kind === "tool" ? <IconTool /> : <IconBook />}
      title={p.name}
      badge={t(p.kind === "tool" ? "extKindTool" : "extKindSkill")}
      text={p.input.spec?.description ?? p.input.description ?? ""}
      state={
        waiting
          ? `${t("xwWaitsYou")} · ${t("by")} ${who(p.author)}`
          : `${t("xwTestsFailed")} · ${t("by")} ${who(p.author)}`
      }
      onClick={() => setOpen({ proposal: p })}
    />
  );
  return (
    <WzPage
      class="xw-page"
      after={
        <>
          {open && typeof open === "object" && "proposal" in open && (
            <ProposalView p={open.proposal} onDone={reload} onClose={close} />
          )}
          {open && typeof open === "object" && "installed" in open && (
            <InstalledView x={open.installed} onClose={close} />
          )}
          {open === "import" && (
            <Modal title={t("skillImport")} onClose={close}>
              <ImportSkill onDone={reload} onClose={close} />
            </Modal>
          )}
          {open === "skill" && (
            <Modal wide title={t("newSkill")} onClose={close}>
              <NewSkill onDone={doneAndClose} onCancel={close} />
            </Modal>
          )}
          {open === "server" && (
            <Modal title={t("addServer")} onClose={close}>
              <McpForm onDone={doneAndClose} onCancel={close} />
            </Modal>
          )}
          {open === "failed" && (
            <Modal wide title={t("failedTests")} onClose={close}>
              <div class="wz-panel-in">
                <p class="wz-lead2">{t("xwFailedLead")}</p>
                <div class="wz-brain xw-grid xw-failed">
                  {failed.map((p) => proposalTile(p, false))}
                </div>
              </div>
              <Acts>
                <button type="button" class="wz-btn primary" onClick={close}>
                  {t("wzDoneBtn")}
                </button>
              </Acts>
            </Modal>
          )}
        </>
      }
    >
      <Head eyebrow={t("extensions")} q={t("extAskTitle")} lead={t("extAskHelp")} />
      <AskGod />

      {pending.length > 0 && (
        <>
          <Sub title={t("extProposals")} lead={t("extProposalsHelp")} />
          <div class="wz-brain xw-grid xw-wait">{pending.map((p) => proposalTile(p, true))}</div>
        </>
      )}

      <Connected mcp={mcp} status={status} onChange={reload} />
      <MediaTiles />
      <Catalog added={new Set(mcp.map((m) => m.name))} onAdded={reload} />

      {installed.length > 0 && (
        <>
          <Sub title={t("extSkills")} lead={t("extSkillsHelp")} />
          <div class="wz-brain xw-grid">
            {installed.map((x) => (
              <Tile
                key={`${x.scope}:${x.kind}:${x.name}`}
                on
                icon={x.kind === "tool" ? <IconTool /> : <IconBook />}
                title={x.name}
                badge={t(x.kind === "tool" ? "extKindTool" : "extKindSkill")}
                text={x.description}
                state={x.scope === "platform" ? t("scopePlatform") : x.scope.slice(8)}
                onClick={() => setOpen({ installed: x })}
              />
            ))}
          </div>
        </>
      )}

      <Sub title={t("xwOwnTitle")} lead={t("xwOwnLead")} />
      <div class="wz-brain xw-grid">
        <Tile
          on={false}
          icon={<IconUpload />}
          title={t("skillImport")}
          text={t("xwImportText")}
          onClick={() => setOpen("import")}
        />
        <Tile
          on={false}
          icon={<IconPlus />}
          title={t("newSkill")}
          text={t("xwNewSkillText")}
          onClick={() => setOpen("skill")}
        />
        <Tile
          on={false}
          icon={<IconServer />}
          title={t("addServer")}
          text={t("xwServerText")}
          onClick={() => setOpen("server")}
        />
      </div>
      {failed.length > 0 && (
        <p class="wz-more">
          <button type="button" class="wz-link" onClick={() => setOpen("failed")}>
            <IconShield size={16} /> {t("failedTests")} ({failed.length})
          </button>
        </p>
      )}
    </WzPage>
  );
}
