import { randomUUID } from "node:crypto";
import type { EventStore, SqlClient } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";

export const POST_KINDS = ["task", "result", "question", "decision", "blocker", "note"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export type ThreadStatus = "open" | "resolved" | "blocked";

export interface Thread {
  id: string;
  ownerId: string;
  /** `null` = the global board (God's). */
  projectId: string | null;
  /** The subproject it belongs to (G24.14c); `null` = the whole project. */
  subprojectId: string | null;
  title: string;
  status: ThreadStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  posts: number;
  summary: string | null;
  /** Number of posts the summary covers. */
  summaryUpTo: number;
  taskIds: string[];
}

export interface Post {
  id: string;
  threadId: string;
  author: string;
  kind: PostKind;
  body: string;
  mentions: string[];
  refs: { taskId?: string; events?: number[]; files?: string[] };
  createdAt: string;
}

export async function migrateBoard(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_threads (
      id           text PRIMARY KEY,
      owner_id     text NOT NULL,
      project_id   text,
      title        text NOT NULL,
      status       text NOT NULL DEFAULT 'open',
      created_by   text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      summary      text,
      summary_upto integer NOT NULL DEFAULT 0,
      task_ids     text[] NOT NULL DEFAULT '{}'
    )`);
  // A subproject's own threads (G24.14c).
  await db.query("ALTER TABLE rg_threads ADD COLUMN IF NOT EXISTS subproject_id text");
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_posts (
      id         text PRIMARY KEY,
      thread_id  text NOT NULL REFERENCES rg_threads(id),
      owner_id   text NOT NULL,
      project_id text,
      author     text NOT NULL,
      kind       text NOT NULL,
      body       text NOT NULL,
      mentions   text[] NOT NULL DEFAULT '{}',
      refs       jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      search     tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
    )`);
  await db.query("CREATE INDEX IF NOT EXISTS rg_posts_search ON rg_posts USING gin (search)");
  await db.query("CREATE INDEX IF NOT EXISTS rg_posts_thread ON rg_posts (thread_id, created_at)");
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_threads_scope ON rg_threads (owner_id, project_id, updated_at)",
  );
}

interface ThreadRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  subproject_id?: string | null;
  title: string;
  status: ThreadStatus;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  summary: string | null;
  summary_upto: number;
  task_ids: string[];
  posts?: string | number;
}

interface PostRow {
  id: string;
  thread_id: string;
  author: string;
  kind: PostKind;
  body: string;
  mentions: string[];
  refs: Post["refs"] | string;
  created_at: Date | string;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const threadOf = (r: ThreadRow): Thread => ({
  id: r.id,
  ownerId: r.owner_id,
  projectId: r.project_id,
  subprojectId: r.subproject_id ?? null,
  title: r.title,
  status: r.status,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  posts: Number(r.posts ?? 0),
  summary: r.summary,
  summaryUpTo: r.summary_upto,
  taskIds: r.task_ids ?? [],
});
const postOf = (r: PostRow): Post => ({
  id: r.id,
  threadId: r.thread_id,
  author: r.author,
  kind: r.kind,
  body: r.body,
  mentions: r.mentions ?? [],
  refs: typeof r.refs === "string" ? (JSON.parse(r.refs) as Post["refs"]) : r.refs,
  createdAt: iso(r.created_at),
});

/** `@agent_1234abcd` style mentions (agent ids) found in a body. */
export const mentionsIn = (body: string) => [
  ...new Set([...body.matchAll(/@([a-z]+_[0-9a-f]{8})\b/g)].map((m) => m[1] as string)),
];

export interface NewPost {
  author: string;
  kind: PostKind;
  body: string;
  refs?: Post["refs"];
}

/**
 * The agents' forum (RD10). Threads live on a project's board or on the global one; every
 * post is also an event in the log. Status follows the tasks a thread refers to.
 */
export class Board {
  private readonly listeners = new Set<
    (ownerId: string, projectId: string | null, threadId: string) => void
  >();

  constructor(
    private readonly db: SqlClient,
    private readonly store: EventStore,
  ) {}

  /** Called after every change (live clients reload). */
  onChange(l: (ownerId: string, projectId: string | null, threadId: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(t: { ownerId: string; projectId: string | null; id: string }) {
    for (const l of this.listeners) l(t.ownerId, t.projectId, t.id);
  }

  /** A project's board goes into another's, as one of its subprojects (G24.14c). */
  async moveProject(
    ownerId: string,
    from: string,
    to: string,
    subprojectId: string,
  ): Promise<void> {
    await this.db.query(
      "UPDATE rg_threads SET project_id = $2, subproject_id = $3 WHERE owner_id = $1 AND project_id = $4",
      [ownerId, to, subprojectId, from],
    );
    await this.db.query(
      "UPDATE rg_posts SET project_id = $2 WHERE owner_id = $1 AND project_id = $3",
      [ownerId, to, from],
    );
  }

  async createThread(o: {
    ownerId: string;
    projectId: string | null;
    subprojectId?: string | null;
    title: string;
    first: NewPost;
  }): Promise<{ thread: Thread; post: Post }> {
    const id = `thr_${randomUUID().slice(0, 8)}`;
    await this.db.query(
      "INSERT INTO rg_threads (id, owner_id, project_id, subproject_id, title, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, o.ownerId, o.projectId, o.subprojectId ?? null, o.title, o.first.author],
    );
    const post = await this.reply(o.ownerId, id, o.first);
    return { thread: (await this.thread(o.ownerId, id)) as Thread, post };
  }

  async reply(ownerId: string, threadId: string, p: NewPost): Promise<Post> {
    const [t] = await this.db.query<ThreadRow>(
      "SELECT * FROM rg_threads WHERE id = $1 AND owner_id = $2",
      [threadId, ownerId],
    );
    if (!t) throw new Error(`No thread "${threadId}"`);
    const id = `pst_${randomUUID().slice(0, 8)}`;
    const mentions = mentionsIn(p.body);
    const refs = p.refs ?? {};
    await this.db.query(
      "INSERT INTO rg_posts (id, thread_id, owner_id, project_id, author, kind, body, mentions, refs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        id,
        threadId,
        ownerId,
        t.project_id,
        p.author,
        p.kind,
        p.body,
        mentions,
        JSON.stringify(refs),
      ],
    );
    await this.db.query(
      `UPDATE rg_threads SET updated_at = now()${refs.taskId ? ", task_ids = array_append(task_ids, $3)" : ""}${p.kind === "blocker" ? ", status = 'blocked'" : ""} WHERE id = $1 AND owner_id = $2`,
      refs.taskId ? [threadId, ownerId, refs.taskId] : [threadId, ownerId],
    );
    await this.store.append({
      ownerId,
      projectId: t.project_id,
      agentId: p.author === "human" ? null : p.author,
      body: {
        type: "board.post",
        payload: {
          threadId,
          postId: id,
          kind: p.kind,
          author: p.author,
          body: p.body.slice(0, 2000),
        },
      },
    });
    this.changed({ ownerId, projectId: t.project_id, id: threadId });
    const [row] = await this.db.query<PostRow>("SELECT * FROM rg_posts WHERE id = $1", [id]);
    return postOf(row as PostRow);
  }

  async thread(ownerId: string, id: string): Promise<Thread | undefined> {
    const [r] = await this.db.query<ThreadRow>(
      "SELECT t.*, (SELECT count(*) FROM rg_posts p WHERE p.thread_id = t.id) AS posts FROM rg_threads t WHERE t.id = $1 AND t.owner_id = $2",
      [id, ownerId],
    );
    return r ? threadOf(r) : undefined;
  }

  async posts(ownerId: string, threadId: string): Promise<Post[]> {
    return (
      await this.db.query<PostRow>(
        "SELECT * FROM rg_posts WHERE thread_id = $1 AND owner_id = $2 ORDER BY created_at, id",
        [threadId, ownerId],
      )
    ).map(postOf);
  }

  /** Threads of one board (`projectId` null = global), newest activity first. */
  async threads(
    ownerId: string,
    projectId: string | null,
    status?: ThreadStatus,
    /**
     * A subproject's view (G24.14c): its own threads and the whole project's, never its
     * siblings'. Absent: every thread of the project.
     */
    subprojectId?: string,
  ): Promise<Thread[]> {
    const params: unknown[] = [ownerId];
    let where = "t.owner_id = $1";
    where +=
      projectId === null
        ? " AND t.project_id IS NULL"
        : ` AND t.project_id = $${params.push(projectId)}`;
    if (status) where += ` AND t.status = $${params.push(status)}`;
    if (subprojectId !== undefined)
      where += ` AND (t.subproject_id IS NULL OR t.subproject_id = $${params.push(subprojectId)})`;
    const rows = await this.db.query<ThreadRow>(
      `SELECT t.*, (SELECT count(*) FROM rg_posts p WHERE p.thread_id = t.id) AS posts FROM rg_threads t WHERE ${where} ORDER BY t.updated_at DESC LIMIT 200`,
      params,
    );
    return rows.map(threadOf);
  }

  /** Full-text search over posts; `projectIds` limits it to the boards the reader may see. */
  async search(
    ownerId: string,
    query: string,
    projectIds: (string | null)[] | "all",
  ): Promise<(Post & { title: string; projectId: string | null })[]> {
    const rows = await this.db.query<PostRow & { title: string; project_id: string | null }>(
      `SELECT p.*, t.title, t.project_id FROM rg_posts p JOIN rg_threads t ON t.id = p.thread_id
       WHERE p.owner_id = $1
         AND (p.search @@ websearch_to_tsquery('simple', $2) OR to_tsvector('simple', t.title) @@ websearch_to_tsquery('simple', $2))
       ORDER BY ts_rank(p.search, websearch_to_tsquery('simple', $2)) DESC, p.created_at DESC LIMIT 50`,
      [ownerId, query],
    );
    return rows
      .filter((r) => projectIds === "all" || projectIds.includes(r.project_id))
      .map((r) => ({ ...postOf(r), title: r.title, projectId: r.project_id }));
  }

  /**
   * Open threads on the same board that look like `text` (shared words, ranked): shown to
   * whoever is about to open a new thread, so the conversation stays in one place.
   */
  async similar(ownerId: string, projectId: string | null, text: string): Promise<Thread[]> {
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? [])].slice(0, 12);
    if (words.length === 0) return [];
    const rows = await this.db.query<ThreadRow & { rank: number }>(
      `SELECT t.*, max(ts_rank(p.search, q)) AS rank
       FROM rg_threads t JOIN rg_posts p ON p.thread_id = t.id, to_tsquery('simple', $3) q
       WHERE t.owner_id = $1 AND t.status <> 'resolved' AND t.project_id IS NOT DISTINCT FROM NULLIF($2::text, '')
         AND (p.search @@ q OR to_tsvector('simple', t.title) @@ q)
       GROUP BY t.id ORDER BY rank DESC LIMIT 5`,
      [ownerId, projectId ?? "", words.join(" | ")],
    );
    // Keep threads sharing at least a third of the words.
    const out: Thread[] = [];
    for (const r of rows) {
      const posts = await this.posts(ownerId, r.id);
      const hay = `${r.title} ${posts.map((p) => p.body).join(" ")}`.toLowerCase();
      if (words.filter((w) => hay.includes(w)).length * 3 >= words.length) out.push(threadOf(r));
    }
    return out;
  }

  async setStatus(
    ownerId: string,
    threadId: string,
    status: ThreadStatus,
    by: string,
  ): Promise<void> {
    const [t] = await this.db.query<ThreadRow>(
      "UPDATE rg_threads SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *",
      [threadId, ownerId, status],
    );
    if (!t) throw new Error(`No thread "${threadId}"`);
    await this.store.append({
      ownerId,
      projectId: t.project_id,
      body: { type: "board.status", payload: { threadId, status, by } },
    });
    this.changed({ ownerId, projectId: t.project_id, id: threadId });
  }

  async saveSummary(
    ownerId: string,
    threadId: string,
    summary: string,
    upTo: number,
  ): Promise<void> {
    await this.db.query(
      "UPDATE rg_threads SET summary = $3, summary_upto = $4 WHERE id = $1 AND owner_id = $2",
      [threadId, ownerId, summary, upTo],
    );
  }

  /**
   * Keeps thread status in step with the tasks it mentions: all verified (or not testable)
   * ⇒ resolved; any abandoned ⇒ blocked.
   */
  followTasks(): () => void {
    const closed = new Map<string, string>();
    return this.store.subscribe((e: Event) => {
      if (e.type !== "task.closed" || !e.payload) return;
      closed.set(e.payload.taskId, e.payload.outcome);
      void (async () => {
        const rows = await this.db.query<ThreadRow>(
          "SELECT * FROM rg_threads WHERE owner_id = $1 AND $2 = ANY(task_ids)",
          [e.ownerId, (e.payload as { taskId: string }).taskId],
        );
        // Tasks closed before a restart are not in memory: their outcome comes from the log (S40).
        const missing = rows.flatMap((t) => t.task_ids).filter((id) => !closed.has(id));
        if (missing.length > 0)
          for (const old of await this.store.list({ types: ["task.closed"] })) {
            const p = old.payload as { taskId: string; outcome: string } | null;
            if (p && missing.includes(p.taskId)) closed.set(p.taskId, p.outcome);
          }
        for (const t of rows) {
          const outcomes = t.task_ids.map((id) => closed.get(id));
          const next: ThreadStatus | undefined = outcomes.includes("abandoned")
            ? "blocked"
            : outcomes.every((o) => o === "verified" || o === "not_testable")
              ? "resolved"
              : undefined;
          if (next && next !== t.status) await this.setStatus(e.ownerId, t.id, next, "tasks");
        }
      })();
    });
  }
}
