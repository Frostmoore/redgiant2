// «Import from…» (G36.7): bring in what another agent knew (Claude Code, Codex, Cursor, Gemini,
// opencode, Hermes) and the conversations exported from ChatGPT and Claude. Three ways in, as
// the wizard's squares: RedGiant looks in the known folders (only after the person says yes), a
// folder picked, or an export's .zip. Then everything found is shown, kind by kind, each with its
// switch; names already taken ask what to do; nothing changes before «Import». Every import can be
// taken back. In Settings › Import and as the wizard's optional step «Coming from another agent?».
import type {
  ImportChoice,
  ImportItem,
  ImportKind,
  ImportNote,
  ImportPreview,
  ImportRecord,
  ImportSource,
} from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import {
  IconBook,
  IconChat,
  IconFolder,
  IconKey,
  IconSearch,
  IconServer,
  IconSpark,
  IconUpload,
  IconUser,
} from "../icons.js";
import { agents, attempt, getApi, lastError } from "../state.js";
import { Acts, Head, Seg, Sub, Switch, SwitchRow, Tile, Tiles, WzPage } from "./SettingsKit.js";
import { Advanced, Field, JobView, Modal, Progress, useJob } from "./ui.js";

const SOURCE: Record<ImportSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "opencode",
  hermes: "Hermes",
  chatgpt: "ChatGPT",
  claude: "Claude",
};
const KINDS: ImportKind[] = ["instructions", "skill", "mcp", "memory", "conversation"];
const KIND_ICON: Record<ImportKind, JSX.Element> = {
  instructions: <IconUser size={18} />,
  skill: <IconBook size={18} />,
  mcp: <IconServer size={18} />,
  memory: <IconSpark size={18} />,
  conversation: <IconChat size={18} />,
};
const kindName = (k: ImportKind) => t(`impKind_${k}` as "impKind_skill");
const noteText = (n: ImportNote) => t(`impNote_${n.code}` as "impNote_sse", { arg: n.arg ?? "" });
/** The server's words about one item, in the person's language when known. */
function doneWords(text: string): string {
  const keys = text.match(/^keys still to add: (.+)$/);
  if (keys) return t("impKeysLater", { names: keys[1] ?? "" });
  if (text === "already remembered") return t("impAlready");
  if (/^A skill with this name is there already/.test(text)) return t("impSkippedSkill");
  if (/^A server with this name is there already/.test(text)) return t("impSkippedMcp");
  if (/^The instructions for every agent would pass/.test(text)) return t("impTooLong");
  if (text === "No such agent") return t("impNoAgent");
  return text;
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(lang.value) : "");

/** The person's choice for one item, kept apart from what the server found. */
type Choice = Omit<ImportChoice, "id">;

/** One thing found: its switch, where it comes from and, when on, what is still to choose. */
function ItemRow({
  item,
  choice,
  set,
}: {
  item: ImportItem;
  choice: Choice;
  set: (c: Choice) => void;
}) {
  const others = agents.value.filter((a) => a.kind !== "demigod" && a.kind !== "inspector");
  return (
    <div class={`imp-item${choice.on ? " on" : ""}`}>
      <div class="imp-item-hd">
        <span class="imp-item-ico" aria-hidden="true">
          {KIND_ICON[item.kind]}
        </span>
        <div class="imp-item-text">
          <b>{item.name}</b>
          <small>
            {SOURCE[item.source]} · {item.from}
            {item.conversation &&
              ` · ${t("impMessages", { n: String(item.conversation.messages) })}${item.conversation.updatedAt ? ` · ${when(item.conversation.updatedAt)}` : ""}`}
          </small>
        </div>
        {item.exists && (
          <span class={`imp-pill${item.exists === "taken" ? " warn" : ""}`}>
            {t(item.exists === "same" ? "impSame" : "impTaken")}
          </span>
        )}
        <Switch on={choice.on} label={item.name} onChange={(on) => set({ ...choice, on })} />
      </div>
      {item.kind !== "memory" && item.preview && (
        <details class="imp-preview">
          <summary>{t("impShow")}</summary>
          <pre>{item.preview}</pre>
          {item.skill && item.skill.files.length > 0 && (
            <p class="imp-files">
              {t("impFiles")}: {item.skill.files.join(", ")}
            </p>
          )}
        </details>
      )}
      {item.notes.length > 0 && (
        <ul class="imp-notes">
          {item.notes.map((n) => (
            <li key={n.code}>{noteText(n)}</li>
          ))}
        </ul>
      )}
      {choice.on && (
        <div class="imp-item-more">
          {item.kind === "instructions" && (
            <Field label={t("impForWhom")}>
              <select
                class="wz-field"
                value={choice.target ?? "everyone"}
                onChange={(e) => set({ ...choice, target: (e.target as HTMLSelectElement).value })}
              >
                <option value="everyone">{t("impEveryone")}</option>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {item.kind === "memory" && (
            <Field label={t("impMemoryText")}>
              <input
                class="wz-field"
                maxLength={400}
                value={choice.text ?? item.text ?? ""}
                onInput={(e) => set({ ...choice, text: (e.target as HTMLInputElement).value })}
              />
            </Field>
          )}
          {item.exists === "taken" && (item.kind === "skill" || item.kind === "mcp") && (
            <div class="imp-conflict">
              <span>{t(item.kind === "skill" ? "impTakenSkill" : "impTakenMcp")}</span>
              <Seg
                label={t("impTaken")}
                value={choice.conflict ?? "skip"}
                options={[
                  ["skip", t("impSkip")],
                  ...(item.kind === "skill" ? ([["replace", t("impReplace")]] as const) : []),
                  ["rename", t("impKeepBoth")],
                ]}
                onChange={(conflict) => set({ ...choice, conflict })}
              />
            </div>
          )}
          {item.skill && item.skill.scripts.length > 0 && (
            <p class="imp-hint">{t("impScripts", { files: item.skill.scripts.join(", ") })}</p>
          )}
          {item.mcp && item.mcp.held.length > 0 && (
            <p class="imp-hint">
              <IconKey size={14} /> {t("impHeld", { names: item.mcp.held.join(", ") })}
            </p>
          )}
          {item.mcp?.missing.map((name) => (
            <Field key={name} label={t("impKeyFor", { name })} help={t("impKeyHelp")}>
              <input
                class="wz-field"
                type="password"
                autoComplete="off"
                value={choice.secrets?.[name] ?? ""}
                onInput={(e) =>
                  set({
                    ...choice,
                    secrets: { ...choice.secrets, [name]: (e.target as HTMLInputElement).value },
                  })
                }
              />
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}

const PAGE = 60;

/** Everything found, kind by kind: the person chooses, then «Import». */
function PreviewWindow({
  preview,
  onClose,
  onStarted,
}: {
  preview: ImportPreview;
  onClose: () => void;
  onStarted: (jobId: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      preview.items.map((i) => [i.id, { on: i.on, ...(i.target && { target: i.target }) }]),
    ),
  );
  const present = KINDS.filter((k) => preview.items.some((i) => i.kind === k));
  const [kind, setKind] = useState<ImportKind | "all">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [chatAgent, setChatAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const list = preview.items.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (!query.trim() ||
        `${i.name} ${i.from} ${i.text ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const chosen = preview.items.filter((i) => choices[i.id]?.on);
  const setAll = (on: boolean) =>
    setChoices((c) => {
      const next = { ...c };
      for (const i of list) next[i.id] = { ...(next[i.id] as Choice), on };
      return next;
    });
  const go = async () => {
    setBusy(true);
    const job = await attempt(() =>
      getApi().importApply({
        id: preview.id,
        choices: chosen.map((i) => ({
          id: i.id,
          ...(choices[i.id] as Choice),
          ...(i.kind === "conversation" && chatAgent && { agentId: chatAgent }),
        })),
      }),
    );
    setBusy(false);
    if (job) onStarted(job.id);
  };
  const assistants = agents.value.filter((a) => a.kind !== "demigod" && a.kind !== "inspector");
  return (
    <Modal
      wide
      class="imp-window"
      title={t("impFoundTitle")}
      sub={t("impFoundSub", { n: String(preview.items.length), files: String(preview.read) })}
      onClose={onClose}
      foot={
        <Acts>
          <button type="button" class="wz-btn quiet" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={busy || chosen.length === 0}
            onClick={() => void go()}
          >
            {t("impDo", { n: String(chosen.length) })}
          </button>
        </Acts>
      }
    >
      {preview.items.length === 0 ? (
        <p class="wz-lead2">{t("impNothing")}</p>
      ) : (
        <>
          <p class="wz-lead2">{t("impFoundLead")}</p>
          <div class="wz-chips st-chips imp-kinds">
            {(["all", ...present] as const).map((k) => {
              const n =
                k === "all"
                  ? preview.items.length
                  : preview.items.filter((i) => i.kind === k).length;
              return (
                <button
                  key={k}
                  type="button"
                  class={`wz-chip${kind === k ? " on" : ""}`}
                  aria-pressed={kind === k}
                  onClick={() => {
                    setKind(k);
                    setShown(PAGE);
                  }}
                >
                  {k === "all" ? t("impAll") : kindName(k)} ({n})
                </button>
              );
            })}
          </div>
          <div class="imp-tools">
            {preview.items.length > 12 && (
              <input
                class="wz-field"
                type="search"
                aria-label={t("impSearch")}
                placeholder={t("impSearch")}
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            )}
            <button type="button" class="wz-btn small" onClick={() => setAll(true)}>
              {t("impAllOn")}
            </button>
            <button type="button" class="wz-btn small quiet" onClick={() => setAll(false)}>
              {t("impAllOff")}
            </button>
          </div>
          {(kind === "all" || kind === "conversation") &&
            preview.items.some((i) => i.kind === "conversation") && (
              <Field label={t("impConvTo")} help={t("impConvHelp")}>
                <select
                  class="wz-field"
                  value={chatAgent}
                  onChange={(e) => setChatAgent((e.target as HTMLSelectElement).value)}
                >
                  <option value="">{t("impConvChat")}</option>
                  {assistants
                    .filter((a) => a.name !== "Chat")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
          <div class="imp-list">
            {list.slice(0, shown).map((i) => (
              <ItemRow
                key={i.id}
                item={i}
                choice={choices[i.id] as Choice}
                set={(c) => setChoices((x) => ({ ...x, [i.id]: c }))}
              />
            ))}
          </div>
          {list.length > shown && (
            <button type="button" class="wz-btn small" onClick={() => setShown((n) => n + PAGE)}>
              {t("impMore", { n: String(list.length - shown) })}
            </button>
          )}
        </>
      )}
      {(preview.left.length > 0 || preview.unreadable.length > 0) && (
        <Advanced label={t("impLeftTitle")}>
          <p class="ui-help">{t("impLeftLead")}</p>
          <ul class="imp-left">
            {preview.left.map((l) => (
              <li key={l.from}>
                <code>{l.from}</code> {l.what}
              </li>
            ))}
            {preview.unreadable.map((l) => (
              <li key={`u${l.from}`}>
                <code>{l.from}</code> {t("impUnreadable")}: {l.why}
              </li>
            ))}
          </ul>
        </Advanced>
      )}
    </Modal>
  );
}

/** The import running, then what went and what did not, with undo and the memories offer. */
function DoneWindow({
  jobId,
  onClose,
  onPreview,
  onChanged,
}: {
  jobId: string;
  onClose: () => void;
  onPreview: (p: ImportPreview) => void;
  onChanged: () => void;
}) {
  const job = useJob(jobId);
  const [rec, setRec] = useState<ImportRecord>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (job?.state === "done") {
      setRec(job.result as ImportRecord);
      onChanged();
    }
  }, [job?.state]);
  const ok = rec?.done.filter((d) => d.ok) ?? [];
  const bad = rec?.done.filter((d) => !d.ok) ?? [];
  const convs = ok.filter((d) => d.kind === "conversation").length;
  const undo = async () => {
    if (!rec) return;
    setBusy(true);
    const r = await attempt(() => getApi().importUndo(rec.id));
    setBusy(false);
    if (r) {
      setRec(r);
      onChanged();
    }
  };
  const memories = async () => {
    if (!rec) return;
    setBusy(true);
    const p = await attempt(() => getApi().importMemories(rec.id));
    setBusy(false);
    if (p) onPreview(p);
  };
  return (
    <Modal title={t("impDoneTitle")} onClose={onClose}>
      {!rec && job && job.state !== "done" && <JobView job={job} />}
      {!rec && !job && (
        <Progress progress={{ done: 0, total: null, rate: 0, secondsLeft: null }} unit="count" />
      )}
      {rec && (
        <div class="imp-done">
          <p class="wz-lead2">
            {rec.undoneAt
              ? t("impUndone")
              : t("impDoneLead", { ok: String(ok.length), n: String(rec.done.length) })}
          </p>
          {rec.undoProblems && rec.undoProblems.length > 0 && (
            <ul class="imp-notes">
              {rec.undoProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {!rec.undoneAt && (
            <ul class="imp-result">
              {KINDS.map((k) => {
                const n = ok.filter((d) => d.kind === k).length;
                return n > 0 ? (
                  <li key={k}>
                    {KIND_ICON[k]} {kindName(k)}: {n}
                  </li>
                ) : null;
              })}
            </ul>
          )}
          {!rec.undoneAt &&
            ok
              .filter((d) => d.note)
              .map((d) => (
                <p key={d.itemId} class="imp-hint">
                  <span>
                    <b>{d.name}</b>: {doneWords(d.note ?? "")}
                  </span>
                </p>
              ))}
          {!rec.undoneAt && bad.length > 0 && (
            <>
              <h4>{t("impNotDone")}</h4>
              <ul class="imp-notes">
                {bad.map((d) => (
                  <li key={d.itemId}>
                    <b>{d.name}</b>: {doneWords(d.error ?? "")}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!rec.undoneAt && convs > 0 && (
            <div class="wz-card wz-left imp-offer">
              <b>{t("impMemOfferTitle")}</b>
              <p class="ui-help">{t("impMemOfferText")}</p>
              <button
                type="button"
                class="wz-btn small"
                disabled={busy}
                onClick={() => void memories()}
              >
                <IconSpark size={16} /> {t("impMemOfferBtn")}
              </button>
            </div>
          )}
        </div>
      )}
      <Acts>
        {rec && !rec.undoneAt && (
          <button
            type="button"
            class="wz-btn quiet xw-danger"
            disabled={busy}
            onClick={() => void undo()}
          >
            {t("impUndo")}
          </button>
        )}
        <button type="button" class="wz-btn primary" onClick={onClose}>
          {t("wzDoneBtn")}
        </button>
      </Acts>
    </Modal>
  );
}

/** «Look on my computer»: what will be read, asked before anything is. */
function ScanWindow({
  onClose,
  onPreview,
}: {
  onClose: () => void;
  onPreview: (p: ImportPreview) => void;
}) {
  const [home, setHome] = useState(true);
  const [projects, setProjects] = useState(true);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    const p = await attempt(() =>
      getApi().importScan({ home, projects, ...(folder.trim() && { folder: folder.trim() }) }),
    );
    setBusy(false);
    if (p) onPreview(p);
  };
  return (
    <Modal
      title={t("impScanTitle")}
      onClose={onClose}
      foot={
        <Acts>
          <button type="button" class="wz-btn quiet" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={busy || (!home && !projects && !folder.trim())}
            onClick={() => void scan()}
          >
            <IconSearch size={18} /> {busy ? t("impLooking") : t("impScanGo")}
          </button>
        </Acts>
      }
    >
      <p class="wz-lead2">{t("impScanLead")}</p>
      <SwitchRow
        title={t("impScanHome")}
        help={t("impScanHomeHelp")}
        on={home}
        onChange={setHome}
      />
      <SwitchRow
        title={t("impScanProjects")}
        help={t("impScanProjectsHelp")}
        on={projects}
        onChange={setProjects}
      />
      <Field label={t("impScanFolder")} help={t("impScanFolderHelp")}>
        <input
          class="wz-field"
          value={folder}
          placeholder="C:\\Users\\Anna\\work\\shop"
          onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
        />
      </Field>
      <p class="ui-help">{t("impScanPromise")}</p>
    </Modal>
  );
}

/**
 * The three ways in and the imports done; `compact` in the wizard (no history, no page frame).
 */
export function ImportFrom({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState<
    | null
    | { scan: true }
    | { uploading: { done: number; total: number } }
    | { preview: ImportPreview }
    | { job: string }
  >(null);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reload = () => {
    if (!compact)
      void getApi()
        .importHistory()
        .then(setHistory, () => {});
  };
  useEffect(reload, []);
  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = [...list];
    const total = files.reduce((n, f) => n + f.size, 0);
    setOpen({ uploading: { done: 0, total } });
    try {
      const api = getApi();
      const { id } = await api.importUpload();
      let before = 0;
      for (const f of files) {
        const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        await api.importFile(id, path, f, (done) =>
          setOpen({ uploading: { done: before + done, total } }),
        );
        before += f.size;
      }
      setOpen({ preview: await api.importPreview(id) });
    } catch (err) {
      lastError.value = (err as Error).message;
      setOpen(null);
    }
  };
  const tiles = (
    <Tiles class="imp-ways">
      <Tile
        on={false}
        icon={<IconSearch />}
        title={t("impWayScan")}
        text={t("impWayScanText")}
        onClick={() => setOpen({ scan: true })}
      />
      <Tile
        on={false}
        icon={<IconFolder />}
        title={t("impWayFolder")}
        text={t("impWayFolderText")}
        onClick={() => folderInput.current?.click()}
      />
      <Tile
        on={false}
        icon={<IconUpload />}
        title={t("impWayExport")}
        text={t("impWayExportText")}
        onClick={() => fileInput.current?.click()}
      />
    </Tiles>
  );
  const windows = (
    <>
      <input
        ref={folderInput}
        type="file"
        class="imp-hidden"
        // @ts-expect-error: the folder picker's attribute, not in the DOM types.
        webkitdirectory=""
        multiple
        onChange={(e) => {
          void upload((e.target as HTMLInputElement).files);
          (e.target as HTMLInputElement).value = "";
        }}
      />
      <input
        ref={fileInput}
        type="file"
        class="imp-hidden"
        multiple
        accept=".zip,.json,.jsonc,.md,.mdc,.toml,.yaml,.yml"
        onChange={(e) => {
          void upload((e.target as HTMLInputElement).files);
          (e.target as HTMLInputElement).value = "";
        }}
      />
      {open && "scan" in open && (
        <ScanWindow onClose={() => setOpen(null)} onPreview={(p) => setOpen({ preview: p })} />
      )}
      {open && "uploading" in open && (
        <Modal title={t("impUploading")} onClose={() => {}}>
          <Progress
            progress={{
              done: open.uploading.done,
              total: open.uploading.total,
              rate: 0,
              secondsLeft: null,
            }}
          />
        </Modal>
      )}
      {open && "preview" in open && (
        <PreviewWindow
          preview={open.preview}
          onClose={() => setOpen(null)}
          onStarted={(job) => setOpen({ job })}
        />
      )}
      {open && "job" in open && (
        <DoneWindow
          jobId={open.job}
          onClose={() => setOpen(null)}
          onPreview={(p) => setOpen({ preview: p })}
          onChanged={reload}
        />
      )}
    </>
  );
  const howTo = (
    <Advanced label={t("impHowExport")}>
      <ol class="imp-how">
        <li>{t("impHowChatgpt")}</li>
        <li>{t("impHowClaude")}</li>
      </ol>
    </Advanced>
  );
  if (compact)
    return (
      <div class="imp-compact">
        {tiles}
        {howTo}
        {windows}
      </div>
    );
  const undo = async (id: string) => {
    if (await attempt(() => getApi().importUndo(id))) reload();
  };
  return (
    <WzPage class="imp-page" after={windows}>
      <Head eyebrow={t("impEyebrow")} q={t("impQ")} lead={t("impLead")} />
      {tiles}
      {howTo}
      {history.length > 0 && (
        <>
          <Sub title={t("impHistory")} lead={t("impHistoryLead")} />
          <div class="wz-card wz-left st-box imp-history">
            {history.map((h) => (
              <div key={h.id} class="st-row">
                <div class="st-row-text">
                  <b>{h.sources.map((s) => SOURCE[s]).join(", ")}</b>
                  <small>
                    {new Date(h.createdAt).toLocaleString(lang.value)} ·{" "}
                    {t("impHistoryItems", { n: String(h.done.filter((d) => d.ok).length) })}
                    {h.undoneAt && ` · ${t("impUndoneShort")}`}
                  </small>
                </div>
                {!h.undoneAt && (
                  <div class="st-row-ctl">
                    <button
                      type="button"
                      class="wz-btn small quiet"
                      onClick={() => void undo(h.id)}
                    >
                      {t("impUndo")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </WzPage>
  );
}
