// Settings › Knowledge (G36.5–G36.6): the person's documents the agents can search. In the
// wizard's look and in plain words: what is ready and how long the rest takes (a real bar), the
// collections with their sources (a folder, a file, a web page, a project, a mailbox, the
// conversations), a box to try a search, the model that reads by meaning and the one that
// reorders (downloaded here with their bar), the OCR for pictures and scans, what it all takes
// on disk, whether the backup carries it, and «Rebuild». Who a collection is for (everyone, one
// agent, one project) is chosen with it; each agent's own exceptions are in its window.
import {
  EMBEDDING_API_URLS,
  type EmbeddingChoice,
  type Job,
  type KnowledgeCollection,
  type KnowledgeDisk,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeScope,
  type KnowledgeSearchResult,
  type KnowledgeSource,
  type KnowledgeSourceInput,
  type KnowledgeStatus,
} from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type KnowledgeModels } from "../api.js";
import { bytes } from "../format.js";
import { lang, t, tOptional } from "../i18n.js";
import {
  IconBox,
  IconChat,
  IconCloud,
  IconCpu,
  IconDatabase,
  IconFile,
  IconFolder,
  IconGlobe,
  IconImage,
  IconMail,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "../icons.js";
import { agents, citationNote, getApi, openCitation, projects } from "../state.js";
import {
  Acts,
  Box,
  BoxButton,
  Chips,
  Facts,
  Head,
  Row,
  Seg,
  Slider,
  Sub,
  SwitchRow,
  Tile,
  Tiles,
  WzPage,
} from "./SettingsKit.js";
import { Advanced, Field, JobView, Modal, Progress } from "./ui.js";

const num = (n: number) => n.toLocaleString(lang.value === "it" ? "it-IT" : "en-US");

/** The server's reason in plain words, or its message. */
const why = (err: unknown) =>
  (err instanceof ApiError && err.code && tOptional(`kbErr_${err.code}`)) || (err as Error).message;

/** Who a collection is for, in words. */
export function scopeWords(s: KnowledgeScope): string {
  if (s.kind === "agent")
    return t("kbForAgent", {
      name: agents.value.find((a) => a.id === s.agentId)?.name ?? s.agentId,
    });
  if (s.kind === "project")
    return t("kbForProject", {
      name: projects.value.find((p) => p.id === s.projectId)?.name ?? s.projectId,
    });
  return t("kbForAll");
}

/** What a source reads, in words. */
function sourceWords(s: KnowledgeSource["spec"]): { icon: JSX.Element; what: string } {
  switch (s.kind) {
    case "folder":
      return { icon: <IconFolder size={20} />, what: s.path };
    case "workspace": {
      const id = s.scope.startsWith("project:") ? s.scope.slice(8) : s.scope;
      const name = projects.value.find((p) => p.id === id)?.name ?? id;
      return {
        icon: <IconBox size={20} />,
        what: t("kbSrcProjectOf", { name }) + (s.path && s.path !== "." ? ` · ${s.path}` : ""),
      };
    }
    case "file":
      return { icon: <IconFile size={20} />, what: s.path };
    case "url":
      return { icon: <IconGlobe size={20} />, what: s.url };
    case "mail":
      return {
        icon: <IconMail size={20} />,
        what: t("kbSrcMailOf", { days: String(s.days ?? 365) }),
      };
    case "chats":
      return {
        icon: <IconChat size={20} />,
        what: s.agents?.length
          ? t("kbSrcChatsOf", {
              names: s.agents
                .map((id) => agents.value.find((a) => a.id === id)?.name ?? id)
                .join(", "),
              days: String(s.days ?? 365),
            })
          : t("kbSrcChatsAll", { days: String(s.days ?? 365) }),
      };
  }
}

/** Downloads of the knowledge running now (models, the OCR, pgvector), followed every second. */
function useDownloads(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const all = await getApi()
        .jobs()
        .catch(() => [] as Job[]);
      if (stop) return;
      const mine = all.filter(
        (j) =>
          ["download_knowledge_model", "download_ocr", "download_pgvector"].includes(j.kind) &&
          (j.state === "running" || Date.now() - Date.parse(j.endedAt ?? j.startedAt) < 15_000),
      );
      setJobs(mine);
      timer = setTimeout(() => void tick(), mine.some((j) => j.state === "running") ? 1000 : 4000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);
  return jobs;
}

/** Settings › Knowledge. */
export function Knowledge() {
  const [st, setSt] = useState<KnowledgeStatus>();
  const [cols, setCols] = useState<KnowledgeCollection[]>([]);
  const [models, setModels] = useState<KnowledgeModels>();
  const [disk, setDisk] = useState<KnowledgeDisk>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const jobs = useDownloads();
  const load = async () => {
    try {
      const [s, c] = await Promise.all([
        getApi().knowledgeStatus(),
        getApi().knowledgeCollections(),
      ]);
      setSt(s);
      setCols(c.collections);
      setError(undefined);
    } catch (err) {
      setError(why(err));
    }
  };
  useEffect(() => {
    void load();
    void getApi()
      .knowledgeModels()
      .then(setModels, () => {});
    void getApi()
      .knowledgeDisk()
      .then(setDisk, () => {});
    // While it works, the page follows it.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
      await load();
      void getApi()
        .knowledgeModels()
        .then(setModels, () => {});
      return true;
    } catch (err) {
      setError(why(err));
      return false;
    }
  };
  if (!st)
    return (
      <WzPage class="kb-page">
        <Head eyebrow={t("kbSection")} q={t("kbQ")} />
        {error ? <p class="kb-error">{error}</p> : <p class="wz-loading">{t("kbLoading")}</p>}
      </WzPage>
    );
  const shown = cols.find((c) => c.id === open);
  return (
    <WzPage
      class="kb-page"
      after={
        <>
          {shown && (
            <CollectionWindow
              c={shown}
              onClose={() => {
                setOpen(null);
                void load();
              }}
              onChanged={load}
            />
          )}
          {making && (
            <NewCollection
              onClose={(id) => {
                setMaking(false);
                void load().then(() => id && setOpen(id));
              }}
            />
          )}
          {rebuilding && (
            <Modal title={t("kbRebuildQ")} onClose={() => setRebuilding(false)}>
              <p class="kb-p">{t("kbRebuildText")}</p>
              <Acts>
                <button type="button" class="wz-btn" onClick={() => setRebuilding(false)}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  class="wz-btn primary"
                  onClick={() => {
                    setRebuilding(false);
                    void run(() => getApi().rebuildKnowledge());
                  }}
                >
                  {t("kbRebuild")}
                </button>
              </Acts>
            </Modal>
          )}
        </>
      }
    >
      <Head eyebrow={t("kbSection")} q={t("kbQ")} lead={t("kbLead")} />
      {error && (
        <p class="kb-error" role="alert">
          {error}
        </p>
      )}
      <StatusPart st={st} jobs={jobs} onPause={(p) => run(() => getApi().pauseKnowledge(p))} />

      <Sub title={t("kbColsTitle")} lead={t("kbColsLead")} />
      <div class="kb-cols">
        {cols.map((c) => (
          <BoxButton
            key={c.id}
            title={c.name}
            pill={scopeWords(c.scope)}
            onClick={() => setOpen(c.id)}
            label={t("kbOpenCollection", { name: c.name })}
          >
            <span class="sb-box-p">
              {t("kbColLine", { docs: num(c.documents), pieces: num(c.chunks) })}
            </span>
            {c.description && <span class="sb-box-p kb-dim">{c.description}</span>}
          </BoxButton>
        ))}
        <button type="button" class="kb-add" onClick={() => setMaking(true)}>
          <IconPlus size={22} />
          <span>{t("kbNewCollection")}</span>
        </button>
      </div>
      {cols.length === 0 && <p class="kb-p kb-dim">{t("kbNoCols")}</p>}

      <TryIt has={cols.length > 0} />

      {models && <ModelPart st={st} models={models} jobs={jobs} run={run} />}

      {models && <OcrPart st={st} models={models} jobs={jobs} run={run} />}

      <Sub title={t("kbDiskTitle")} lead={t("kbDiskLead")} />
      <Box>
        {disk ? (
          <Facts
            rows={[
              [t("kbDiskTexts"), bytes(disk.texts)],
              [t("kbDiskVectors"), bytes(disk.vectors)],
              [t("kbDiskModels"), bytes(disk.models)],
              [t("kbDiskOcr"), bytes(disk.ocr)],
              [
                t("kbDiskTotal"),
                <b key="t">{bytes(disk.texts + disk.vectors + disk.models + disk.ocr)}</b>,
              ],
            ]}
          />
        ) : (
          <p class="kb-dim">{t("kbLoading")}</p>
        )}
        <SwitchRow
          title={t("kbBackupVectors")}
          help={t("kbBackupVectorsHelp")}
          on={st.settings.backupVectors}
          onChange={(on) => void run(() => getApi().setKnowledgeSettings({ backupVectors: on }))}
        />
        <Row title={t("kbRebuild")} help={t("kbRebuildHelp")}>
          <button type="button" class="wz-btn" onClick={() => setRebuilding(true)}>
            <IconRefresh size={16} /> {t("kbRebuild")}
          </button>
        </Row>
      </Box>
    </WzPage>
  );
}

/** What is ready, what is left and how long it takes. */
function StatusPart({
  st,
  jobs,
  onPause,
}: {
  st: KnowledgeStatus;
  jobs: Job[];
  onPause: (paused: boolean) => void;
}) {
  const building = st.indexes.find((i) => i.state === "building");
  const active = st.indexes.find((i) => i.active);
  const filling = building ?? active;
  const left = st.queue.chunks;
  const model = st.settings.embedding;
  const busy = st.queue.documents > 0 || (filling ? filling.embedded < filling.total : false);
  let headline: string;
  if (!st.vector.ok) headline = t("kbStateNoVector");
  else if (!model) headline = t("kbStateNoModel");
  else if (st.chunks === 0) headline = t("kbStateEmpty");
  else if (busy && st.queue.paused) headline = t("kbStatePaused");
  else if (busy) headline = t("kbStateWorking");
  else headline = t("kbStateReady", { n: num(st.chunks) });
  const downloads = jobs.filter((j) => j.kind !== "download_ocr");
  return (
    <Box class={`kb-status${busy ? " busy" : ""}`}>
      <div class="kb-status-hd">
        <span class="kb-status-ico">
          <IconDatabase size={26} />
        </span>
        <div>
          <b class="kb-headline">{headline}</b>
          <span class="kb-dim">
            {t("kbStatusLine", {
              cols: num(st.collections),
              pieces: num(st.chunks),
            })}
          </span>
        </div>
      </div>
      {filling && filling.total > 0 && (
        <Progress
          unit="count"
          progress={{
            done: filling.embedded,
            total: filling.total,
            rate: st.queue.perMinute ? st.queue.perMinute / 60 : null,
            secondsLeft: st.queue.etaSeconds ?? null,
          }}
        />
      )}
      {building && active && (
        <p class="kb-p kb-dim">{t("kbNewIndex", { model: building.model })}</p>
      )}
      {st.queue.documents > 0 && (
        <p class="kb-p">{t("kbDocsWaiting", { n: num(st.queue.documents) })}</p>
      )}
      {left > 0 && !st.queue.etaSeconds && busy && <p class="kb-p kb-dim">{t("kbEtaSoon")}</p>}
      {st.queue.error && (
        <p class="kb-error" role="alert">
          {t("kbQueueError", { error: st.queue.error })}
        </p>
      )}
      {!st.vector.ok && (
        <Advanced label={t("uiDetails")}>
          <pre class="kb-pre">{st.vector.reason}</pre>
        </Advanced>
      )}
      {downloads.map((j) => (
        <JobView key={j.id} job={j} />
      ))}
      {model && (
        <SwitchRow
          title={t("kbPause")}
          help={t("kbPauseHelp")}
          on={st.queue.paused}
          onChange={onPause}
        />
      )}
    </Box>
  );
}

/** A new collection: its name and who it is for. */
function NewCollection({ onClose }: { onClose: (id?: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<KnowledgeScope>({ kind: "all" });
  const [error, setError] = useState<string>();
  const make = async () => {
    try {
      const c = await getApi().createKnowledgeCollection({ name: name.trim(), scope });
      onClose(c.id);
    } catch (err) {
      setError(why(err));
    }
  };
  return (
    <Modal title={t("kbNewCollection")} onClose={() => onClose()}>
      <div class="wz-panel-in kb-form">
        <Field label={t("kbColName")} help={t("kbColNameHelp")}>
          <input
            class="wz-field"
            value={name}
            maxLength={120}
            placeholder={t("kbColNameExample")}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Field>
        <ScopePick scope={scope} onChange={setScope} />
        {error && <p class="kb-error">{error}</p>}
      </div>
      <Acts>
        <button type="button" class="wz-btn" onClick={() => onClose()}>
          {t("cancel")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={!name.trim()}
          onClick={() => void make()}
        >
          {t("kbMake")}
        </button>
      </Acts>
    </Modal>
  );
}

/** For whom: everyone, one agent, one project. */
function ScopePick({
  scope,
  onChange,
  label = true,
}: {
  scope: KnowledgeScope;
  onChange: (s: KnowledgeScope) => void;
  /** Its own small heading (the collection's window has a bigger one). */
  label?: boolean;
}) {
  const working = agents.value.filter((a) => a.kind !== "demigod" && a.kind !== "inspector");
  return (
    <div class="kb-scope">
      {label && <span class="wz-lb">{t("kbForWhom")}</span>}
      <Seg<KnowledgeScope["kind"]>
        label={t("kbForWhom")}
        value={scope.kind}
        vertical
        onChange={(k) =>
          onChange(
            k === "agent"
              ? { kind: "agent", agentId: working[0]?.id ?? "" }
              : k === "project"
                ? { kind: "project", projectId: projects.value[0]?.id ?? "" }
                : { kind: "all" },
          )
        }
        options={[
          ["all", t("kbScopeAll")],
          ["agent", t("kbScopeAgent")],
          ["project", t("kbScopeProject")],
        ]}
      />
      {scope.kind === "agent" && (
        <Chips
          options={working.map((a) => ({ id: a.id, label: a.name }))}
          value={[scope.agentId]}
          onChange={([id]) => id && onChange({ kind: "agent", agentId: id })}
        />
      )}
      {scope.kind === "project" &&
        (projects.value.length ? (
          <Chips
            options={projects.value.map((p) => ({ id: p.id, label: p.name }))}
            value={[scope.projectId]}
            onChange={([id]) => id && onChange({ kind: "project", projectId: id })}
          />
        ) : (
          <p class="kb-dim">{t("kbNoProjects")}</p>
        ))}
    </div>
  );
}

const REASONS = [
  "needs_ocr",
  "needs_libreoffice",
  "binary",
  "too_big",
  "empty",
  "unsupported",
  "encrypted",
] as const;

/** One collection: its sources, what could not be read, who it is for, and removing it. */
function CollectionWindow({
  c,
  onClose,
  onChanged,
}: {
  c: KnowledgeCollection;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [sources, setSources] = useState<KnowledgeSource[]>();
  const [left, setLeft] = useState<KnowledgeDocument[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [scope, setScope] = useState<KnowledgeScope>(c.scope);
  const [removing, setRemoving] = useState(false);
  const load = async () => {
    const [s, skipped, failed] = await Promise.all([
      getApi().knowledgeSources(c.id),
      getApi().knowledgeDocuments(c.id, "skipped", 50),
      getApi().knowledgeDocuments(c.id, "failed", 50),
    ]);
    setSources(s.sources);
    setLeft([...failed.documents, ...skipped.documents]);
  };
  useEffect(() => {
    void load().catch((err) => setError(why(err)));
    const timer = setInterval(() => void load().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [c.id]);
  const act = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
      await load();
      await onChanged();
    } catch (err) {
      setError(why(err));
    }
  };
  const sameScope = JSON.stringify(scope) === JSON.stringify(c.scope);
  if (removing)
    return (
      <Modal title={t("kbRemoveQ", { name: c.name })} onClose={() => setRemoving(false)}>
        <p class="kb-p">{t("kbRemoveText")}</p>
        <Acts>
          <button type="button" class="wz-btn" onClick={() => setRemoving(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary st-danger"
            onClick={() =>
              void getApi()
                .removeKnowledgeCollection(c.id)
                .then(onClose, (err) => setError(why(err)))
            }
          >
            {t("kbRemove")}
          </button>
        </Acts>
      </Modal>
    );
  return (
    <Modal
      wide
      title={c.name}
      sub={`${scopeWords(c.scope)} · ${t("kbColLine", { docs: num(c.documents), pieces: num(c.chunks) })}`}
      onClose={onClose}
      foot={
        <>
          <button type="button" class="wz-btn quiet st-danger" onClick={() => setRemoving(true)}>
            <IconTrash size={16} /> {t("kbRemove")}
          </button>
          <span class="spacer" />
          <button type="button" class="wz-btn primary" onClick={onClose}>
            {t("wzDoneBtn")}
          </button>
        </>
      }
    >
      <div class="kb-window">
        {error && (
          <p class="kb-error" role="alert">
            {error}
          </p>
        )}
        <h3 class="kb-h3">{t("kbSources")}</h3>
        {!sources && <p class="kb-dim">{t("kbLoading")}</p>}
        {sources?.length === 0 && <p class="kb-dim">{t("kbNoSources")}</p>}
        <ul class="kb-sources">
          {sources?.map((s) => {
            const w = sourceWords(s.spec);
            return (
              <li key={s.id} class={`kb-source ${s.state}`}>
                <span class="kb-source-ico">{w.icon}</span>
                <span class="kb-source-text">
                  <b>{w.what}</b>
                  <small>
                    {t(`kbSrcState_${s.state}`)} · {t("kbSrcDocs", { n: num(s.documents) })}
                    {s.error ? ` · ${s.error}` : ""}
                  </small>
                </span>
                <span class="kb-source-acts">
                  <button
                    type="button"
                    class="wz-btn small quiet"
                    aria-label={t("kbRescan")}
                    title={t("kbRescan")}
                    onClick={() => void act(() => getApi().rescanKnowledge(c.id, s.id))}
                  >
                    <IconRefresh size={16} />
                  </button>
                  <button
                    type="button"
                    class="wz-btn small quiet"
                    aria-label={t("kbRemoveSource")}
                    title={t("kbRemoveSource")}
                    onClick={() => void act(() => getApi().removeKnowledgeSource(c.id, s.id))}
                  >
                    <IconTrash size={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <button type="button" class="wz-btn" onClick={() => setAdding(true)}>
          <IconPlus size={16} /> {t("kbAddSource")}
        </button>

        {left.length > 0 && (
          <>
            <h3 class="kb-h3">{t("kbLeftOut", { n: String(left.length) })}</h3>
            <ul class="kb-left">
              {left.map((d) => (
                <li key={d.id}>
                  <span class="kb-left-path">{d.path}</span>
                  <small>
                    {d.state === "failed"
                      ? t("kbWhyFailed", { error: d.reason ?? "" })
                      : (REASONS as readonly string[]).includes(d.reason ?? "")
                        ? t(`kbWhy_${d.reason as (typeof REASONS)[number]}`)
                        : (d.reason ?? "")}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 class="kb-h3">{t("kbForWhom")}</h3>
        <ScopePick scope={scope} onChange={setScope} label={false} />
        {!sameScope && (
          <div class="st-save">
            <button
              type="button"
              class="wz-btn primary"
              onClick={() => void act(() => getApi().updateKnowledgeCollection(c.id, { scope }))}
            >
              {t("kbSaveScope")}
            </button>
          </div>
        )}
      </div>
      {adding && (
        <AddSource
          collection={c}
          onClose={(added) => {
            setAdding(false);
            if (added) void load().then(onChanged);
          }}
        />
      )}
    </Modal>
  );
}

type SourceKind = KnowledgeSourceInput["kind"];

/** Adding a source: what kind, then where (and, for mail and conversations, the person's yes). */
function AddSource({
  collection,
  onClose,
}: {
  collection: KnowledgeCollection;
  onClose: (added: boolean) => void;
}) {
  const [kind, setKind] = useState<SourceKind>("folder");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [project, setProject] = useState(projects.value[0]?.id ?? "");
  const [mailbox, setMailbox] = useState("");
  const [boxes, setBoxes] = useState<{ id: string; name: string }[]>();
  const [chatAgents, setChatAgents] = useState<string[]>([]);
  const [days, setDays] = useState(365);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getApi()
      .knowledgeMailboxes()
      .then((r) => {
        setBoxes(r.mailboxes);
        setMailbox(r.mailboxes[0]?.id ?? "");
      })
      .catch(() => setBoxes([]));
  }, []);
  const spec = (): KnowledgeSourceInput | undefined => {
    if (kind === "folder") return path.trim() ? { kind, path: path.trim() } : undefined;
    if (kind === "file") return path.trim() ? { kind, path: path.trim() } : undefined;
    if (kind === "url") return url.trim() ? { kind, url: url.trim() } : undefined;
    if (kind === "workspace") return project ? { kind, scope: `project:${project}` } : undefined;
    if (kind === "mail")
      return mailbox && consent ? { kind, mailbox, days, consent: true } : undefined;
    return consent ? { kind: "chats", agents: chatAgents, days, consent: true } : undefined;
  };
  const add = async () => {
    const s = spec();
    if (!s) return;
    setBusy(true);
    setError(undefined);
    try {
      await getApi().addKnowledgeSource(collection.id, s);
      onClose(true);
    } catch (err) {
      setError(why(err));
    } finally {
      setBusy(false);
    }
  };
  const tile = (k: SourceKind, icon: JSX.Element) => (
    <Tile
      key={k}
      on={kind === k}
      icon={icon}
      title={t(`kbKind_${k}`)}
      text={t(`kbKindText_${k}`)}
      onClick={() => {
        setKind(k);
        setConsent(false);
        setError(undefined);
      }}
    />
  );
  const people = agents.value.filter((a) => a.kind !== "inspector");
  return (
    <Modal
      wide
      title={t("kbAddSourceTo", { name: collection.name })}
      onClose={() => onClose(false)}
    >
      <div class="kb-window">
        <Tiles class="kb-kinds">
          {tile("folder", <IconFolder size={24} />)}
          {tile("file", <IconFile size={24} />)}
          {tile("url", <IconGlobe size={24} />)}
          {tile("workspace", <IconBox size={24} />)}
          {tile("mail", <IconMail size={24} />)}
          {tile("chats", <IconChat size={24} />)}
        </Tiles>
        <div class="kb-form">
          {(kind === "folder" || kind === "file") && (
            <Field
              label={kind === "folder" ? t("kbFolderPath") : t("kbFilePath")}
              help={kind === "folder" ? t("kbFolderHelp") : t("kbFileHelp")}
            >
              <input
                class="wz-field kb-mono"
                value={path}
                placeholder={kind === "folder" ? t("kbFolderExample") : t("kbFileExample")}
                onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          {kind === "url" && (
            <Field label={t("kbUrl")} help={t("kbUrlHelp")}>
              <input
                class="wz-field kb-mono"
                type="url"
                value={url}
                placeholder="https://"
                onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          {kind === "workspace" &&
            (projects.value.length ? (
              <>
                <span class="wz-lb">{t("kbWhichProject")}</span>
                <Chips
                  options={projects.value.map((p) => ({ id: p.id, label: p.name }))}
                  value={[project]}
                  onChange={([id]) => id && setProject(id)}
                />
              </>
            ) : (
              <p class="kb-dim">{t("kbNoProjects")}</p>
            ))}
          {kind === "mail" &&
            (boxes && boxes.length === 0 ? (
              <p class="kb-dim">{t("kbNoMailboxes")}</p>
            ) : (
              <>
                <span class="wz-lb">{t("kbWhichMailbox")}</span>
                <Chips
                  options={(boxes ?? []).map((b) => ({ id: b.id, label: b.name }))}
                  value={[mailbox]}
                  onChange={([id]) => id && setMailbox(id)}
                />
              </>
            ))}
          {kind === "chats" && (
            <>
              <span class="wz-lb">{t("kbWhichChats")}</span>
              <Chips
                multiple
                options={people.map((a) => ({ id: a.id, label: a.name }))}
                value={chatAgents}
                onChange={setChatAgents}
              />
              <p class="kb-dim">{chatAgents.length ? "" : t("kbAllChats")}</p>
            </>
          )}
          {(kind === "mail" || kind === "chats") && (
            <>
              <Slider
                label={t("kbHowFarBack")}
                value={days}
                min={30}
                max={1830}
                step={30}
                onChange={setDays}
                format={(d) => t("kbDays", { n: num(d) })}
              />
              <div class="kb-consent">
                <p>{kind === "mail" ? t("kbConsentMail") : t("kbConsentChats")}</p>
                <SwitchRow
                  title={kind === "mail" ? t("kbConsentMailYes") : t("kbConsentChatsYes")}
                  on={consent}
                  onChange={setConsent}
                />
              </div>
            </>
          )}
          {error && (
            <p class="kb-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <Acts>
        <button type="button" class="wz-btn" onClick={() => onClose(false)}>
          {t("cancel")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={!spec() || busy}
          onClick={() => void add()}
        >
          {t("kbAdd")}
        </button>
      </Acts>
    </Modal>
  );
}

/** The search as the agents do it, to see what they would find. */
function TryIt({ has }: { has: boolean }) {
  const [q, setQ] = useState("");
  const [r, setR] = useState<KnowledgeSearchResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setR(await getApi().knowledgeSearch({ query: q.trim(), limit: 8 }));
    } catch (err) {
      setError(why(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Sub title={t("kbTryTitle")} lead={t("kbTryLead")} />
      <Box class="kb-try">
        <form
          class="kb-try-form"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            class="wz-field"
            value={q}
            disabled={!has}
            placeholder={t("kbTryExample")}
            aria-label={t("kbTryTitle")}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="wz-btn primary" disabled={!has || busy || !q.trim()}>
            <IconSearch size={16} /> {t("kbTrySearch")}
          </button>
        </form>
        {error && <p class="kb-error">{error}</p>}
        {r && (
          <>
            <p class="kb-dim kb-try-how">
              {r.wordsOnly
                ? t("kbTryWordsOnly")
                : t("kbTryHow", { n: String(r.hits.length), ms: String(r.ms) })}
            </p>
            {r.hits.length === 0 && <p class="kb-p">{t("kbTryNothing")}</p>}
            <ol class="kb-hits">
              {r.hits.map((h) => (
                <Hit key={h.citation.chunkId} h={h} />
              ))}
            </ol>
          </>
        )}
      </Box>
    </>
  );
}

/** Where a piece is, in words: the file and its page or lines. */
export function placeWords(c: KnowledgeHit["citation"]): string {
  if (c.page) return t("kbPage", { n: String(c.page) });
  if (c.lineStart)
    return c.lineEnd && c.lineEnd !== c.lineStart
      ? t("kbLines", { a: String(c.lineStart), b: String(c.lineEnd) })
      : t("kbLine", { n: String(c.lineStart) });
  if (c.source === "mail") return t("kbMail");
  if (c.source === "chats") return t("kbChat");
  return "";
}

function Hit({ h }: { h: KnowledgeHit }) {
  const c = h.citation;
  const place = placeWords(c);
  return (
    <li class="kb-hit">
      <button type="button" class="kb-hit-btn" onClick={() => void openCitation(c.chunkId)}>
        <span class="kb-hit-title">
          <b>{c.title}</b>
          {place && <span class="kb-pill">{place}</span>}
        </span>
        {c.heading && <small class="kb-dim">{c.heading}</small>}
        <span class="kb-hit-text">{h.text.length > 320 ? `${h.text.slice(0, 318)}…` : h.text}</span>
      </button>
    </li>
  );
}

const CLOUD = ["openai", "voyage", "cohere", "gemini", "mistral", "jina", "compatible"] as const;
type Cloud = (typeof CLOUD)[number];

/** The model that reads by meaning, and the one that puts the best first. */
function ModelPart({
  st,
  models,
  jobs,
  run,
}: {
  st: KnowledgeStatus;
  models: KnowledgeModels;
  jobs: Job[];
  run: (f: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [cloud, setCloud] = useState(false);
  const e = st.settings.embedding;
  const r = st.settings.rerank;
  const downloading = (file: string) =>
    jobs.some((j) => j.state === "running" && j.vars.model === file);
  return (
    <>
      <Sub title={t("kbModelTitle")} lead={t("kbModelLead")} />
      <Tiles class="kb-models">
        {models.local.map((m) => (
          <Tile
            key={m.id}
            on={e?.provider === "local" && e.model === m.id}
            icon={<IconCpu size={24} />}
            title={m.name}
            badge={m.recommended ? t("kbRecommended") : undefined}
            text={t("kbLocalText", { size: num(m.sizeMb), dims: num(m.defaultDims) })}
            state={
              downloading(m.name)
                ? t("kbDownloading")
                : m.here
                  ? t("kbHere")
                  : t("kbToDownload", { size: num(m.sizeMb) })
            }
            onClick={() =>
              void run(() =>
                getApi().setKnowledgeSettings({ embedding: { provider: "local", model: m.id } }),
              )
            }
          />
        ))}
        <Tile
          on={!!e && e.provider !== "local"}
          icon={<IconCloud size={24} />}
          title={t("kbCloudTitle")}
          text={e && e.provider !== "local" ? `${e.provider} · ${e.model}` : t("kbCloudText")}
          onClick={() => setCloud(true)}
        />
      </Tiles>
      <Sub title={t("kbRerankTitle")} lead={t("kbRerankLead")} />
      <Tiles class="kb-models">
        <Tile
          on={!r}
          icon={<IconSearch size={24} />}
          title={t("kbRerankNone")}
          text={t("kbRerankNoneText")}
          onClick={() => void run(() => getApi().setKnowledgeSettings({ rerank: null }))}
        />
        {models.localRerank.map((m) => (
          <Tile
            key={m.id}
            on={r?.provider === "local" && r.model === m.id}
            icon={<IconCpu size={24} />}
            title={m.name}
            badge={m.recommended ? t("kbRecommended") : undefined}
            text={t("kbRerankText", { size: num(m.sizeMb) })}
            state={
              downloading(m.name)
                ? t("kbDownloading")
                : m.here
                  ? t("kbHere")
                  : t("kbToDownload", { size: num(m.sizeMb) })
            }
            onClick={() =>
              void run(async () => {
                await getApi().setKnowledgeSettings({ rerank: { provider: "local", model: m.id } });
                if (!m.here) await getApi().downloadKnowledgeModel("rerank", m.id);
              })
            }
          />
        ))}
      </Tiles>
      <Advanced label={t("kbThreadsTitle")}>
        <Slider
          label={t("kbThreads")}
          value={st.settings.threads}
          min={0}
          max={8}
          step={1}
          onChange={(n) => void run(() => getApi().setKnowledgeSettings({ threads: n }))}
          format={(n) => (n === 0 ? t("kbThreadsAuto") : String(n))}
          help={t("kbThreadsHelp")}
        />
      </Advanced>
      {cloud && (
        <CloudWindow
          models={models}
          now={e && e.provider !== "local" ? e : undefined}
          onClose={() => setCloud(false)}
          saved={() => run(async () => {})}
        />
      )}
    </>
  );
}

/** A cloud API for the embeddings: provider, model, and the keychain entry with its key. */
function CloudWindow({
  models,
  now,
  onClose,
  saved,
}: {
  models: KnowledgeModels;
  now: EmbeddingChoice | undefined;
  onClose: () => void;
  /** The page loads again after the choice. */
  saved: () => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<Cloud>((now?.provider as Cloud) ?? "openai");
  const suggestions = models.cloud.filter((m) => m.provider === provider);
  const [model, setModel] = useState(now?.model ?? suggestions[0]?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(now?.baseUrl ?? "");
  const [credential, setCredential] = useState(now?.credential ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choice = (): EmbeddingChoice => ({
    provider,
    model: model.trim(),
    ...(provider === "compatible" && baseUrl.trim() && { baseUrl: baseUrl.trim() }),
    ...(credential.trim() && { credential: credential.trim() }),
  });
  const ok = model.trim() && (provider !== "compatible" || baseUrl.trim());
  return (
    <Modal wide title={t("kbCloudTitle")} onClose={onClose}>
      <div class="kb-window kb-form">
        <p class="kb-p">{t("kbCloudLead")}</p>
        <span class="wz-lb">{t("kbCloudWho")}</span>
        <Chips
          options={CLOUD.map((p) => ({ id: p, label: t(`kbProv_${p}`) }))}
          value={[provider]}
          onChange={([p]) => {
            if (!p) return;
            setProvider(p);
            setModel(models.cloud.find((m) => m.provider === p)?.model ?? "");
          }}
        />
        {suggestions.length > 0 && (
          <>
            <span class="wz-lb">{t("kbCloudModel")}</span>
            <Chips
              options={suggestions.map((m) => ({ id: m.model, label: m.model }))}
              value={[model]}
              onChange={([m]) => m && setModel(m)}
            />
          </>
        )}
        <Field label={t("kbCloudModelName")}>
          <input
            class="wz-field kb-mono"
            value={model}
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
        </Field>
        {provider === "compatible" ? (
          <Field label={t("kbCloudUrl")} help={t("kbCloudUrlHelp")}>
            <input
              class="wz-field kb-mono"
              value={baseUrl}
              placeholder="https://example.com/v1"
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
          </Field>
        ) : (
          <p class="kb-dim">{EMBEDDING_API_URLS[provider]}</p>
        )}
        <Field label={t("kbCloudKey")} help={t("kbCloudKeyHelp")}>
          <input
            class="wz-field kb-mono"
            value={credential}
            placeholder={t("kbCloudKeyExample")}
            onInput={(e) => setCredential((e.target as HTMLInputElement).value)}
          />
        </Field>
        {error && (
          <p class="kb-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Acts>
        <button type="button" class="wz-btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              // The server tries the API once first: a wrong key is said here, now.
              await getApi().setKnowledgeSettings({ embedding: choice() });
              await saved();
              onClose();
            } catch (err) {
              setError(why(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("kbCloudTrying") : t("kbCloudUse")}
        </button>
      </Acts>
    </Modal>
  );
}

/** Reading the text in pictures and scanned PDFs, on this computer. */
function OcrPart({
  st,
  models,
  jobs,
  run,
}: {
  st: KnowledgeStatus;
  models: KnowledgeModels;
  jobs: Job[];
  run: (f: () => Promise<unknown>) => Promise<boolean>;
}) {
  const o = st.settings.ocr;
  const missing = models.ocr.filter((l) => o.languages.includes(l.id) && !l.here);
  const ocrJobs = jobs.filter((j) => j.kind === "download_ocr");
  return (
    <>
      <Sub title={t("kbOcrTitle")} lead={t("kbOcrLead")} />
      <Box class="kb-ocr">
        <SwitchRow
          title={t("kbOcrOn")}
          help={t("kbOcrOnHelp")}
          on={o.on}
          onChange={(on) =>
            void run(() => getApi().setKnowledgeSettings({ ocr: { on, languages: o.languages } }))
          }
        />
        <span class="wz-lb">{t("kbOcrLanguages")}</span>
        <Chips
          multiple
          options={models.ocr.map((l) => ({ id: l.id, label: l.name }))}
          value={o.languages}
          onChange={(languages) =>
            languages.length > 0 &&
            languages.length <= 6 &&
            void run(() => getApi().setKnowledgeSettings({ ocr: { on: o.on, languages } }))
          }
        />
        <p class="kb-p">
          <IconImage size={16} />{" "}
          {st.ocr.ready
            ? t("kbOcrReady")
            : t("kbOcrToDownload", {
                size: num(
                  Math.max(
                    1,
                    Math.round((3808 + missing.reduce((n, l) => n + l.sizeKb, 0)) / 1024),
                  ),
                ),
              })}
          {st.ocr.waiting > 0 && ` ${t("kbOcrWaiting", { n: num(st.ocr.waiting) })}`}
        </p>
        {!st.ocr.ready && !ocrJobs.some((j) => j.state === "running") && (
          <button
            type="button"
            class="wz-btn"
            onClick={() => void run(() => getApi().downloadOcr(o.languages))}
          >
            {t("kbOcrDownload")}
          </button>
        )}
        {ocrJobs.map((j) => (
          <JobView key={j.id} job={j} />
        ))}
      </Box>
    </>
  );
}

/** A cited mail's text, in a window (it lives in the mailbox, not in a file here). */
export function CitationNote() {
  const n = citationNote.value;
  if (!n) return null;
  return (
    <Modal wide title={n.title} onClose={() => (citationNote.value = null)}>
      <pre class="kb-note">{n.text}</pre>
    </Modal>
  );
}
