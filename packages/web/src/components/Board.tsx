import { useEffect, useState } from "preact/hooks";
import type { BoardPost, BoardThread } from "../api.js";
import { t } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, boardVersion, getApi, subprojects } from "../state.js";

const KINDS = t("postKinds").split(",") as BoardPost["kind"][];
const kindLabel = (k: BoardPost["kind"]) => t("postKindLabels").split(",")[KINDS.indexOf(k)] ?? k;
const statusLabel = (st: BoardThread["status"]) =>
  t(st === "open" ? "statusOpen" : st === "resolved" ? "statusResolved" : "statusBlocked");
/** Mentions are agent ids for the agents; people read names. */
const withNames = (body: string) =>
  body.replace(/@([a-z]+_[0-9a-f]{8})\b/g, (m, id: string) => {
    const a = agents.value.find((x) => x.id === id);
    return a ? `**@${a.name}**` : m;
  });
const authorName = (id: string) =>
  id === "human" ? t("you") : (agents.value.find((a) => a.id === id)?.name ?? id);

function Composer({
  onSend,
  withTitle,
}: {
  onSend: (p: { title: string; kind: BoardPost["kind"]; body: string }) => Promise<unknown>;
  withTitle: boolean;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BoardPost["kind"]>("note");
  const [body, setBody] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!body.trim() || (withTitle && !title.trim())) return;
    if ((await attempt(() => onSend({ title, kind, body }))) !== undefined) {
      setTitle("");
      setBody("");
    }
  };
  return (
    <form class="board-composer" onSubmit={(e) => void submit(e)}>
      {withTitle && (
        <input
          placeholder={t("title")}
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      )}
      <textarea
        rows={3}
        value={body}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      <div class="row">
        <select
          value={kind}
          onChange={(e) => setKind((e.target as HTMLSelectElement).value as BoardPost["kind"])}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <button type="submit" class="primary">
          {withTitle ? t("newThread") : t("reply")}
        </button>
      </div>
    </form>
  );
}

/** A project's board (or the global one): threads, posts, search; it reloads on every change. */
export function Board({ projectId }: { projectId: string | null }) {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ thread: BoardThread; posts: BoardPost[] } | null>(null);
  const [query, setQuery] = useState("");
  /** A subproject's view (G24.14c): its threads and the whole project's. "" = everything. */
  const [sub, setSub] = useState("");
  const subs = subprojects.value.filter((s) => s.projectId === projectId);
  const shown = sub ? threads.filter((th) => !th.subprojectId || th.subprojectId === sub) : threads;
  const [results, setResults] = useState<Awaited<
    ReturnType<ReturnType<typeof getApi>["boardSearch"]>
  > | null>(null);
  const version = boardVersion.value;

  useEffect(() => {
    void attempt(() => getApi().threads(projectId)).then((list) => list && setThreads(list));
  }, [projectId, version]);
  useEffect(() => {
    if (open) void attempt(() => getApi().thread(open)).then((d) => d && setDetail(d));
    else setDetail(null);
  }, [open, version]);

  const search = async (e: Event) => {
    e.preventDefault();
    if (!query.trim()) return setResults(null);
    const r = await attempt(() => getApi().boardSearch(query));
    if (r) setResults(r.filter((x) => x.projectId === projectId));
  };

  return (
    <div class="board">
      <aside class="board-list">
        {subs.length > 0 && (
          <select
            aria-label={t("boardSub")}
            value={sub}
            onChange={(e) => setSub((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t("agentWholeProject")}</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <form class="row" onSubmit={(e) => void search(e)}>
          <input
            placeholder={t("search")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </form>
        {results !== null ? (
          results.length === 0 ? (
            <div class="empty">{t("noResults")}</div>
          ) : (
            results.map((r) => (
              <button
                type="button"
                key={r.id}
                class="thread-item"
                onClick={() => {
                  setOpen(r.threadId);
                  setResults(null);
                }}
              >
                <strong>{r.title}</strong>
                <span class="dim">{r.body.slice(0, 120)}</span>
              </button>
            ))
          )
        ) : shown.length === 0 ? (
          <div class="empty">{t("emptyBoard")}</div>
        ) : (
          shown.map((th) => (
            <button
              type="button"
              key={th.id}
              class={`thread-item${open === th.id ? " selected" : ""}`}
              onClick={() => setOpen(th.id)}
            >
              <span class={`status-chip ${th.status}`}>{statusLabel(th.status)}</span>
              <strong>{th.title}</strong>
              {th.subprojectId && (
                <span class="chip">
                  {subs.find((s) => s.id === th.subprojectId)?.name ?? th.subprojectId}
                </span>
              )}
              <span class="dim">
                {th.posts} · {authorName(th.createdBy)} · {new Date(th.updatedAt).toLocaleString()}
              </span>
            </button>
          ))
        )}
        <Composer
          withTitle
          onSend={(p) =>
            getApi()
              .boardPost({ projectId, ...(sub && { subprojectId: sub }), ...p })
              .then((r) => setOpen(r.threadId))
          }
        />
      </aside>
      <section class="board-thread">
        {detail ? (
          <>
            <header class="row">
              <h3>{detail.thread.title}</h3>
              <span class={`status-chip ${detail.thread.status}`}>
                {statusLabel(detail.thread.status)}
              </span>
              <div class="spacer" />
              {detail.thread.status !== "resolved" && (
                <button
                  type="button"
                  onClick={() =>
                    void attempt(() => getApi().boardStatus(detail.thread.id, "resolved"))
                  }
                >
                  {t("resolve")}
                </button>
              )}
              {detail.thread.status === "open" && (
                <button
                  type="button"
                  class="danger"
                  onClick={() =>
                    void attempt(() => getApi().boardStatus(detail.thread.id, "blocked"))
                  }
                >
                  {t("block")}
                </button>
              )}
              {detail.thread.status !== "open" && (
                <button
                  type="button"
                  onClick={() => void attempt(() => getApi().boardStatus(detail.thread.id, "open"))}
                >
                  {t("reopen")}
                </button>
              )}
            </header>
            {detail.thread.summary && (
              <div class="board-summary">
                <strong>{t("summary")}</strong>
                <p>{detail.thread.summary}</p>
              </div>
            )}
            <div class="posts">
              {detail.posts.map((p) => (
                <article key={p.id} class={`post ${p.kind}`}>
                  <div class="post-head">
                    <span class={`kind-badge ${p.kind}`}>{kindLabel(p.kind)}</span>
                    <strong>{authorName(p.author)}</strong>
                    <span class="dim">{new Date(p.createdAt).toLocaleString()}</span>
                  </div>
                  <div
                    class="md"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(withNames(p.body)) }}
                  />
                </article>
              ))}
            </div>
            <Composer
              withTitle={false}
              onSend={(p) =>
                getApi().boardPost({ threadId: detail.thread.id, kind: p.kind, body: p.body })
              }
            />
          </>
        ) : (
          <div class="empty logo-empty">{t("board")}</div>
        )}
      </section>
    </div>
  );
}
