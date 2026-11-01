import { execFile } from "node:child_process";
import { canonicalTools, type Tool } from "@redgiant/agent";
import type { Event, ModelSpec } from "@redgiant/protocol";
import { globTool, grepTool, LocalWorkspace, readFileTool } from "@redgiant/tools";
import { z } from "zod";
import type { ChatProfile } from "./chat.js";
import type { RedGiantCore } from "./core.js";

/**
 * The project inspector (RD30): it reads everything about one project — files, git, the
 * activity log, tasks, the board, the budget — and changes nothing. It is outside the chain of
 * command, answers the user and God, and keeps an ordinary chat history (not the event log).
 */
export interface InspectorSettings {
  model?: ModelSpec;
  /** Tell the owner when something goes wrong in the project (Telegram). */
  alerts?: boolean;
  /** Send a summary of the day at this hour (0–23, server time); absent: none. */
  summaryHour?: number;
}

const PROMPT = (project: string, path: string) =>
  `You are the inspector of the project "${project}". You can only read: its files (in ${path}), its git history, ` +
  "its activity log, its tasks, its board and its budget. Answer questions about the state of the project precisely and " +
  "briefly, in the user's language, citing files, commits, tasks or events. Say so when you do not know. You never change anything.";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve(err ? `git: ${(stderr || err.message).trim()}` : stdout.trim() || "(nothing)"),
    );
  });
}

/** One line per event, for people and models. */
export function describeEvent(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const short = (v: unknown, n = 160) => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const what =
    e.type === "message.user"
      ? short(p.text)
      : e.type === "message.assistant"
        ? short(
            ((p.parts as { type: string; text?: string }[] | undefined) ?? [])
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join(""),
          )
        : e.type === "tool.call"
          ? `${p.tool} ${short(p.input, 120)}`
          : e.type === "tool.result"
            ? `${p.ok ? "ok" : "failed"}: ${short(p.output, 120)}`
            : short(p, 200);
  return `#${e.seq} ${e.ts.slice(0, 16)} ${e.agentId ?? "-"} ${e.type}${e.erased ? " (erased)" : ""}: ${what}`;
}

export class InspectorError extends Error {}

export class Inspector {
  private readonly listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly summarised = new Map<string, string>();

  constructor(private readonly core: RedGiantCore) {}

  async settings(ownerId: string, projectId: string): Promise<InspectorSettings> {
    const [r] = await this.core.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = $2",
      [ownerId, `inspector:${projectId}`],
    );
    return r
      ? ((typeof r.value === "string" ? JSON.parse(r.value) : r.value) as InspectorSettings)
      : {};
  }

  async setSettings(ownerId: string, projectId: string, s: InspectorSettings): Promise<void> {
    await this.project(ownerId, projectId);
    await this.core.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, `inspector:${projectId}`, JSON.stringify(s)],
    );
  }

  private async project(ownerId: string, projectId: string) {
    const p = await this.core.projects.get(ownerId, projectId);
    if (!p) throw new InspectorError(`Project "${projectId}" not found`);
    return p;
  }

  /** The inspector's instructions, read-only tools and model, for the chat. */
  async profile(ownerId: string, projectId: string): Promise<ChatProfile> {
    const p = await this.project(ownerId, projectId);
    const settings = await this.settings(ownerId, projectId);
    // Read-only by construction: the workspace refuses writes and there is no shell.
    const ws = new LocalWorkspace(p.path, true);
    const core = this.core;
    const tools: Tool[] = [
      readFileTool(ws, "full") as Tool,
      globTool(ws, "full") as Tool,
      grepTool(ws, "full") as Tool,
      {
        def: {
          name: "git_log",
          description: "The project's git history (newest first), optionally for one path.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, limit: { type: "integer" } },
          },
        },
        schema: z.object({
          path: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
        run: ({ path, limit }: { path?: string; limit?: number }) =>
          git(p.path, [
            "log",
            "--all",
            `-n${limit ?? 30}`,
            "--date=iso",
            "--format=%h %ad %an [%D] %s",
            ...(path ? ["--", path] : []),
          ]),
      } as Tool,
      {
        def: {
          name: "git_show",
          description: "One commit: message, files and diff (git show, read-only).",
          inputSchema: {
            type: "object",
            properties: { commit: { type: "string" } },
            required: ["commit"],
          },
        },
        schema: z.object({ commit: z.string().regex(/^[\w./-]+$/) }),
        run: async ({ commit }: { commit: string }) => {
          const out = await git(p.path, ["show", "--stat", "--patch", "--no-color", commit]);
          return out.length > 30_000 ? `${out.slice(0, 30_000)}\n…` : out;
        },
      } as Tool,
      {
        def: {
          name: "git_status",
          description: "Uncommitted changes and the branches of the project and of its agents.",
          inputSchema: { type: "object", properties: {} },
        },
        schema: z.object({}),
        run: async () =>
          `${await git(p.path, ["status", "--short", "--branch"])}\n\n${await git(p.path, ["branch", "-a", "-vv"])}`,
      } as Tool,
      {
        def: {
          name: "project_activity",
          description:
            "The latest events of the project's log (messages, tool calls, tasks, board…), oldest first.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              type: { type: "string", description: "only this event type" },
            },
          },
        },
        schema: z.object({
          limit: z.number().int().min(1).max(300).optional(),
          type: z.string().optional(),
        }),
        run: async ({ limit, type }: { limit?: number; type?: string }) => {
          const all = (await core.store.list({ projectId })).filter(
            (e) => !type || e.type === type,
          );
          const recent = all.slice(-(limit ?? 60));
          return recent.length ? recent.map(describeEvent).join("\n") : "No activity yet.";
        },
      } as Tool,
      {
        def: {
          name: "project_tasks",
          description: "Tasks handed out in the project, with their verification and outcome.",
          inputSchema: { type: "object", properties: {} },
        },
        schema: z.object({}),
        run: async () => {
          const events = (await core.store.list({ projectId })).filter((e) =>
            e.type.startsWith("task."),
          );
          const tasks = new Map<string, string[]>();
          for (const e of events) {
            const pl = e.payload as { taskId: string; title?: string } & Record<string, unknown>;
            const line = tasks.get(pl.taskId) ?? [];
            line.push(
              e.type === "task.opened"
                ? `opened "${pl.title}" (${e.agentId}, ${e.ts.slice(0, 16)})`
                : e.type === "task.verified"
                  ? `verifier ${pl.passed ? "passed" : "failed"}: ${pl.verifier}`
                  : `closed: ${pl.outcome}${pl.justification ? ` (${pl.justification})` : ""}${pl.reason ? ` (${pl.reason})` : ""}`,
            );
            tasks.set(pl.taskId, line);
          }
          return tasks.size
            ? [...tasks].map(([id, l]) => `${id}: ${l.join("; ")}`).join("\n")
            : "No tasks yet.";
        },
      } as Tool,
      {
        def: {
          name: "project_board",
          description:
            "The project's board: threads with status, or one thread's posts, or a search.",
          inputSchema: {
            type: "object",
            properties: { thread_id: { type: "string" }, search: { type: "string" } },
          },
        },
        schema: z.object({ thread_id: z.string().optional(), search: z.string().optional() }),
        run: async ({ thread_id, search }: { thread_id?: string; search?: string }) => {
          if (search) {
            const hits = await core.board.search(ownerId, search, [projectId]);
            return hits.length
              ? hits
                  .map(
                    (h) =>
                      `${h.threadId} "${h.title}" ${h.author} ${h.kind}: ${h.body.slice(0, 300)}`,
                  )
                  .join("\n")
              : "No results.";
          }
          if (thread_id) {
            const posts = await core.board.posts(ownerId, thread_id);
            return posts
              .map((x) => `${x.createdAt.slice(0, 16)} ${x.author} ${x.kind}: ${x.body}`)
              .join("\n\n");
          }
          const threads = await core.board.threads(ownerId, projectId);
          return threads.length
            ? threads
                .map(
                  (t) =>
                    `${t.id} [${t.status}] "${t.title}" (${t.posts} posts)${t.summary ? ` — ${t.summary}` : ""}`,
                )
                .join("\n")
            : "The board is empty.";
        },
      } as Tool,
      {
        def: {
          name: "project_budget",
          description: "What the project has spent, and its limit.",
          inputSchema: { type: "object", properties: {} },
        },
        schema: z.object({}),
        run: async () => {
          const [b] = (await core.budget.listFor(ownerId, [projectId], [])).filter(
            (x) => x.scope === "project",
          );
          const used = await core.budget.used({ scope: "project", id: projectId });
          return `Spent $${used.usd.toFixed(4)} and ${used.tokens} tokens; limit: ${b ? JSON.stringify(b.limit) : "none"}.`;
        },
      } as Tool,
    ];
    return {
      system: PROMPT(p.name, p.path),
      tools: canonicalTools(tools),
      ...(settings.model && { model: settings.model }),
    };
  }

  /** God's question (or an automatic summary): answered in the project's "God" chat. */
  async ask(ownerId: string, projectId: string, question: string, title = "God"): Promise<string> {
    await this.project(ownerId, projectId);
    const scope = { kind: "inspector" as const, projectId };
    const chats = await this.core.chat.list(ownerId, scope);
    const chat =
      chats.find((c) => c.title === title) ?? (await this.core.chat.create(ownerId, title, scope));
    await this.core.chat.send(ownerId, chat.id, question, [], () => {});
    const last = (await this.core.chat.entries(ownerId, chat.id)).at(-1)?.message;
    return last?.role === "assistant"
      ? last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
      : "The inspector did not answer.";
  }

  /**
   * Alerts and daily summaries, for the projects where the owner switched them on. Alerts:
   * an abandoned task, an exceeded budget, a blocker on the board, a failed automation.
   */
  start(): void {
    this.listeners.push(
      this.core.store.subscribe((e: Event) => {
        if (!e.projectId) return;
        const text = alertFor(e);
        if (!text) return;
        void this.settings(e.ownerId, e.projectId)
          .then((s) =>
            s.alerts ? this.core.notify?.(e.ownerId, `⚠️ ${e.projectId}: ${text}`) : undefined,
          )
          .catch(() => {});
      }),
    );
    this.timer = setInterval(() => void this.summaries().catch(() => {}), 60_000);
    this.timer.unref?.();
  }

  /** Sends the summaries due at this hour (called every minute). */
  async summaries(now = new Date()): Promise<void> {
    const rows = await this.core.db.query<{ owner_id: string; key: string; value: unknown }>(
      "SELECT owner_id, key, value FROM rg_settings WHERE key LIKE 'inspector:%'",
    );
    for (const r of rows) {
      const s = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as InspectorSettings;
      if (s.summaryHour !== now.getHours()) continue;
      const projectId = r.key.slice("inspector:".length);
      const day = now.toISOString().slice(0, 10);
      const key = `${r.owner_id}/${projectId}`;
      if (this.summarised.get(key) === day) continue;
      this.summarised.set(key, day);
      const text = await this.ask(
        r.owner_id,
        projectId,
        "Summarise today's activity in this project in a few lines: what was done and verified, what is open or blocked, the spending. Plain text for a phone.",
        `Summary ${day}`,
      );
      await this.core.notify?.(r.owner_id, `📋 ${projectId}\n\n${text}`);
    }
  }

  stop(): void {
    for (const off of this.listeners) off();
    clearInterval(this.timer);
  }
}

function alertFor(e: Event): string | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === "task.closed" && p.outcome === "abandoned")
    return `task ${p.taskId} abandoned: ${p.reason ?? "no reason"}`;
  if (e.type === "budget.exceeded") return `budget exceeded (${p.scope}: ${p.used} of ${p.limit})`;
  if (e.type === "board.post" && p.kind === "blocker")
    return `blocker on the board: ${String(p.body).slice(0, 200)}`;
  if (e.type === "automation.run" && (p.status === "failed" || p.status === "timeout"))
    return `automation ${p.name} ${p.status}`;
  return undefined;
}
