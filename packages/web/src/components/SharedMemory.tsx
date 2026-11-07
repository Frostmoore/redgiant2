// The shared memory (G33.2, the person: «Quella memoria deve essere condivisa tra tutti gli agenti,
// mentre questa deve essere "personale" dell'agente. La differenza si deve capire.»): what every
// agent knows about the person, learned by itself from the conversations (a switch turns it off),
// each memory with where it came from, changed or deleted here, every change undoable. The two
// kinds of memory are drawn side by side at the top so the difference reads at a glance.
import type { SharedMemoryChange, SharedMemoryEntry, SharedMemoryView } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { ApiError } from "../api.js";
import { lang, t, tOptional } from "../i18n.js";
import { IconPencil, IconPlus, IconTrash, IconUser, IconUsers } from "../icons.js";
import { getApi, openSession } from "../state.js";
import { Acts, Head, SCard, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { Modal } from "./ui.js";

/** The server's reason in plain words, or its message when it has no code. */
export const memoryError = (err: unknown) =>
  (err instanceof ApiError && err.code && tOptional(`err_${err.code}`)) || (err as Error).message;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(lang.value === "it" ? "it-IT" : "en-US", {
    day: "numeric",
    month: "short",
    year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });

/** Who wrote a memory first, in words. */
function byWords(by: string, agentName: string | null | undefined): string {
  if (by === "auto") return t("memByAuto");
  if (by === "human") return t("memByHuman");
  if (by === "import") return t("memByImport");
  return agentName ? t("memByAgent", { name: agentName }) : t("memByAgentUnknown");
}

function Entry({
  e,
  onEdit,
  onRemove,
  onForget,
}: {
  e: SharedMemoryEntry;
  onEdit: () => void;
  onRemove: () => void;
  onForget: () => void;
}) {
  return (
    <li class="mem-item">
      <p class="mem-text">{e.text}</p>
      <div class="mem-meta">
        <span>
          {byWords(e.by, e.agentName)} · {day(e.createdAt)}
          {e.sessionId && e.agentId && (
            <>
              {" · "}
              <button
                type="button"
                class="wz-link mem-from"
                onClick={() =>
                  openSession({
                    id: e.sessionId as string,
                    agentId: e.agentId as string,
                    title: e.sessionTitle ?? null,
                  })
                }
              >
                {e.sessionTitle ? t("memFrom", { title: e.sessionTitle }) : t("memFromUntitled")}
              </button>
              {e.by === "auto" && e.agentName ? ` ${t("memWith", { name: e.agentName })}` : ""}
            </>
          )}
        </span>
        <span class="mem-acts">
          <button type="button" class="wz-btn small quiet" onClick={onEdit}>
            <IconPencil size={16} />
            {t("memEdit")}
          </button>
          <button type="button" class="wz-btn small quiet" onClick={onRemove}>
            <IconTrash size={16} />
            {t("memRemove")}
          </button>
          <button type="button" class="wz-btn small quiet mem-forget" onClick={onForget}>
            {t("memForget")}
          </button>
        </span>
      </div>
    </li>
  );
}

function EditWindow({
  entry,
  onClose,
}: {
  entry: SharedMemoryEntry;
  onClose: (saved: boolean) => void;
}) {
  const [text, setText] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().editMemory(entry.id, text);
      onClose(true);
    } catch (err) {
      setError(memoryError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("memEditTitle")} onClose={() => onClose(false)}>
      <div class="wz-panel-in mem-edit">
        <textarea
          class="wz-field"
          rows={4}
          maxLength={400}
          aria-label={t("memEditTitle")}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        {error && <p class="mem-error">{error}</p>}
      </div>
      <Acts>
        <button type="button" class="wz-btn" onClick={() => onClose(false)}>
          {t("cancel")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={busy || !text.trim()}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </Acts>
    </Modal>
  );
}

/** «Forget for good»: said plainly, since it cannot come back. */
function ForgetWindow({ text, onClose }: { text: string; onClose: (forget: boolean) => void }) {
  return (
    <Modal title={t("memForgetTitle")} onClose={() => onClose(false)}>
      <div class="wz-panel-in mem-edit">
        <p class="mem-forget-quote">{text}</p>
        <p class="wz-lead2">{t("memForgetText")}</p>
      </div>
      <Acts>
        <button type="button" class="wz-btn" onClick={() => onClose(false)}>
          {t("cancel")}
        </button>
        <button type="button" class="wz-btn primary" onClick={() => onClose(true)}>
          {t("memForget")}
        </button>
      </Acts>
    </Modal>
  );
}

function Change({
  c,
  onUndo,
  onForget,
}: {
  c: SharedMemoryChange;
  onUndo: () => void;
  /** A deleted memory still in the log: it can be forgotten for good from here. */
  onForget?: (() => void) | undefined;
}) {
  if (c.action === "forgotten")
    return (
      <li class="mem-change">
        <div class="mem-change-text">
          <b>{t("memDid_forgotten")}</b>
          <span class="mem-gone">{t("memForgottenText")}</span>
          <small>{day(c.ts)}</small>
        </div>
      </li>
    );
  return (
    <li class={`mem-change${c.undoneBy !== undefined ? " undone" : ""}`}>
      <div class="mem-change-text">
        <b>{t(c.undoOf !== undefined ? `memUndid_${c.action}` : `memDid_${c.action}`)}</b>
        <span>
          {c.action === "edited" && c.before && (
            <>
              <s>{c.before}</s>{" "}
            </>
          )}
          {c.text}
        </span>
        <small>
          {byWords(c.by, null)} · {day(c.ts)}{" "}
          {new Date(c.ts).toLocaleTimeString(lang.value === "it" ? "it-IT" : "en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </small>
      </div>
      <span class="mem-change-acts">
        {c.undoneBy !== undefined ? (
          <span class="mem-pill">{t("memUndone")}</span>
        ) : (
          <button type="button" class="wz-btn small" onClick={onUndo}>
            {t("memUndo")}
          </button>
        )}
        {onForget && (
          <button type="button" class="wz-btn small quiet mem-forget" onClick={onForget}>
            {t("memForget")}
          </button>
        )}
      </span>
    </li>
  );
}

/** Settings › Shared memory. */
export function SharedMemoryPage() {
  const [v, setV] = useState<SharedMemoryView>();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SharedMemoryEntry | null>(null);
  /** The last deletion, to take it back from the bar under the list. */
  const [removed, setRemoved] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  /** The memory to forget for good, once the person confirms. */
  const [forgetting, setForgetting] = useState<{ id: string; text: string } | null>(null);
  const load = () =>
    getApi()
      .sharedMemory()
      .then(setV, (err) => setError(memoryError(err)));
  useEffect(() => {
    void load();
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setError(undefined);
    setNote(undefined);
    try {
      await f();
      await load();
      return true;
    } catch (err) {
      setError(memoryError(err));
      return false;
    }
  };
  if (!v) return <WzPage>{error && <p class="mem-error">{error}</p>}</WzPage>;
  const add = async () => {
    if (!text.trim()) return;
    let duplicate = false;
    const ok = await run(async () => {
      duplicate = (await getApi().addMemory(text)).duplicate;
    });
    if (ok) {
      setText("");
      if (duplicate) setNote(t("memAlready"));
    }
  };
  const remove = async (e: SharedMemoryEntry) => {
    setRemoved(null);
    const ok = await run(() => getApi().removeMemory(e.id));
    if (!ok) return;
    const fresh = await getApi()
      .sharedMemory()
      .catch(() => undefined);
    const c = fresh?.changes.find((x) => x.memoryId === e.id && x.action === "removed");
    if (fresh) setV(fresh);
    if (c) setRemoved(c.seq);
  };
  const changes = all ? v.changes : v.changes.slice(0, 5);
  // A deleted memory can be forgotten for good from its last change in the history.
  const present = new Set(v.entries.map((e) => e.id));
  const latest = new Map<string, number>();
  for (const c of v.changes) if (!latest.has(c.memoryId)) latest.set(c.memoryId, c.seq);
  const pct = Math.min(100, (v.used / v.limit) * 100);
  return (
    <WzPage
      class="mem-page"
      after={
        <>
          {editing && (
            <EditWindow
              key={editing.id}
              entry={editing}
              onClose={(saved) => {
                setEditing(null);
                if (saved) void load();
              }}
            />
          )}
          {forgetting && (
            <ForgetWindow
              key={forgetting.id}
              text={forgetting.text}
              onClose={(yes) => {
                const id = forgetting.id;
                setForgetting(null);
                if (!yes) return;
                setRemoved(null);
                void run(() => getApi().forgetMemory(id));
              }}
            />
          )}
        </>
      }
    >
      <Head eyebrow={t("memEyebrow")} q={t("memTitle")} lead={t("memLead")} />

      <div class="mem-two">
        <SCard
          class="mem-card on"
          icon={<IconUsers size={22} />}
          title={t("memSharedCard")}
          q={t("memSharedCardQ")}
        >
          <p>{t("memSharedCardText")}</p>
        </SCard>
        <SCard icon={<IconUser size={22} />} title={t("memOwnCard")} q={t("memOwnCardQ")}>
          <p>{t("memOwnCardText")}</p>
        </SCard>
      </div>

      <div class="mem-block">
        <SwitchRow
          title={t("memAutoTitle")}
          help={v.auto ? t("memAutoOn") : t("memAutoOff")}
          on={v.auto}
          onChange={(on) => void run(() => getApi().setMemoryAuto(on))}
        />
      </div>

      <Sub
        title={`${t("memListTitle")} · ${v.entries.length === 1 ? t("memCountOne") : t("memCount", { n: String(v.entries.length) })}`}
        lead={t("memListLead")}
      />
      <div class="wz-card wz-left mem-box">
        <form
          class="mem-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            class="wz-field"
            maxLength={400}
            enterkeyhint="done"
            aria-label={t("memAddPlaceholder")}
            placeholder={t("memAddPlaceholder")}
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="wz-btn primary" disabled={!text.trim()}>
            <IconPlus size={18} />
            {t("memAdd")}
          </button>
        </form>
        {error && <p class="mem-error">{error}</p>}
        {note && <p class="mem-note">{note}</p>}
        {removed !== null && (
          <div class="mem-undo-bar" role="status">
            <span>{t("memRemoved")}</span>
            <button
              type="button"
              class="wz-btn small"
              onClick={() => {
                const seq = removed;
                setRemoved(null);
                void run(() => getApi().undoMemory(seq));
              }}
            >
              {t("memUndo")}
            </button>
          </div>
        )}
        {v.entries.length === 0 ? (
          <p class="mem-empty">{t("memEmpty")}</p>
        ) : (
          <ul class="mem-list">
            {[...v.entries].reverse().map((e) => (
              <Entry
                key={e.id}
                e={e}
                onEdit={() => setEditing(e)}
                onRemove={() => void remove(e)}
                onForget={() => setForgetting({ id: e.id, text: e.text })}
              />
            ))}
          </ul>
        )}
        <div class="mem-used">
          <span class="sb-meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          <small>
            {t("memUsed", {
              used: v.used.toLocaleString(lang.value === "it" ? "it-IT" : "en-US"),
              limit: v.limit.toLocaleString(lang.value === "it" ? "it-IT" : "en-US"),
            })}
          </small>
        </div>
      </div>

      {v.changes.length > 0 && (
        <>
          <Sub title={t("memHistory")} lead={t("memHistoryLead")} />
          <div class="wz-card wz-left mem-box">
            <ul class="mem-changes">
              {changes.map((c) => (
                <Change
                  key={c.seq}
                  c={c}
                  onUndo={() => void run(() => getApi().undoMemory(c.seq))}
                  onForget={
                    c.action === "removed" &&
                    latest.get(c.memoryId) === c.seq &&
                    !present.has(c.memoryId)
                      ? () => setForgetting({ id: c.memoryId, text: c.text })
                      : undefined
                  }
                />
              ))}
            </ul>
            {v.changes.length > 5 && (
              <p class="wz-more">
                <button type="button" class="wz-link" onClick={() => setAll(!all)}>
                  {all ? t("memHistoryLess") : t("memHistoryMore")}
                </button>
              </p>
            )}
          </div>
        </>
      )}
    </WzPage>
  );
}
