import { randomUUID } from "node:crypto";
import { canonicalTools, type Tool } from "@redgiant/agent";
import type { SqlClient } from "@redgiant/events";
import type { PersistentBudget } from "@redgiant/hierarchy";
import type { ChatMessage, ImagePart, MessageMetrics, ModelSpec } from "@redgiant/protocol";
import { costUsd, type ProviderRegistry, streamWithFallback } from "@redgiant/providers";
import { fetchTool, type WebSearchProvider, webSearchTool } from "@redgiant/tools";

/**
 * The daily chat (RD26): a plain assistant with web search, outside the hierarchy and outside
 * the event log. Its history is ordinary rows the user can delete.
 */
export async function migrateChat(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_chats (
      id         text PRIMARY KEY,
      owner_id   text NOT NULL,
      title      text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // The project inspector (G18) uses the same history: its chats belong to a project.
  await db.query(
    "ALTER TABLE rg_chats ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'daily'",
  );
  await db.query("ALTER TABLE rg_chats ADD COLUMN IF NOT EXISTS project_id text");
  await db.query("ALTER TABLE rg_chats ADD COLUMN IF NOT EXISTS folder text");
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_chat_messages (
      id         bigserial PRIMARY KEY,
      chat_id    text NOT NULL REFERENCES rg_chats(id) ON DELETE CASCADE,
      message    jsonb NOT NULL,
      shown      text,
      metrics    jsonb,
      cost_usd   double precision,
      model      text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export const DEFAULT_CHAT_PROMPT =
  "You are the user's everyday assistant. Answer clearly and briefly, in the user's language. " +
  "Search the web when the answer depends on recent or specific facts, and read the pages you rely on. " +
  "When you use web sources, cite them inline as [1], [2]… and end with a short list of those sources (title and URL).";

/**
 * The Chat as an agent (2026-11-03): the everyday assistant with every tool. Its instructions
 * when the person wrote none ({god}: God's name, filled in when a conversation starts).
 */
export const CHAT_AGENT_PROMPT = `${DEFAULT_CHAT_PROMPT} You have a folder of your own and every tool: files and commands, the canvas (show_file opens any file in a viewer, show a site) to show what you make, boards (publish_board) to propose variants to choose from, send_file, pictures, videos and sounds, web search and pages. Use them instead of describing what you would do. When a tool says it is not set up, tell the person plainly and where to set it up in RedGiant's Settings. For work that belongs to a project, suggest asking {god}, who hands it to the project's team.`;

export interface ChatSettings {
  model?: ModelSpec;
  systemPrompt?: string;
}

/** Which assistant a chat talks to: the daily one, or a project's inspector. */
export type ChatScope = { kind: "daily" } | { kind: "inspector"; projectId: string };

/** What a kind of chat answers with (the daily chat's own settings apply when absent). */
export interface ChatProfile {
  system: string;
  tools: Tool[];
  model?: ModelSpec | undefined;
}

export interface ChatSummary {
  id: string;
  kind: "daily" | "inspector";
  projectId: string | null;
  title: string;
  /** Its folder, if the person put it in one. */
  folder: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One stored message, as the UI shows it. */
export interface ChatEntry {
  id: number;
  message: ChatMessage;
  /** For user messages: what the user typed (without the date line and attachments). */
  shown: string | null;
  metrics: MessageMetrics | null;
  costUsd: number | null;
  model: string | null;
  createdAt: string;
}

export type ChatEvent =
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "entry"; entry: ChatEntry };

export class ChatError extends Error {}

const MAX_ATTACHMENT = 200_000;
const MAX_STEPS = 10;
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

/** Streams the deltas to the listener and returns the finished completion. */
async function relay(
  onEvent: (e: ChatEvent) => void,
  events: ReturnType<typeof streamWithFallback>,
) {
  for await (const e of events) {
    if (e.type === "text_delta" || e.type === "thinking_delta")
      onEvent({ type: "delta", kind: e.type === "text_delta" ? "text" : "thinking", text: e.text });
    if (e.type === "done") return e.completion;
  }
  throw new ChatError("The model's answer ended early");
}

export class DailyChat {
  constructor(
    private readonly o: {
      db: SqlClient;
      providers: ProviderRegistry;
      budget: PersistentBudget;
      /** Read at each message: the setup wizard can change them while the server runs. */
      search: () => WebSearchProvider | undefined;
      defaultModel: () => ModelSpec | undefined;
      /** The names in the person's instructions put back ({god}, {demigod}: `prompts.ts`). */
      expand?: (ownerId: string, text: string) => string;
      /** Instructions, tools and model of the other kinds of chat (the project inspector). */
      profile?: (ownerId: string, scope: ChatScope) => Promise<ChatProfile>;
      /** The line with the agents' language (G33.5), added to every chat's instructions. */
      language?: (ownerId: string) => string;
    },
  ) {}

  async settings(ownerId: string): Promise<ChatSettings> {
    const [r] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = 'chat'",
      [ownerId],
    );
    return r ? parse<ChatSettings>(r.value) : {};
  }

  async setSettings(ownerId: string, s: ChatSettings): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, 'chat', $2)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, JSON.stringify(s)],
    );
  }

  async list(ownerId: string, scope: ChatScope = { kind: "daily" }): Promise<ChatSummary[]> {
    const rows = await this.o.db.query<{
      id: string;
      kind: "daily" | "inspector";
      project_id: string | null;
      title: string;
      folder: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      "SELECT * FROM rg_chats WHERE owner_id = $1 AND kind = $2 AND project_id IS NOT DISTINCT FROM $3 ORDER BY updated_at DESC",
      [ownerId, scope.kind, scope.kind === "inspector" ? scope.projectId : null],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      projectId: r.project_id,
      title: r.title,
      folder: r.folder ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async create(
    ownerId: string,
    title = "New chat",
    scope: ChatScope = { kind: "daily" },
  ): Promise<ChatSummary> {
    const id = `chat_${randomUUID().slice(0, 12)}`;
    await this.o.db.query(
      "INSERT INTO rg_chats (id, owner_id, title, kind, project_id) VALUES ($1, $2, $3, $4, $5)",
      [id, ownerId, title, scope.kind, scope.kind === "inspector" ? scope.projectId : null],
    );
    return (await this.list(ownerId, scope)).find((c) => c.id === id) as ChatSummary;
  }

  private async own(ownerId: string, chatId: string) {
    const [r] = await this.o.db.query<{
      title: string;
      kind: "daily" | "inspector";
      project_id: string | null;
    }>("SELECT title, kind, project_id FROM rg_chats WHERE id = $1 AND owner_id = $2", [
      chatId,
      ownerId,
    ]);
    if (!r) throw new ChatError(`Chat "${chatId}" not found`);
    return r;
  }

  async entries(ownerId: string, chatId: string): Promise<ChatEntry[]> {
    await this.own(ownerId, chatId);
    const rows = await this.o.db.query<{
      id: string | number;
      message: unknown;
      shown: string | null;
      metrics: unknown;
      cost_usd: number | null;
      model: string | null;
      created_at: Date;
    }>("SELECT * FROM rg_chat_messages WHERE chat_id = $1 ORDER BY id", [chatId]);
    return rows.map((r) => ({
      id: Number(r.id),
      message: parse<ChatMessage>(r.message),
      shown: r.shown,
      metrics: r.metrics ? parse<MessageMetrics>(r.metrics) : null,
      costUsd: r.cost_usd,
      model: r.model,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async rename(ownerId: string, chatId: string, title: string): Promise<void> {
    await this.own(ownerId, chatId);
    await this.o.db.query("UPDATE rg_chats SET title = $2 WHERE id = $1", [chatId, title]);
  }

  /** Puts a chat in a folder; null takes it out. */
  async setFolder(ownerId: string, chatId: string, folder: string | null): Promise<void> {
    await this.own(ownerId, chatId);
    await this.o.db.query("UPDATE rg_chats SET folder = $2 WHERE id = $1", [chatId, folder]);
  }

  /** Deleted for good: messages included (it is not the event log). */
  async remove(ownerId: string, chatId: string): Promise<void> {
    await this.own(ownerId, chatId);
    await this.o.db.query("DELETE FROM rg_chats WHERE id = $1", [chatId]);
  }

  private async store(
    chatId: string,
    message: ChatMessage,
    extra: { shown?: string; metrics?: MessageMetrics; costUsd?: number; model?: string } = {},
  ): Promise<ChatEntry> {
    const [r] = await this.o.db.query<{ id: string | number; created_at: Date }>(
      `INSERT INTO rg_chat_messages (chat_id, message, shown, metrics, cost_usd, model)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [
        chatId,
        JSON.stringify(message),
        extra.shown ?? null,
        extra.metrics ? JSON.stringify(extra.metrics) : null,
        extra.costUsd ?? null,
        extra.model ?? null,
      ],
    );
    await this.o.db.query("UPDATE rg_chats SET updated_at = now() WHERE id = $1", [chatId]);
    return {
      id: Number(r?.id),
      message,
      shown: extra.shown ?? null,
      metrics: extra.metrics ?? null,
      costUsd: extra.costUsd ?? null,
      model: extra.model ?? null,
      createdAt: new Date(r?.created_at ?? Date.now()).toISOString(),
    };
  }

  private tools(): Tool[] {
    return canonicalTools([webSearchTool(this.o.search(), "full"), fetchTool("full")] as Tool[]);
  }

  /**
   * Sends a message and runs the assistant until it answers (searching and reading pages on
   * the way). Events stream as they happen; everything is stored in the chat's history.
   */
  async send(
    ownerId: string,
    chatId: string,
    text: string,
    attachments: ({ name: string; content: string } | ImagePart)[],
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const chat = await this.own(ownerId, chatId);
    const settings = await this.settings(ownerId);
    const scope: ChatScope =
      chat.kind === "inspector" && chat.project_id
        ? { kind: "inspector", projectId: chat.project_id }
        : { kind: "daily" };
    const profile = scope.kind === "daily" ? undefined : await this.o.profile?.(ownerId, scope);
    const model = profile?.model ?? settings.model ?? this.o.defaultModel();
    if (!model) throw new ChatError("No model for the chat: choose one in its settings");
    const breached = await this.o.budget.check([{ scope: "global", id: ownerId }]);
    if (breached.length > 0) throw new ChatError("The global budget is exhausted");
    const history = (await this.entries(ownerId, chatId)).map((e) => e.message);
    if (history.length === 0 && chat.title === "New chat")
      await this.rename(ownerId, chatId, text.trim().split("\n")[0]?.slice(0, 60) || "Chat");

    // The date goes in the message, not in the system prompt, which stays cacheable.
    const images = attachments.filter((a): a is ImagePart => "type" in a && a.type === "image");
    const files = attachments
      .flatMap((a) => ("content" in a ? [a] : []))
      .map(
        (a) =>
          `\n\n<attachment name="${a.name}">\n${a.content.slice(0, MAX_ATTACHMENT)}\n</attachment>`,
      )
      .join("");
    const user: ChatMessage = {
      role: "user",
      parts: [
        { type: "text", text: `Date: ${new Date().toISOString().slice(0, 10)}\n\n${text}${files}` },
        ...images,
      ],
    };
    onEvent({ type: "entry", entry: await this.store(chatId, user, { shown: text }) });
    history.push(user);

    const tools = profile?.tools ?? this.tools();
    const own =
      settings.systemPrompt &&
      (this.o.expand?.(ownerId, settings.systemPrompt) ?? settings.systemPrompt);
    const system = [profile?.system ?? own ?? DEFAULT_CHAT_PROMPT, this.o.language?.(ownerId)]
      .filter(Boolean)
      .join("\n\n");
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await relay(
        onEvent,
        streamWithFallback(
          this.o.providers,
          model,
          {
            system,
            tools: tools.map((t) => t.def),
            messages: history,
            maxTokens: 8000,
            cacheKey: `chat-${chatId}`,
          },
          signal,
        ),
      );
      const usd = costUsd(
        completion.usage,
        this.o.providers.get(completion.provider).modelInfo(completion.model).pricing,
      );
      await this.o.budget.record([{ scope: "global", id: ownerId }], completion.usage, usd, {
        ownerId,
        projectId: null,
        agentId: null,
      });
      const assistant: ChatMessage = {
        role: "assistant",
        parts: completion.message.parts,
        ...(completion.message.native && { native: completion.message.native }),
      };
      history.push(assistant);
      onEvent({
        type: "entry",
        entry: await this.store(chatId, assistant, {
          metrics: completion.metrics,
          costUsd: usd,
          model: `${completion.provider}/${completion.model}`,
        }),
      });
      const calls = completion.message.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      if (calls.length === 0 || completion.stopReason !== "tool_use") return;
      const results = await Promise.all(
        calls.map(async (c) => {
          onEvent({ type: "tool", name: c.name, input: c.input });
          const tool = tools.find((t) => t.def.name === c.name);
          try {
            if (!tool) throw new Error(`Unknown tool "${c.name}"`);
            const input = tool.schema ? tool.schema.parse(c.input) : c.input;
            const out = await tool.run(input, {
              ownerId,
              projectId: chat.project_id,
              agentId: null,
              sessionId: chatId,
              signal,
            });
            return typeof out === "string"
              ? { type: "tool_result" as const, callId: c.callId, content: out }
              : {
                  type: "tool_result" as const,
                  callId: c.callId,
                  content: out.content,
                  ...(out.isError && { isError: true }),
                };
          } catch (err) {
            return {
              type: "tool_result" as const,
              callId: c.callId,
              content: `Error: ${(err as Error).message}`,
              isError: true,
            };
          }
        }),
      );
      const toolMessage: ChatMessage = { role: "user", parts: results };
      history.push(toolMessage);
      onEvent({ type: "entry", entry: await this.store(chatId, toolMessage) });
    }
  }
}
