import type { Tool } from "@redgiant/agent";
import type { AgentRecord } from "@redgiant/hierarchy";
import { z } from "zod";
import { type Board, POST_KINDS, type Post, type ThreadStatus } from "./board.js";

const fmtPost = (p: Post) =>
  `[${p.kind}] ${p.author} · ${p.createdAt.slice(0, 16).replace("T", " ")}\n${p.body}`;

/**
 * The board, for agents. Everyone reads and writes their project's board; God reads and
 * writes every board (and the global one); the Inspector only reads; Demi-God has none.
 */
export function boardTools(self: AgentRecord, board: Board): Tool[] {
  if (self.kind === "demigod") return [];
  const isGod = self.kind === "god";
  const canWrite = self.kind !== "inspector";
  const canSetStatus = isGod || self.kind === "orchestrator";
  /** The board a call is about: own project (or global for God), or another one for God. */
  const boardOf = (projectId?: string): string | null => {
    if (projectId !== undefined && projectId !== (self.projectId ?? "")) {
      if (!isGod) throw new Error("You can only use your own project's board.");
      return projectId === "" ? null : projectId;
    }
    return self.projectId;
  };
  const checkThread = async (id: string) => {
    const t = await board.thread(self.ownerId, id);
    if (!t || (!isGod && t.projectId !== self.projectId))
      throw new Error(`No thread "${id}" on your board.`);
    return t;
  };
  const projectParam = isGod
    ? { project_id: { type: "string", description: 'A project id; "" for the global board' } }
    : {};

  const tools: Tool[] = [
    {
      def: {
        name: "board_list",
        description:
          "List the threads of your board (newest activity first), with status and number of posts.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "resolved", "blocked"] },
            ...projectParam,
          },
        },
      },
      schema: z.object({
        status: z.enum(["open", "resolved", "blocked"]).optional(),
        project_id: z.string().optional(),
      }),
      async run({ status, project_id }: { status?: ThreadStatus; project_id?: string }) {
        const threads = await board.threads(self.ownerId, boardOf(project_id), status);
        if (threads.length === 0) return "The board is empty.";
        return threads
          .map(
            (t) =>
              `${t.id} [${t.status}] ${t.title} — ${t.posts} posts, by ${t.createdBy}, ${t.updatedAt.slice(0, 16)}`,
          )
          .join("\n");
      },
    } as Tool,
    {
      def: {
        name: "board_read",
        description: "Read a thread: its summary (if any) and the latest posts.",
        inputSchema: {
          type: "object",
          properties: { thread_id: { type: "string" } },
          required: ["thread_id"],
        },
      },
      schema: z.object({ thread_id: z.string() }),
      async run({ thread_id }: { thread_id: string }) {
        const t = await checkThread(thread_id);
        const posts = await board.posts(self.ownerId, thread_id);
        return [
          `# ${t.title} [${t.status}]`,
          t.summary ? `Summary: ${t.summary}` : "",
          ...posts.slice(-30).map(fmtPost),
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    } as Tool,
    {
      def: {
        name: "board_search",
        description: "Full-text search of the posts on the boards you can see.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      schema: z.object({ query: z.string().min(1) }),
      async run({ query }: { query: string }) {
        const hits = await board.search(self.ownerId, query, isGod ? "all" : [self.projectId]);
        if (hits.length === 0) return "No posts match.";
        return hits
          .slice(0, 15)
          .map((h) => `${h.threadId} «${h.title}» ${fmtPost(h)}`)
          .join("\n\n");
      },
    } as Tool,
  ];

  if (canWrite) {
    tools.push({
      def: {
        name: "board_post",
        description:
          "Post on the board: reply to a thread (thread_id) or open one (title). Kinds: task, result, question, decision, blocker, note. " +
          "Mention agents as @<agent id>. Link a task with task_id. A new thread similar to an open one is refused unless force is true.",
        inputSchema: {
          type: "object",
          properties: {
            thread_id: { type: "string" },
            title: { type: "string" },
            kind: { type: "string", enum: [...POST_KINDS] },
            body: { type: "string" },
            task_id: { type: "string" },
            force: { type: "boolean" },
            ...projectParam,
          },
          required: ["kind", "body"],
        },
      },
      schema: z.object({
        thread_id: z.string().optional(),
        title: z.string().min(3).optional(),
        kind: z.enum(POST_KINDS),
        body: z.string().min(1),
        task_id: z.string().optional(),
        force: z.boolean().optional(),
        project_id: z.string().optional(),
      }),
      async run(i: {
        thread_id?: string;
        title?: string;
        kind: Post["kind"];
        body: string;
        task_id?: string;
        force?: boolean;
        project_id?: string;
      }) {
        const post = {
          author: self.id,
          kind: i.kind,
          body: i.body,
          ...(i.task_id && { refs: { taskId: i.task_id } }),
        };
        if (i.thread_id) {
          await checkThread(i.thread_id);
          const p = await board.reply(self.ownerId, i.thread_id, post);
          return `Posted ${p.id} in ${i.thread_id}.`;
        }
        if (!i.title)
          return { content: "Give thread_id to reply, or title to open a thread.", isError: true };
        const projectId = boardOf(i.project_id);
        if (!i.force) {
          const similar = await board.similar(self.ownerId, projectId, `${i.title} ${i.body}`);
          if (similar.length > 0) {
            return `Possible duplicates — post there with thread_id, or repeat with force: true:\n${similar.map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n")}`;
          }
        }
        const { thread } = await board.createThread({
          ownerId: self.ownerId,
          projectId,
          title: i.title,
          first: post,
        });
        return `Opened ${thread.id}.`;
      },
    } as Tool);
  }

  if (canSetStatus) {
    tools.push({
      def: {
        name: "board_status",
        description: "Mark a thread open, resolved or blocked.",
        inputSchema: {
          type: "object",
          properties: {
            thread_id: { type: "string" },
            status: { type: "string", enum: ["open", "resolved", "blocked"] },
          },
          required: ["thread_id", "status"],
        },
      },
      schema: z.object({ thread_id: z.string(), status: z.enum(["open", "resolved", "blocked"]) }),
      async run({ thread_id, status }: { thread_id: string; status: ThreadStatus }) {
        await checkThread(thread_id);
        await board.setStatus(self.ownerId, thread_id, status, self.id);
        return `${thread_id} is now ${status}.`;
      },
    } as Tool);
  }
  return tools;
}
