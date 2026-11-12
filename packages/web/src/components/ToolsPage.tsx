// The tools page (G34.5, the person: «mi serve una pagina di tools comuni a tutti gli agenti in cui
// posso attivare e disattivare i tools»): every common tool in groups, with what it does and what
// it weighs on every message, and a switch for every agent. The essential ones keep a locked switch
// and say why. On top, the weight now and what the switched off ones save. New conversations only.
import type { ToolGroup, ToolsView, ToolView } from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Installed } from "../api.js";
import { type Key, lang, t } from "../i18n.js";
import {
  IconBook,
  IconCanvas,
  IconChat,
  IconFile,
  IconGlobe,
  IconInfo,
  IconKey,
  IconLayers,
  IconLock,
  IconMail,
  IconPuzzle,
  IconSearch,
  IconUsers,
} from "../icons.js";
import { getApi, openTab } from "../state.js";
import { Head, Switch, WzPage } from "./SettingsKit.js";

const GROUP_ICON: Record<ToolGroup, () => JSX.Element> = {
  files: () => <IconFile size={20} />,
  web: () => <IconGlobe size={20} />,
  memory: () => <IconBook size={20} />,
  credentials: () => <IconKey size={20} />,
  canvas: () => <IconCanvas size={20} />,
  mail: () => <IconMail size={20} />,
  talk: () => <IconChat size={20} />,
  agents: () => <IconUsers size={20} />,
  platform: () => <IconLayers size={20} />,
};

/** A tool's readable name, what it does and, if essential, why. */
export const toolName = (id: string) => t(`tool_${id}` as Key);
export const toolDoes = (id: string) => t(`toolDo_${id}` as Key);
export const toolWhy = (id: string) => t(`toolWhy_${id}` as Key);

/** Tokens rounded as people say them («circa 320»), in the interface's language. */
export const aboutTokens = (n: number) =>
  (n < 20 ? n : Math.round(n / 10) * 10).toLocaleString(lang.value === "it" ? "it-IT" : "en-US");

/** The entries in their groups, in the catalog's order. */
export function byGroup(entries: ToolView[]): [ToolGroup, ToolView[]][] {
  const out = new Map<ToolGroup, ToolView[]>();
  for (const e of entries) out.set(e.group, [...(out.get(e.group) ?? []), e]);
  return [...out];
}

/** A group's heading, with its drawn icon. */
export const GroupHead = ({ group }: { group: ToolGroup }) => (
  <h2 class="wz-sub tl-group">
    <span class="tl-group-ico">{GROUP_ICON[group]()}</span>
    {t(`toolGrp_${group}` as Key)}
  </h2>
);

/** One tool's words: name, what it does, its weight, and why it is always on. */
export function ToolText({ e }: { e: ToolView }) {
  return (
    <div class="tl-text">
      <div class="tl-name">
        <b>{toolName(e.id)}</b>
        {/* The real name (p3.5.3): the one in the chat's lines and in request_tool. */}
        <code class="tl-id">{e.id}</code>
      </div>
      <span>{toolDoes(e.id)}</span>
      <small class="tl-weight">{t("toolsWeight", { n: aboutTokens(e.tokens) })}</small>
      {e.essential && (
        <small class="tl-needed">
          <IconLock size={14} /> {t("toolsNeeded", { why: toolWhy(e.id) })}
        </small>
      )}
    </div>
  );
}

/** Lower case without accents, for a search that ignores both. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The entries a search finds: by the name in words, the real name and what it does. */
export function findTools(entries: ToolView[], q: string): ToolView[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((e) => {
    const text = fold(`${toolName(e.id)} ${e.id} ${e.id.replace(/_/g, " ")} ${toolDoes(e.id)}`);
    return words.every((w) => text.includes(w));
  });
}

/** The search on top of the tools (p3.5.3), with its drawn icon. */
export function ToolSearch({ q, onChange }: { q: string; onChange: (q: string) => void }) {
  return (
    <label class="tl-search">
      <IconSearch size={18} />
      <input
        class="wz-field"
        type="search"
        value={q}
        placeholder={t("toolsSearch")}
        aria-label={t("toolsSearch")}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

/** The tools in their groups, as a search leaves them (groups without any go), or a line. */
export function ToolGroups({
  entries,
  q,
  row,
}: {
  entries: ToolView[];
  q: string;
  row: (e: ToolView) => JSX.Element;
}) {
  const found = findTools(entries, q);
  if (found.length === 0) return <p class="tl-none">{t("toolsNoMatch", { q: q.trim() })}</p>;
  return (
    <>
      {byGroup(found).map(([group, list]) => (
        <section class="tl-section" key={group}>
          <GroupHead group={group} />
          <div class="tl-list">{list.map(row)}</div>
        </section>
      ))}
    </>
  );
}

/** The note every view of the tools carries: new conversations only. */
export const NewOnly = () => (
  <p class="tl-note">
    <IconInfo size={18} /> {t("toolsNewOnly")}
  </p>
);

/**
 * The agents that differ from the switch for every agent (3.5.3: a tool switched off here stayed on
 * for God through its own choice, and nothing said so), with a way back to the rule for everyone.
 */
function Exceptions({ e, busy, onReset }: { e: ToolView; busy: boolean; onReset: () => void }) {
  const names = (e.exceptions ?? []).map((x) => x.name).join(", ");
  return (
    <p class="tl-except">
      <IconInfo size={14} />
      <span>{t(e.global ? "toolsExceptOff" : "toolsExceptOn", { names })}</span>
      <button type="button" class="link" disabled={busy} onClick={onReset}>
        {t("toolsExceptReset")}
      </button>
    </p>
  );
}

/** Reads a tools view, and reads it again after a change. */
export function useToolsView(agentId?: string) {
  const [view, setView] = useState<ToolsView>();
  const [error, setError] = useState<string>();
  const load = () =>
    getApi()
      .toolsView(agentId)
      .then(
        (v) => {
          setView(v);
          setError(undefined);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
  useEffect(() => {
    void load();
  }, [agentId]);
  return { view, setView, error, setError, load };
}

/** Settings, Tools: the switches for every agent. */
export function ToolsPage() {
  const { view, setView, error, setError, load } = useToolsView();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const flip = async (e: ToolView, on: boolean) => {
    if (!view || e.essential) return;
    const off = view.entries
      .filter((x) => !x.essential && (x.id === e.id ? !on : !x.global))
      .map((x) => x.id);
    // Lit at once; the server's answer follows.
    const entries = view.entries.map((x) => (x.id === e.id ? { ...x, global: on } : x));
    const total = entries.filter((x) => x.global).reduce((n, x) => n + x.tokens, 0);
    const saved = entries.filter((x) => !x.global).reduce((n, x) => n + x.tokens, 0);
    setView({ ...view, entries, total, saved });
    setBusy(true);
    try {
      await getApi().setToolsOff(off);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  };
  // An agent's own choice back to the rule for everyone (3.5.3).
  const reset = async (e: ToolView) => {
    setBusy(true);
    try {
      for (const x of e.exceptions ?? [])
        await getApi().setAgentTools(x.agentId, { [e.id]: "default" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  };
  return (
    <WzPage class="tl-page">
      <Head eyebrow={t("toolsSection")} q={t("toolsQ")} lead={t("toolsLead")} />
      {error && <p class="tl-error">{t("toolsError", { error })}</p>}
      {!view && !error && <p class="tl-loading">{t("toolsLoading")}</p>}
      {view && (
        <>
          <div class="tl-sum">
            <div class="tl-sum-box">
              <b>{t("toolsTotal", { n: aboutTokens(view.total) })}</b>
              <span>
                {t("toolsHowMany", {
                  on: String(view.entries.filter((e) => e.global).length),
                  all: String(view.entries.length),
                })}
              </span>
            </div>
            <div class={`tl-sum-box${view.saved > 0 ? " on" : ""}`}>
              <b>
                {view.saved > 0
                  ? t("toolsSaved", { n: aboutTokens(view.saved) })
                  : t("toolsNoneSaved")}
              </b>
            </div>
          </div>
          <NewOnly />
          <ToolSearch q={q} onChange={setQ} />
          <ToolGroups
            entries={view.entries}
            q={q}
            row={(e) => (
              <div
                key={e.id}
                class={`tl-row${e.global ? " on" : ""}${e.essential ? " locked" : ""}`}
                data-tool={e.id}
              >
                <div class="tl-main">
                  <ToolText e={e} />
                  {e.exceptions?.length ? (
                    <Exceptions e={e} busy={busy} onReset={() => void reset(e)} />
                  ) : null}
                </div>
                <Switch
                  on={e.global}
                  label={toolName(e.id)}
                  disabled={e.essential || busy}
                  onChange={(on) => void flip(e, on)}
                />
              </div>
            )}
          />
          <ExtensionTools />
        </>
      )}
    </WzPage>
  );
}

/**
 * The tools the extensions installed (G38.3: a magic integration's among them): every agent has
 * them, outside the switches of the common tools; they are changed or removed in Extensions.
 */
function ExtensionTools() {
  const [list, setList] = useState<Installed[]>([]);
  useEffect(() => {
    void getApi()
      .installed()
      .then(
        (l) => setList(Array.isArray(l) ? l.filter((x) => x.kind === "tool") : []),
        () => setList([]),
      );
  }, []);
  if (list.length === 0) return null;
  return (
    <section class="tl-ext">
      <h2 class="wz-sub tl-group">
        <span class="tl-group-ico">
          <IconPuzzle size={20} />
        </span>
        {t("tlExtTitle")}
      </h2>
      <p class="wz-subl">{t("tlExtLead")}</p>
      {list.map((x) => (
        <div key={`${x.scope}:${x.name}`} class="tl-row on" data-tool={x.name}>
          <div class="tl-main">
            <div class="tl-text">
              <div class="tl-name">
                <b>{x.name}</b>
                <code class="tl-id">{x.name}</code>
              </div>
              <span>{x.description}</span>
            </div>
          </div>
        </div>
      ))}
      <p class="wz-more">
        <button
          type="button"
          class="wz-link"
          onClick={() =>
            openTab({
              id: "settings",
              type: "settings",
              title: t("settings"),
              section: "extensions",
            })
          }
        >
          {t("tlExtOpen")}
        </button>
      </p>
    </section>
  );
}
